// Shared by both installers and the isolated Inno regression harness.
// This file has no test switches or command-line overrides.
function WindowsCompatibilityError(Major, Minor, Build: Cardinal;
  ProductType: Byte; Architecture: TSetupProcessorArchitecture;
  InstallationType: String): String;
begin
  Result := '';
  if Architecture <> paX64 then begin
    Result := 'WINDOWS_ARCHITECTURE: MetaExam requires native x64 Windows; ARM64 and 32-bit Windows are not supported.';
    Exit;
  end;
  if (Major <> 10) or (Minor <> 0) then begin
    Result := 'WINDOWS_VERSION: Supported targets are Windows 10 22H2, Windows 11, and Windows Server 2022/2025 with Desktop Experience.';
    Exit;
  end;
  if ProductType = VER_NT_WORKSTATION then begin
    if (Build <> 19045) and (Build < 22000) then
      Result := 'WINDOWS_CLIENT_VERSION: Windows 10 requires 22H2 (build 19045); Windows 11 requires build 22000 or later.'
    else if CompareText(InstallationType, 'Client') <> 0 then
      Result := 'WINDOWS_INSTALLATION_TYPE: Unable to confirm a supported desktop Windows installation.';
  end else if (ProductType = VER_NT_SERVER) or (ProductType = VER_NT_DOMAIN_CONTROLLER) then begin
    if (Build <> 20348) and (Build <> 26100) then
      Result := 'WINDOWS_SERVER_VERSION: Only Windows Server 2022 (20348) and 2025 (26100) are supported.'
    else if CompareText(InstallationType, 'Server') <> 0 then
      Result := 'WINDOWS_DESKTOP_REQUIRED: Windows Server requires Desktop Experience; Server Core and unknown installation types are not supported.';
  end else
    Result := 'WINDOWS_PRODUCT_TYPE: Unable to identify the Windows product type.';
end;

function CurrentWindowsCompatibilityError: String;
var
  Version: TWindowsVersion;
  InstallationType: String;
begin
  GetWindowsVersionEx(Version);
  InstallationType := '';
  if IsWin64 then
    RegQueryStringValue(HKLM64, 'SOFTWARE\Microsoft\Windows NT\CurrentVersion',
      'InstallationType', InstallationType);
  Result := WindowsCompatibilityError(Version.Major, Version.Minor, Version.Build,
    Version.ProductType, ProcessorArchitecture, InstallationType);
end;

function RequireCompatibleWindows(Error: String): Boolean;
begin
  Result := Error = '';
  if not Result then begin
    Log(Error);
    SuppressibleMsgBox(Error, mbCriticalError, MB_OK, IDOK);
  end;
end;
