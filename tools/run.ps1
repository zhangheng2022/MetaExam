param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArgs)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = Join-Path $root '.tools\node'
if (-not (Test-Path (Join-Path $node 'node.exe'))) { throw 'Run tools/bootstrap.ps1 first.' }
$env:PATH = $node + ';' + (Join-Path $root '.tools\pnpm') + ';' + $env:PATH
Set-Location $root
& (Join-Path $node 'node.exe') (Join-Path $root '.tools\pnpm\node_modules\pnpm\bin\pnpm.cjs') @TaskArgs
exit $LASTEXITCODE
