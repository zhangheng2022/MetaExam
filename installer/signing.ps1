param(
  [ValidateSet('Initialize','Check','Sign','Verify')][string]$Action = 'Check',
  [string]$Target,
  [string]$HomeDirectory = $env:METAEXAM_SIGNING_HOME
)
$ErrorActionPreference = 'Stop'
# Inno runs a 32-bit child process; explicitly load the Windows security provider.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
if (-not $HomeDirectory) { $HomeDirectory = 'C:\Users\96227\OneDrive\MetaExam\code-signing' }
$HomeDirectory = [IO.Path]::GetFullPath($HomeDirectory)
$metadataPath = Join-Path $HomeDirectory 'certificate.json'
if ($Action -eq 'Initialize') {
  if (Test-Path -LiteralPath $metadataPath) { throw 'SIGNING_ALREADY_INITIALIZED' }
  if ((Test-Path -LiteralPath $HomeDirectory) -and @(Get-ChildItem -LiteralPath $HomeDirectory -Force).Count) { throw 'SIGNING_DIRECTORY_NOT_EMPTY' }
  New-Item -ItemType Directory -Path $HomeDirectory -Force | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $HomeDirectory /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'SIGNING_ACL_FAILED' }
  & icacls.exe $HomeDirectory /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'SIGNING_ACL_FAILED' }
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=MetaExam Internal Code Signing' -FriendlyName 'MetaExam self-signed installer certificate' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3)
  $random = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($random); $rng.Dispose()
  $password = ConvertTo-SecureString -String ([Convert]::ToBase64String($random)) -AsPlainText -Force
  [Array]::Clear($random,0,$random.Length)
  Export-PfxCertificate -Cert $certificate -FilePath (Join-Path $HomeDirectory 'MetaExam-CodeSigning.pfx') -Password $password | Out-Null
  $password | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $HomeDirectory 'pfx-password.dpapi') -Encoding ascii
  Export-Certificate -Cert $certificate -FilePath (Join-Path $HomeDirectory 'MetaExam-CodeSigning.cer') | Out-Null
  @{ thumbprint=$certificate.Thumbprint; subject=$certificate.Subject; notAfter=$certificate.NotAfter.ToUniversalTime().ToString('o'); store='CurrentUser/My'; protection='PFX password protected; password DPAPI CurrentUser'; timestamp='none' } | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8
}
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ($metadata.thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'SIGNING_CERTIFICATE_INVALID' }
$certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($metadata.thumbprint)"
if (-not $certificate.HasPrivateKey -or $certificate.Subject -ne $certificate.Issuer -or $certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) { throw 'SIGNING_CERTIFICATE_UNAVAILABLE' }
if (-not (@($certificate.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId }) -contains '1.3.6.1.5.5.7.3.3')) { throw 'SIGNING_EKU_INVALID' }
$public = New-Object Security.Cryptography.X509Certificates.X509Certificate2 (Join-Path $HomeDirectory 'MetaExam-CodeSigning.cer')
if ($public.Thumbprint -ne $certificate.Thumbprint) { throw 'SIGNING_PUBLIC_CERTIFICATE_MISMATCH' }
if ($Action -eq 'Sign') {
  $resolved = (Resolve-Path -LiteralPath $Target).Path
  # Inno signs temporary PE files such as uninst.e32.tmp before embedding.
  $stream = [IO.File]::OpenRead($resolved)
  try { if ($stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) { throw 'SIGNING_TARGET_INVALID' } }
  finally { $stream.Dispose() }
  Set-AuthenticodeSignature -LiteralPath $resolved -Certificate $certificate -HashAlgorithm SHA256 -IncludeChain All | Out-Null
}
if ($Action -in @('Sign','Verify')) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Target
  Add-Type -Path (Join-Path $PSScriptRoot 'authenticode.cs')
  $trust = [MetaExamAuthenticode]::Check((Resolve-Path -LiteralPath $Target).Path)
  # Only the exact untrusted-root result is allowed for our pinned self-signed certificate.
  # This is NOT Windows trust: all other errors (including bad digest) fail closed.
  if ($signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $trust -notin @(0, [uint32]2148204809)) { throw ('SIGNATURE_VERIFICATION_FAILED:0x{0:X8}' -f $trust) }
  @{ thumbprint=$certificate.Thumbprint; status=$(if ($trust -eq 0) {'Valid'} else {'PinnedSelfSignedUntrustedRoot'}); timestamped=($null -ne $signature.TimeStamperCertificate) } | ConvertTo-Json -Compress
} else {
  @{ thumbprint=$certificate.Thumbprint; subject=$certificate.Subject; notAfter=$metadata.notAfter; publicCertificate=(Join-Path $HomeDirectory 'MetaExam-CodeSigning.cer'); timestamped=$false } | ConvertTo-Json -Compress
}
