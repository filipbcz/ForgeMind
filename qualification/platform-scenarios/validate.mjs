import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { qualificationScenarios, requiredScenarioAreas } from './scenarios.mjs';

const forbiddenEvidencePatterns = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer\s+[a-z0-9._-]+/i,
  /client[_-]?secret/i,
  /credential/i,
  /gh[pousr]_[a-z0-9_]+/i,
  /password/i,
  /private\s+key/i,
  /refresh[_-]?token/i,
  /secret/i,
  /ssh[_-]?key/i,
  /token/i
];

const allowedPhrases = new Set([
  'scenario evidence is repeatable and redacted by construction',
  'redaction report'
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function inspectEvidenceText(scenario) {
  return [
    scenario.id,
    scenario.title,
    scenario.objective,
    scenario.activation,
    ...scenario.expectedStates,
    ...scenario.expectedAuditEvents,
    ...scenario.evidenceArtifacts,
    ...scenario.recoveryProcedure
  ].join('\n');
}

function validateScenario(scenario) {
  assert(/^[a-z0-9-]+$/.test(scenario.id), `${scenario.id}: id must be stable kebab-case`);
  assert(requiredScenarioAreas.includes(scenario.area), `${scenario.id}: area is not required by the qualification contract`);
  assert(typeof scenario.title === 'string' && scenario.title.length > 0, `${scenario.id}: title is required`);
  assert(typeof scenario.objective === 'string' && scenario.objective.length > 0, `${scenario.id}: objective is required`);
  assert(typeof scenario.activation === 'string' && scenario.activation.length > 0, `${scenario.id}: activation is required`);
  assert(Array.isArray(scenario.expectedStates) && scenario.expectedStates.length >= 3, `${scenario.id}: expected states are required`);
  assert(Array.isArray(scenario.expectedAuditEvents) && scenario.expectedAuditEvents.length >= 3, `${scenario.id}: expected audit events are required`);
  assert(Array.isArray(scenario.evidenceArtifacts) && scenario.evidenceArtifacts.length >= 2, `${scenario.id}: evidence artifacts are required`);
  assert(Array.isArray(scenario.recoveryProcedure) && scenario.recoveryProcedure.length >= 3, `${scenario.id}: recovery procedure is required`);

  const text = inspectEvidenceText(scenario);
  for (const pattern of forbiddenEvidencePatterns) {
    const matches = text.match(pattern);
    if (matches && !allowedPhrases.has(matches[0].toLowerCase())) {
      throw new Error(`${scenario.id}: possible secret-bearing evidence term "${matches[0]}" is not allowed`);
    }
  }
}

for (const scenario of qualificationScenarios) {
  validateScenario(scenario);
}

const scenarioAreas = new Set(qualificationScenarios.map((scenario) => scenario.area));
for (const area of requiredScenarioAreas) {
  assert(scenarioAreas.has(area), `missing required qualification scenario area: ${area}`);
}

const duplicateIds = qualificationScenarios
  .map((scenario) => scenario.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
assert(duplicateIds.length === 0, `duplicate scenario ids: ${duplicateIds.join(', ')}`);

const evidence = {
  schemaVersion: 1,
  generatedFrom: 'qualification/platform-scenarios/scenarios.mjs',
  note: 'Scenario evidence is repeatable and redacted by construction',
  scenarioCount: qualificationScenarios.length,
  requiredAreas: requiredScenarioAreas,
  scenarios: qualificationScenarios.map((scenario) => ({
    id: scenario.id,
    area: scenario.area,
    expectedStateCount: scenario.expectedStates.length,
    expectedAuditEventCount: scenario.expectedAuditEvents.length,
    evidenceArtifactCount: scenario.evidenceArtifacts.length,
    recoveryStepCount: scenario.recoveryProcedure.length,
    definitionHash: createHash('sha256').update(stableJson(scenario)).digest('hex')
  }))
};

const sampleUrl = new URL('./evidence-sample.json', import.meta.url);
const sampleEvidence = JSON.parse(await readFile(sampleUrl, 'utf8'));
assert(
  stableJson(sampleEvidence) === stableJson(evidence),
  'evidence-sample.json must match deterministic validate.mjs output'
);

const schemaUrl = new URL('./evidence-schema.json', import.meta.url);
const evidenceSchema = JSON.parse(await readFile(schemaUrl, 'utf8'));
const scenarioCountSchema = evidenceSchema.properties?.scenarioCount;
assert(
  scenarioCountSchema?.const === qualificationScenarios.length,
  'evidence-schema.json scenarioCount must equal the scenarios array length'
);
const scenariosSchema = evidenceSchema.properties?.scenarios;
assert(
  scenariosSchema?.minItems === qualificationScenarios.length && scenariosSchema?.maxItems === qualificationScenarios.length,
  'evidence-schema.json scenarios must require the exact scenario count'
);
const requiredAreasSchema = evidenceSchema.properties?.requiredAreas;
const requiredAreaConstants = new Set(
  requiredAreasSchema?.allOf?.map((entry) => entry?.contains?.const)
);
assert(
  requiredAreasSchema?.minItems === requiredScenarioAreas.length &&
    requiredAreasSchema?.maxItems === requiredScenarioAreas.length &&
    requiredAreasSchema?.uniqueItems === true,
  'evidence-schema.json requiredAreas must require the exact number of unique areas'
);
assert(
  requiredScenarioAreas.every((area) => requiredAreaConstants.has(area)) &&
    requiredAreaConstants.size === requiredScenarioAreas.length,
  'evidence-schema.json requiredAreas must contain the exact required area set'
);
const scenarioAreaEnum = new Set(scenariosSchema?.items?.properties?.area?.enum);
assert(
  requiredScenarioAreas.every((area) => scenarioAreaEnum.has(area)) &&
    scenarioAreaEnum.size === requiredScenarioAreas.length,
  'evidence-schema.json scenario area enum must match the required area set'
);

console.log(JSON.stringify(evidence, null, 2));
