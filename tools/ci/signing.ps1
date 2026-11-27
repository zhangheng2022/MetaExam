param([ValidateSet('Import','Clean')][string]$Action)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'CI_ONLY' }
$directory = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) 'metaexam-signing'
$pin = (Get-Content (Join-Path $PSScriptRoot '../../installer/signing-certificate.json') -Raw | ConvertFrom-Json).thumbprint
if ($pin -notmatch '^[A-F0-9]{40}$') { throw 'SIGNING_PIN_INVALID' }
$marker = Join-Path $directory 'imported.json'
if ($Action -eq 'Clean') {
  if (Test-Path -LiteralPath $marker) {
    $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($owner.thumbprint -ne $pin -or $owner.runId -ne $env:GITHUB_RUN_ID) { throw 'SIGNING_CLEANUP_OWNER_MISMATCH' }
    if (Test-Path "Cert:\CurrentUser\My\$pin") { Remove-Item "Cert:\CurrentUser\My\$pin" -DeleteKey }
  }
  if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
  exit 0
}
if (Test-Path -LiteralPath $directory) { throw 'SIGNING_TEMP_EXISTS' }
if (-not $env:METAEXAM_SIGNING_PFX_BASE64 -or -not $env:METAEXAM_SIGNING_PFX_PASSWORD) { throw 'SIGNING_SECRETS_MISSING' }
New-Item -ItemType Directory -Path $directory | Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $directory /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'SIGNING_ACL_FAILED' }
& icacls.exe $directory /inheritance:r | Out-Null
if ($LASTEXITCODE) { throw 'SIGNING_ACL_FAILED' }
$pfx=Join-Path $directory 'certificate.pfx'
try {
  [IO.File]::WriteAllBytes($pfx,[Convert]::FromBase64String($env:METAEXAM_SIGNING_PFX_BASE64))
  $password=ConvertTo-SecureString $env:METAEXAM_SIGNING_PFX_PASSWORD -AsPlainText -Force
  try { $data=Get-PfxData -FilePath $pfx -Password $password } catch { throw 'SIGNING_PFX_DECODE_FAILED' }
  if (@($data.EndEntityCertificates).Count -ne 1 -or $data.EndEntityCertificates[0].Thumbprint -ne $pin -or @($data.OtherCertificates).Count -gt 0) { throw 'SIGNING_PFX_MISMATCH' }
  if (Test-Path "Cert:\CurrentUser\My\$pin") { throw 'SIGNING_CERTIFICATE_ALREADY_EXISTS' }
  @{thumbprint=$pin;runId=$env:GITHUB_RUN_ID} | ConvertTo-Json | Set-Content $marker
  $cert=Import-PfxCertificate -FilePath $pfx -Password $password -CertStoreLocation Cert:\CurrentUser\My
  Export-Certificate -Cert $cert -FilePath (Join-Path $directory 'MetaExam-CodeSigning.cer') | Out-Null
  @{thumbprint=$pin;notAfter=$cert.NotAfter.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $directory 'certificate.json')
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '../../installer/signing.ps1') -Action Check -HomeDirectory $directory
  if ($LASTEXITCODE) { throw 'SIGNING_CERTIFICATE_REJECTED' }
  "METAEXAM_SIGNING_HOME=$directory" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
} finally {
  Remove-Item Env:METAEXAM_SIGNING_PFX_BASE64,Env:METAEXAM_SIGNING_PFX_PASSWORD -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
  if ($password) { $password.Dispose() }
}
