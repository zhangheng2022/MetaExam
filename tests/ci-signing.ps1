$ErrorActionPreference='Stop'
# Match the product signer: fresh Windows PowerShell sessions may not autoload Cert:.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporary=Join-Path $root ('.local/ci-signing-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary -Force | Out-Null
$saved=@{}
foreach($name in @('GITHUB_ACTIONS','GITHUB_RUN_ID','RUNNER_TEMP','METAEXAM_SIGNING_PFX_BASE64','METAEXAM_SIGNING_PFX_PASSWORD')) { $saved[$name]=[Environment]::GetEnvironmentVariable($name) }
$cert=$null
try {
  $env:GITHUB_ACTIONS='true';$env:GITHUB_RUN_ID='isolated-signing-test';$env:RUNNER_TEMP=$temporary
  $env:METAEXAM_SIGNING_PFX_BASE64='';$env:METAEXAM_SIGNING_PFX_PASSWORD=''
  function Reject([string]$Expected) {
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $start.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $root 'tools/ci/signing.ps1')+'" -Action Import'
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $process=[Diagnostics.Process]::Start($start)
    $stdout=$process.StandardOutput.ReadToEnd();$stderr=$process.StandardError.ReadToEnd();$process.WaitForExit()
    if($process.ExitCode -eq 0 -or -not $stderr.Contains($Expected)) { throw ('CI_SIGNING_REJECTION_FAILED:'+ $Expected) }
    $process.Dispose()
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'tools/ci/signing.ps1') -Action Clean
    if($LASTEXITCODE) {throw 'CI_SIGNING_TEST_CLEANUP_FAILED'}
  }
  Reject 'SIGNING_SECRETS_MISSING'
  $cert=New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=MetaExam isolated CI rejection test' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddHours(1)
  $password=ConvertTo-SecureString 'Temporary CI test password 12345' -AsPlainText -Force
  $pfx=Join-Path $temporary 'isolated.pfx'
  Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
  $env:METAEXAM_SIGNING_PFX_BASE64=[Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx))
  $env:METAEXAM_SIGNING_PFX_PASSWORD='wrong password'
  Reject 'SIGNING_PFX_DECODE_FAILED'
  $env:METAEXAM_SIGNING_PFX_PASSWORD='Temporary CI test password 12345'
  Reject 'SIGNING_PFX_MISMATCH'
  Write-Output 'PASS missing secrets, wrong PFX password and unpinned certificate rejected without import'
} finally {
  if($cert){Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$cert.Thumbprint) -DeleteKey}
  foreach($name in $saved.Keys){[Environment]::SetEnvironmentVariable($name,$saved[$name])}
  if([IO.Path]::GetDirectoryName($temporary) -ne (Join-Path $root '.local')){throw 'UNSAFE_TEST_PATH'}
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
