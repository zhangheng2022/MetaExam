param([string]$DataPath)
$ErrorActionPreference = 'Stop'

function Assert-FreshDataDirectory([string]$Path) {
  if ($Path -notmatch '^[a-zA-Z]:[\\/]') { throw 'DATA_PATH_MUST_BE_LOCAL_ABSOLUTE' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'DATA_PATH_IS_ROOT' }
  $current = $full
  while ($current) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'DATA_PATH_REPARSE_POINT' }
      if (-not $item.PSIsContainer) { throw 'DATA_PATH_NOT_DIRECTORY' }
    }
    $parent = [IO.Directory]::GetParent($current)
    $current = if ($parent) { $parent.FullName } else { $null }
  }
  # Fresh installs only: never rewrite ACLs on an existing database, arbitrary
  # files, hard links or child directories. Maintenance upgrades are separate.
  if (Test-Path -LiteralPath $full) {
    if (@(Get-ChildItem -LiteralPath $full -Force).Count -ne 0) { throw 'DATA_DIRECTORY_NOT_EMPTY' }
  }
  return $full
}

function New-RestrictedDataAcl {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl',
      'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  return $acl
}

function Initialize-DataDirectory([string]$Path) {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'ADMINISTRATOR_REQUIRED' }
  $full = Assert-FreshDataDirectory $Path
  [IO.Directory]::CreateDirectory($full) | Out-Null
  $null = Assert-FreshDataDirectory $full
  $acl = New-RestrictedDataAcl
  # A non-admin creator must not retain implicit owner WRITE_DAC rights.
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  [IO.Directory]::SetAccessControl($full, $acl)
  $actual = [IO.Directory]::GetAccessControl($full)
  $rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 2 -or
      $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544' -or
      @($rules | Where-Object { $_.IdentityReference.Value -notin @('S-1-5-18', 'S-1-5-32-544') -or $_.AccessControlType -ne 'Allow' }).Count -ne 0) {
    throw 'DATA_DIRECTORY_ACL_INVALID'
  }
  $null = Assert-FreshDataDirectory $full
}

if ($DataPath) { Initialize-DataDirectory $DataPath }
