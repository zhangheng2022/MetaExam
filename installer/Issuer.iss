#ifndef IssuerVersion
  #define IssuerVersion "0.1.5"
#endif
[Setup]
SignTool=metaexam
SignedUninstaller=yes
AppId={{3502D13A-BF68-44DC-97DD-736EC05D6298}
AppName=MetaExam 授权签发器
AppVersion={#IssuerVersion}
DefaultDirName={localappdata}\Programs\MetaExam.Issuer
DefaultGroupName=MetaExam 授权签发器
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
SetupLogging=yes
OutputBaseFilename=MetaExam-Issuer-Setup-{#IssuerVersion}-win-x64-internal
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\MetaExam.Issuer.exe
CloseApplications=yes
[Files]
Source: "..\artifacts\issuer-payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\MetaExam 授权签发器"; Filename: "{app}\MetaExam.Issuer.exe"
[Run]
Filename: "{app}\MetaExam.Issuer.exe"; Description: "打开授权签发器"; Flags: nowait postinstall skipifsilent
; User data is never listed in UninstallDelete. No service or firewall operations.
[Code]
#include "windows-compatibility.iss"

function InitializeSetup: Boolean;
begin
  Result := RequireCompatibleWindows(CurrentWindowsCompatibilityError);
end;
