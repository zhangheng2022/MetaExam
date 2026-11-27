param([switch]$Child)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location $root
New-Item -ItemType Directory -Force '.local' | Out-Null
$log=Join-Path $root '.local/ci-verification.log'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $Child) {
  foreach($previousLog in @($log,($log+'.native'))) {
    if(Test-Path -LiteralPath $previousLog){Remove-Item -LiteralPath $previousLog -Force}
  }
  Write-Output ('CI_PARENT_START admin='+$admin)
  $env:METAEXAM_CI_EXPECTED_SID=$identity.User.Value
  if ($admin) {
    if ($env:GITHUB_ACTIONS -ne 'true') { throw 'ELEVATED_CI_ONLY' }
    # Runner workspaces can inherit only the Administrators ACL; grant this same user
    # access before removing its admin group from the test token. No product ACL changes.
    & icacls.exe $root /grant:r ('*'+$identity.User.Value+':(OI)(CI)F') | Out-Null
    if ($LASTEXITCODE) { throw 'CI_WORKSPACE_ACL_FAILED' }
    $probe=Join-Path $root '.local/ci-admin-only.txt'
    [IO.File]::WriteAllText($probe,'CI permission probe; no secrets')
    $acl=[Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    foreach($sid in @('S-1-5-32-544','S-1-5-18')) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $probe -AclObject $acl
    $env:METAEXAM_CI_ADMIN_PROBE=$probe
    Add-Type -Path (Join-Path $PSScriptRoot 'RestrictedProcess.cs')
    $exe=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $command='"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Child'
    Write-Output 'CI_RESTRICTED_CHILD_START'
    $code=[MetaExamRestrictedProcess]::Run($exe,$command,$root,($log+'.native'))
    Write-Output ('CI_RESTRICTED_CHILD_EXIT='+$code)
    Remove-Item -LiteralPath $probe -Force
    Remove-Item Env:METAEXAM_CI_ADMIN_PROBE
  } else {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -Child
    $code=$LASTEXITCODE
  }
  if ($env:GITHUB_STEP_SUMMARY -and (Test-Path -LiteralPath $log)) {
    Get-Content -LiteralPath $log | Where-Object { $_.StartsWith('TASK_RESULT: ') } |
      ForEach-Object { '- '+$_.Substring(13) } |
      Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
  }
  if ($code -eq 0) {
    $content=Get-Content -LiteralPath $log -Raw
    foreach($marker in @('CI_VERIFICATION_COMPLETE','ISOLATED_PACKAGE_SMOKE_PASSED','PASS packaged issuer real Electron','SIGNING_OK:','PASS closing Electron leaves API and worker running')) {
      if(-not $content.Contains($marker)){throw ('CI_VERIFICATION_INCOMPLETE: '+$marker)}
    }
  }
  exit $code
}
& {
  if ($admin -or $identity.User.Value -ne $env:METAEXAM_CI_EXPECTED_SID) { throw 'CI_RESTRICTED_IDENTITY_REQUIRED' }
  Write-Output 'PASS real non-administrator token, original Windows user preserved'
  if ($env:METAEXAM_CI_ADMIN_PROBE) {
    $denied=$false
    try { [IO.File]::ReadAllText($env:METAEXAM_CI_ADMIN_PROBE) | Out-Null }
    catch [UnauthorizedAccessException] { $denied=$true }
    if(-not $denied){throw 'CI_ADMIN_FILE_ACCESS_NOT_REVOKED'}
    Write-Output 'PASS actual administrator-only file access denied'
  }
  $env:PATH=(Join-Path $root '.tools/node')+';'+(Join-Path $root '.tools/pnpm')+';'+$env:PATH
  function Task([string[]]$Arguments) {
    $taskName=$Arguments -join ' '
    $timer=[Diagnostics.Stopwatch]::StartNew()
    Write-Output ('::group::'+$taskName)
    Write-Output ('TASK_START: '+$taskName)
    $exitCode=$null
    $global:LASTEXITCODE=$null
    # Windows PowerShell represents native stderr as ErrorRecords; keep diagnostic
    # text, but determine success from exit status and actual test completion.
    $ErrorActionPreference='Continue'
    try {
      & (Join-Path $root '.tools/node/node.exe') (Join-Path $root '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs') @Arguments 2>&1 | ForEach-Object { $_.ToString() }
      $exitCode=$global:LASTEXITCODE
    } finally {
      $ErrorActionPreference='Stop'
      $timer.Stop()
      $seconds=[Math]::Round($timer.Elapsed.TotalSeconds,1)
      $result=if($null -ne $exitCode -and $exitCode -eq 0){'通过'}else{'失败'}
      Write-Output ('TASK_RESULT: '+$taskName+' '+$result+' '+$seconds+'s')
      Write-Output '::endgroup::'
    }
    if ($null -eq $exitCode -or $exitCode -ne 0) { throw ('CI_TASK_FAILED: '+($Arguments -join ' ')) }
    Write-Output ('TASK_OK: '+($Arguments -join ' '))
  }
  try {
    Task @('db:start')
    Task -Arguments @('exec','playwright','install','chromium')
    foreach ($task in @('test:integration','test:install-repair','test:upgrade','test:attempts','test:issuer','test:signing','test:package','test:issuer:package')) { Task @($task) }
  } finally { Task @('db:stop') }
  Write-Output 'CI_VERIFICATION_COMPLETE'
} 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $log
