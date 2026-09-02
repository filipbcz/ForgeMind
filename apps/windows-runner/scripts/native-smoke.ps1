$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw 'This smoke test must run on Windows.'
}

$cliPath = Join-Path $PSScriptRoot '..\dist\cli.js'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Built Windows runner CLI not found: $cliPath"
}

& node -e "import(require('node:url').pathToFileURL(process.argv[1]).href).then((module) => { if (typeof module.parseCliArgs !== 'function') { throw new Error('CLI module does not export parseCliArgs.'); } }).catch((error) => { console.error(error.message); process.exit(1); });" $cliPath
if ($LASTEXITCODE -ne 0) {
  throw "Failed to load the Windows runner CLI (Node.js exit code $LASTEXITCODE)."
}

Write-Output 'FORGEMIND_WINDOWS_RUNNER_OK'
