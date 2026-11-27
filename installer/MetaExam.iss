#ifndef MyAppVersion
#define MyAppVersion "0.1.18"
#endif
[Setup]
SetupIconFile=..\packages\ui\public\brand\icon.ico
SignTool=metaexam
SignedUninstaller=yes
AppId={{5F3FDD48-CFEC-4F32-A343-50D44B341446}
AppName=元考 MetaExam 内部测试版
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\MetaExam
DefaultGroupName=MetaExam
OutputDir=..\artifacts
OutputBaseFilename=MetaExam-Setup-{#MyAppVersion}-win-x64-internal
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
PrivilegesRequired=admin
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\manager\MetaExam.Manager.exe
CloseApplications=no
SetupLogging=yes
[Files]
Source: "..\artifacts\payload\*"; DestDir: "{code:PayloadDirectory}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\MetaExam"; Filename: "{app}\manager\MetaExam.Manager.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\MetaExam"; Filename: "{app}\manager\MetaExam.Manager.exe"; WorkingDir: "{app}"
[UninstallDelete]
Type: files; Name: "{app}\release.json"
Type: files; Name: "{app}\maintenance\release.mjs"
Type: files; Name: "{app}\maintenance\upgrade.mjs"
Type: files; Name: "{app}\maintenance\upgrade-engine.mjs"
Type: files; Name: "{app}\maintenance\upgrade-windows.mjs"
Type: files; Name: "{app}\maintenance\repair-engine.mjs"
Type: files; Name: "{app}\maintenance\repair-windows.mjs"
Type: files; Name: "{app}\maintenance\operation-lock.mjs"
Type: files; Name: "{app}\maintenance\uninstall-state.mjs"
Type: files; Name: "{app}\maintenance\install-health.mjs"
Type: files; Name: "{app}\maintenance\restart-database.mjs"
Type: files; Name: "{app}\maintenance\bootstrap-database.mjs"
Type: files; Name: "{app}\maintenance\service-config.mjs"
Type: files; Name: "{app}\maintenance\postgres-shutdown.mjs"
Type: files; Name: "{app}\maintenance\UPGRADE.md"
Type: files; Name: "{app}\maintenance\DIAGNOSTICS.md"
[Code]
#include "windows-compatibility.iss"
#include "install-result.iss"

function InitializeSetup: Boolean;
begin
  Result := RequireCompatibleWindows(CurrentWindowsCompatibilityError);
end;

var
  NetworkPage: TInputQueryWizardPage;
  CertPage: TInputFileWizardPage;
  LocalOnlyPage: TInputOptionWizardPage;
  Upgrading: Boolean;
function PayloadDirectory(Param: String): String;
begin
 if Upgrading then Result := ExpandConstant('{tmp}\upgrade-payload') else Result := ExpandConstant('{app}');
end;
function InitializeUninstall: Boolean;
var Code: Integer; Args: String;
begin
 Args := '"' + ExpandConstant('{app}\maintenance\setup.mjs') + '" uninstall "' + ExpandConstant('{app}') + '" "' + ExpandConstant('{commonappdata}\MetaExam') + '"';
 Result := Exec(ExpandConstant('{app}\runtime\node.exe'), Args, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
 if Result then Result := Code = 0;
 if not Result then MsgBox('Services could not be stopped safely. Uninstall cancelled; inspect logs and retry.', mbError, MB_OK);
end;
function NeedsVCRuntime: Boolean;
var Installed: Cardinal;
begin
  Result := not RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed);
  if not Result then Result := Installed <> 1;
end;
procedure InitializeWizard;
begin
  Upgrading := FileExists(ExpandConstant('{commonappdata}\MetaExam\installation.json'));
  LocalOnlyPage := CreateInputOptionPage(wpSelectDir, 'Internal test deployment', 'Choose the access mode', 'This package is internally self-signed and is for technical validation.', True, False);
  LocalOnlyPage.Add('Local computer only (HTTP loopback)');
  LocalOnlyPage.Add('LAN access with HTTPS certificate');
  LocalOnlyPage.SelectedValueIndex := 0;
  NetworkPage := CreateInputQueryPage(LocalOnlyPage.ID, 'Network settings', 'Set the application ports', 'Database stays on loopback. Firewall changes apply only to HTTPS LAN mode.');
  NetworkPage.Add('Application port:', False); NetworkPage.Values[0] := '3000';
  NetworkPage.Add('Allowed LAN subnet (CIDR or LocalSubnet):', False); NetworkPage.Values[1] := 'LocalSubnet';
  NetworkPage.Add('Database port:', False); NetworkPage.Values[2] := '55432';
  CertPage := CreateInputFilePage(NetworkPage.ID, 'HTTPS certificate', 'Select PEM files', 'The certificate SAN must include the LAN IP/domain and 127.0.0.1. Distribute the issuing CA to clients separately.');
  CertPage.Add('Certificate (PEM):', '*.crt;*.pem', '.crt');
  CertPage.Add('Private key (PEM):', '*.key;*.pem', '.key');
end;
function ShouldSkipPage(PageID: Integer): Boolean;
begin
 Result := ((PageID = CertPage.ID) and (LocalOnlyPage.SelectedValueIndex = 0)) or (Upgrading and ((PageID = LocalOnlyPage.ID) or (PageID = NetworkPage.ID) or (PageID = CertPage.ID)));
end;
function NextButtonClick(CurPageID: Integer): Boolean;
var Port, DatabasePort: Integer;
begin
 Result := True;
 if CurPageID = NetworkPage.ID then begin
   Port := StrToIntDef(NetworkPage.Values[0], 0);
   if (Port < 1) or (Port > 65535) then begin MsgBox('Enter a valid port.', mbError, MB_OK); Result := False; end;
   DatabasePort := StrToIntDef(NetworkPage.Values[2], 0);
   if (DatabasePort < 1) or (DatabasePort > 65535) or (DatabasePort = Port) then begin MsgBox('Database port must be valid and different from the application port.', mbError, MB_OK); Result := False; end;
 end;
 if (CurPageID = CertPage.ID) and (LocalOnlyPage.SelectedValueIndex = 1) then
   if not FileExists(CertPage.Values[0]) or not FileExists(CertPage.Values[1]) then begin
     MsgBox('Both certificate and private key files are required.', mbError, MB_OK); Result := False;
   end;
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
 Result := '';
 if Upgrading and not DirExists(ExpandConstant('{commonappdata}\MetaExam\reinstall')) and (not FileExists(ExpandConstant('{app}\release.json')) or not FileExists(ExpandConstant('{app}\runtime\node.exe'))) then
   Result := 'Select the existing MetaExam installation directory. Existing data will not be initialized again.';
end;
procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer; Cert, Key, Args: String;
begin
 if CurStep = ssPostInstall then begin
   BeginPostInstall;
   WizardForm.StatusLabel.Caption := 'Configuring services and initializing the database...';
   if Upgrading then begin
     Args := '--use-system-ca "' + ExpandConstant('{tmp}\upgrade-payload\maintenance\upgrade.mjs') + '" apply "' + ExpandConstant('{app}') + '" "' + ExpandConstant('{commonappdata}\MetaExam') + '"';
     if not Exec(ExpandConstant('{tmp}\upgrade-payload\runtime\node.exe'), Args, ExpandConstant('{tmp}\upgrade-payload'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
       RaiseException('Upgrade or incomplete-install repair did not complete. Exit the manager from the system tray, inspect ProgramData\MetaExam\upgrade.log and rerun the SAME package to resume. Existing data and recovery records are retained. Do not remove maintenance markers or install an older version.');
     CompletePostInstall;
     Exit;
   end;
   if NeedsVCRuntime then
     if not Exec(ExpandConstant('{app}\vendor\vc_redist.x64.exe'), '/install /quiet /norestart', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or ((Code <> 0) and (Code <> 3010) and (Code <> 1638)) then
       RaiseException('Visual C++ runtime installation failed.');
   Cert := ''; Key := '';
   if LocalOnlyPage.SelectedValueIndex = 1 then begin Cert := CertPage.Values[0]; Key := CertPage.Values[1]; end;
    Args := '--use-system-ca "' + ExpandConstant('{app}\maintenance\setup.mjs') + '" install "' + ExpandConstant('{app}') + '" "' + ExpandConstant('{commonappdata}\MetaExam') + '" "' + Cert + '" "' + Key + '" "' + NetworkPage.Values[0] + '" "' + NetworkPage.Values[1] + '" "' + NetworkPage.Values[2] + '"';
   if not Exec(ExpandConstant('{app}\runtime\node.exe'), Args, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
     RaiseException('Service configuration failed. Inspect installer and service logs. Existing data has been retained.');
   CompletePostInstall;
 end;
end;
