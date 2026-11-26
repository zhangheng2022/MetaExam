$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../installer/data-directory.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('MetaExam-acl-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
function Restore-TestAcl([string]$Path) {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  [IO.Directory]::SetAccessControl($Path, $acl)
}
function Assert-Rejected([string]$Path, [string]$Code) {
  try { $null = Assert-FreshDataDirectory $Path; throw 'EXPECTED_REJECTION' }
  catch { if ($_.Exception.Message -ne $Code) { throw } }
}
try {
  $bad = [IO.Directory]::GetAccessControl($testRoot)
  foreach ($sid in @('S-1-5-32-545', 'S-1-1-0', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
    $bad.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  [IO.Directory]::SetAccessControl($testRoot, $bad)
  $null = Assert-FreshDataDirectory $testRoot
  # Same DACL builder as install; changing ownership to Administrators requires
  # an elevated independent test environment, so leave the test user's owner SID.
  [IO.Directory]::SetAccessControl($testRoot, (New-RestrictedDataAcl))
  $actual = [IO.Directory]::GetAccessControl($testRoot)
  $rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 2 -or
      @($rules | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') }).Count -ne 0) { throw 'UNEXPECTED_ACE_RETAINED' }
  Restore-TestAcl $testRoot
  Set-Content -LiteralPath (Join-Path $testRoot 'existing.txt') -Value 'preserve'
  Assert-Rejected $testRoot 'DATA_DIRECTORY_NOT_EMPTY'
  if ((Get-Content -LiteralPath (Join-Path $testRoot 'existing.txt')) -ne 'preserve') { throw 'EXISTING_DATA_CHANGED' }
  $empty = Join-Path $testRoot 'empty'
  New-Item -ItemType Directory -Path $empty | Out-Null
  $null = Assert-FreshDataDirectory $empty
  $junction = Join-Path $testRoot 'junction'
  New-Item -ItemType Junction -Path $junction -Target $empty | Out-Null
  Assert-Rejected $junction 'DATA_PATH_REPARSE_POINT'
  Assert-Rejected (Join-Path $junction 'child') 'DATA_PATH_REPARSE_POINT'
  Assert-Rejected (Join-Path $testRoot 'existing.txt') 'DATA_PATH_NOT_DIRECTORY'
  Assert-Rejected ([IO.Path]::GetPathRoot($testRoot)) 'DATA_PATH_IS_ROOT'
  Assert-Rejected 'relative/path' 'DATA_PATH_MUST_BE_LOCAL_ABSOLUTE'
  if (-not [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    try { Initialize-DataDirectory $empty; throw 'EXPECTED_ADMIN_REJECTION' }
    catch { if ($_.Exception.Message -ne 'ADMINISTRATOR_REQUIRED') { throw } }
  }
  Write-Output 'PASS replaced explicit Users/Everyone/user ACEs, protected DACL, nonempty preservation, junction/ancestor/root/file rejection and elevation boundary'
} finally {
  Restore-TestAcl $testRoot
  $resolved = (Resolve-Path -LiteralPath $testRoot).Path
  if ([IO.Path]::GetDirectoryName($resolved) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') -or
      -not [IO.Path]::GetFileName($resolved).StartsWith('MetaExam-acl-test-')) { throw 'UNSAFE_TEST_CLEANUP' }
  $link = Join-Path $resolved 'junction'
  if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
