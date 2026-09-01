import { spawn } from 'node:child_process';

export interface RunnerCredential { deviceId: string; credential: string }
export interface CredentialStore {
  save(value: RunnerCredential): Promise<void>;
  load(): Promise<RunnerCredential | undefined>;
  remove(): Promise<void>;
}

const target = 'ForgeMind.WindowsRunner';
const powershell = String.raw`
$ErrorActionPreference='Stop'
$inputValue=[Console]::In.ReadToEnd()
$vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
if ($env:FM_CREDENTIAL_ACTION -eq 'save') {
  $value=$inputValue | ConvertFrom-Json
  try { $old=$vault.Retrieve($env:FM_CREDENTIAL_TARGET,$value.deviceId); $vault.Remove($old) } catch {}
  $item=[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new($env:FM_CREDENTIAL_TARGET,$value.deviceId,$value.credential)
  $vault.Add($item)
} elseif ($env:FM_CREDENTIAL_ACTION -eq 'load') {
  $item=($vault.FindAllByResource($env:FM_CREDENTIAL_TARGET) | Select-Object -First 1)
  if ($null -ne $item) { $item.RetrievePassword(); @{deviceId=$item.UserName;credential=$item.Password} | ConvertTo-Json -Compress }
} elseif ($env:FM_CREDENTIAL_ACTION -eq 'remove') {
  foreach ($item in $vault.FindAllByResource($env:FM_CREDENTIAL_TARGET)) { $vault.Remove($item) }
}`;

/** Uses Windows Credential Locker; secrets are supplied over stdin, never arguments or plaintext environment variables. */
export class WindowsCredentialStore implements CredentialStore {
  async save(value: RunnerCredential): Promise<void> { await invoke('save', JSON.stringify(value)); }
  async load(): Promise<RunnerCredential | undefined> {
    const output = await invoke('load', '');
    return output.trim() ? JSON.parse(output) as RunnerCredential : undefined;
  }
  async remove(): Promise<void> { await invoke('remove', ''); }
}

function invoke(action: string, input: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows Credential Locker is available only on Windows.'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershell], {
      shell: false, windowsHide: true, env: { SystemRoot: process.env.SystemRoot, FM_CREDENTIAL_ACTION: action, FM_CREDENTIAL_TARGET: target }
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Credential Locker failed (${code}): ${stderr.trim()}`)));
    child.stdin.end(input);
  });
}
