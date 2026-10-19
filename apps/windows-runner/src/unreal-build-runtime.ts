import { access, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

export interface UnrealBuildRuntime {
  dotnetExecutable: string;
  unrealBuildToolDll: string;
}

/** Resolves the exact UBT and bundled .NET runtime belonging to the editor
 * executable that passed the runner probe. */
export async function resolveUnrealBuildRuntime(editorExecutable: string): Promise<UnrealBuildRuntime> {
  if (!editorExecutable || !/(?:^|[\\/])UnrealEditor(?:-Cmd)?\.exe$/i.test(editorExecutable)) {
    throw new Error('Unreal build requires the runner-probed UnrealEditor executable.');
  }
  const engineRoot = resolve(dirname(editorExecutable), '..', '..');
  const unrealBuildToolDll = resolve(engineRoot, 'Binaries', 'DotNET', 'UnrealBuildTool', 'UnrealBuildTool.dll');
  await access(unrealBuildToolDll);
  const dotnetRoot = resolve(engineRoot, 'Binaries', 'ThirdParty', 'DotNet');
  const versions = (await readdir(dotnetRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = resolve(dotnetRoot, version, 'win-x64', 'dotnet.exe');
    try { await access(candidate); return { dotnetExecutable: candidate, unrealBuildToolDll }; } catch { /* continue */ }
  }
  throw new Error(`The runner-probed Unreal installation has no bundled win-x64 dotnet runtime under ${dotnetRoot}.`);
}

/** Content-only projects can be opened immediately. Native projects must have
 * their Editor target rebuilt after checkpoint recovery because generated DLLs
 * are deliberately not persisted as source results. */
export async function recoveredUnrealEditorTarget(projectPath: string): Promise<string | undefined> {
  let descriptor: unknown;
  try { descriptor = JSON.parse(await readFile(projectPath, 'utf8')); } catch (error) {
    throw new Error(`Could not inspect recovered Unreal project descriptor ${projectPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const modules = descriptor && typeof descriptor === 'object' ? (descriptor as { Modules?: unknown }).Modules : undefined;
  const projectRoot = dirname(projectPath);
  const hasNativeModule = (Array.isArray(modules) && modules.length > 0)
    || await containsBuildRules(resolve(projectRoot, 'Source'))
    || await containsBuildRules(resolve(projectRoot, 'Plugins'));
  if (!hasNativeModule) return undefined;
  const projectName = basename(projectPath).replace(/\.uproject$/i, '');
  if (!projectName) throw new Error(`Could not derive an Unreal Editor target from ${projectPath}.`);
  return `${projectName}Editor`;
}

async function containsBuildRules(directory: string): Promise<boolean> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.build.cs')) return true;
    if (entry.isDirectory() && await containsBuildRules(resolve(directory, entry.name))) return true;
  }
  return false;
}
