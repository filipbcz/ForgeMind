import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "packages/db/prisma/migrations");
const previousSchemaFixture = path.join(repoRoot, "tests/fixtures/supported-previous-schema.sql");
const defaultMigrationDatabaseUrl = "postgresql://forgemind:forgemind@127.0.0.1:5432/forgemind_validation";
const dbUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? defaultMigrationDatabaseUrl;

const destructivePatterns = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i
];

const migrationNamePattern = /^\d{14}_[a-z0-9_]+$/;
const previousMarkerPattern = /^--\s*@forgemind-supported-previous-migration:\s*(\S+)\s*$/m;
const fixtureMigrationPattern = /^\\ir\s+(.+)$/gm;

const fail = (message) => {
  console.error(`[migration-validation] ${message}`);
  process.exit(1);
};

const quoteIdent = (value) => `"${value.replaceAll('"', '""')}"`;

const readMigrations = async () => {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

const assertForwardOnlyOrdering = (migrations) => {
  const seen = new Set();
  let previousTimestamp;

  for (const migration of migrations) {
    if (!migrationNamePattern.test(migration)) {
      fail(`migration directory does not use the timestamp_name format: ${migration}`);
    }

    const timestamp = migration.slice(0, 14);
    if (seen.has(timestamp)) {
      fail(`duplicate migration timestamp detected: ${timestamp}`);
    }
    if (previousTimestamp && timestamp <= previousTimestamp) {
      fail(`migration timestamp is not forward-only: ${migration}`);
    }
    seen.add(timestamp);
    previousTimestamp = timestamp;
  }
};

const assertNoDestructiveMigrations = (migrations) => {
  for (const migration of migrations) {
    const migrationFile = path.join(migrationsDir, migration, "migration.sql");
    if (!existsSync(migrationFile)) {
      fail(`missing migration.sql for ${migration}`);
    }

    const sql = readFileSync(migrationFile, "utf8");
    for (const pattern of destructivePatterns) {
      if (pattern.test(sql)) {
        fail(`destructive SQL is not allowed in forward-only migrations: ${migration}`);
      }
    }
  }
};

const readPreviousFixture = (migrations) => {
  if (!existsSync(previousSchemaFixture)) {
    fail(`missing supported previous schema fixture: ${path.relative(repoRoot, previousSchemaFixture)}`);
  }

  const fixtureSql = readFileSync(previousSchemaFixture, "utf8");
  const markerMatch = fixtureSql.match(previousMarkerPattern);
  if (!markerMatch) {
    fail("previous schema fixture is missing @forgemind-supported-previous-migration");
  }

  const previousMigration = markerMatch[1];
  const previousIndex = migrations.indexOf(previousMigration);
  if (previousIndex === -1) {
    fail(`previous schema fixture points at an unknown migration: ${previousMigration}`);
  }
  if (previousIndex === migrations.length - 1) {
    fail("previous schema fixture must describe a supported schema before the latest migration");
  }

  const referencedMigrations = [...fixtureSql.matchAll(fixtureMigrationPattern)].map((match) => {
    const includedPath = match[1].trim();
    const migrationName = includedPath.split("/").at(-2);
    if (!migrationName) {
      fail(`could not parse migration include from fixture line: ${match[0]}`);
    }
    return migrationName;
  });

  const expected = migrations.slice(0, previousIndex + 1);
  if (referencedMigrations.join("\n") !== expected.join("\n")) {
    fail("previous schema fixture must include every migration up to its marker and no later migrations");
  }

  return { previousMigration, previousIndex };
};

const expandSqlFile = (filePath, schema) => {
  const fileDir = path.dirname(filePath);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const expanded = [];

  for (const line of lines) {
    const includeMatch = line.match(/^\\ir\s+(.+)$/);
    if (includeMatch) {
      const includedFile = path.resolve(fileDir, includeMatch[1].trim());
      expanded.push(expandSqlFile(includedFile, schema));
      continue;
    }

    if (line.startsWith("\\if ")) {
      continue;
    }
    if (line.startsWith("\\endif")) {
      continue;
    }
    if (line.startsWith("\\set ")) {
      continue;
    }

    expanded.push(line.replaceAll(':"schema"', quoteIdent(schema)));
  }

  return expanded.join("\n");
};

const buildMigrationReplaySql = (migrations, schema) => {
  const statements = [
    `SET search_path TO ${quoteIdent(schema)}, public;`
  ];

  for (const migration of migrations) {
    statements.push(expandSqlFile(path.join(migrationsDir, migration, "migration.sql"), schema));
  }

  return statements.join("\n");
};

const loadPostgresClient = async () => {
  try {
    const pg = await import("pg");
    return pg.Client ?? pg.default?.Client;
  } catch (error) {
    fail(`failed to load PostgreSQL client dependency "pg": ${error.message}`);
  }
};

const runPostgresMatrix = async (migrations, previousIndex) => {
  const Client = await loadPostgresClient();
  if (!Client) {
    fail('PostgreSQL client dependency "pg" did not expose Client');
  }

  const client = new Client({ connectionString: dbUrl });
  const cleanSchema = `migration_clean_${process.pid}_${Date.now()}`;
  const previousSchema = `migration_previous_${process.pid}_${Date.now()}`;
  const cleanReplaySql = buildMigrationReplaySql(migrations, cleanSchema);
  const previousFixtureSql = expandSqlFile(previousSchemaFixture, previousSchema);
  const fromPreviousReplaySql = buildMigrationReplaySql(migrations.slice(previousIndex + 1), previousSchema);
  let connected = false;
  let validationError;

  try {
    await client.connect();
    connected = true;
    for (const schema of [cleanSchema, previousSchema]) {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE; CREATE SCHEMA ${quoteIdent(schema)};`);
    }

    await client.query(cleanReplaySql);
    await client.query(previousFixtureSql);
    await client.query(fromPreviousReplaySql);
  } catch (error) {
    validationError = error;
  } finally {
    if (connected) {
      if (validationError) {
        await client.query("ROLLBACK").catch(() => {});
      }
      for (const schema of [cleanSchema, previousSchema]) {
        await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE;`);
      }
      await client.end();
    }
  }

  if (validationError) {
    fail(validationError.message);
  }
};

const main = async () => {
  const migrations = await readMigrations();
  if (migrations.length === 0) {
    fail("no migrations found");
  }

  assertForwardOnlyOrdering(migrations);
  assertNoDestructiveMigrations(migrations);
  const { previousMigration, previousIndex } = readPreviousFixture(migrations);

  await runPostgresMatrix(migrations, previousIndex);
  console.log(`[migration-validation] PostgreSQL matrix passed from empty schema and ${previousMigration}`);
};

await main();
