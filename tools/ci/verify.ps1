param([switch]$Child)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location $root
New-Item -ItemType Directory -Force '.local' | Out-Null
$log=Join-Path $root '.local/ci-verification.log'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Child) {
  $env:METAEXAM_CI_EXPECTED_SID=$identity.User.Value
  if ($admin) {
    Add-Type -Path (Join-Path $PSScriptRoot 'RestrictedProcess.cs')
    $exe=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $command='"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Child'
    $code=[MetaExamRestrictedProcess]::Run($exe,$command,$root)
  } else {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -Child
    $code=$LASTEXITCODE
  }
  if (Test-Path $log) { Get-Content $log }
  exit $code
}
& {
  if ($admin -or $identity.User.Value -ne $env:METAEXAM_CI_EXPECTED_SID) { throw 'CI_RESTRICTED_IDENTITY_REQUIRED' }
  Write-Output 'PASS real non-administrator token, original Windows user preserved'
  function Task([string[]]$Arguments) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/run.ps1 @Arguments
    if ($LASTEXITCODE) { throw ('CI_TASK_FAILED: '+($Arguments -join ' ')) }
  }
  try {
    Task @('db:start')
    Task @('exec','playwright','install','chromium')
    foreach ($task in @('test:integration','test:issuer','test:signing','test:package','test:issuer:package')) { Task @($task) }
  } finally { Task @('db:stop') }
} *> $log
