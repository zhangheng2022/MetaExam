#define MyAppVersion "0.1.0"
[Setup]
AppId={{5F3FDD48-CFEC-4F32-A343-50D44B341446}
AppName=MetaExam Internal Test
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\MetaExam
DefaultGroupName=MetaExam
OutputDir=..\artifacts
OutputBaseFilename=MetaExam-Setup-{#MyAppVersion}-win-x64-internal
ArchitecturesAllowed=x64compatible and not arm64
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
PrivilegesRequired=admin
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\manager\MetaExam.Manager.exe
CloseApplications=no
SetupLogging=yes
[Files]
Source: "..\artifacts\payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\MetaExam"; Filename: "{app}\manager\MetaExam.Manager.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\MetaExam"; Filename: "{app}\manager\MetaExam.Manager.exe"; WorkingDir: "{app}"
[Code]
var
  NetworkPage: TInputQueryWizardPage;
  CertPage: TInputFileWizardPage;
  LocalOnlyPage: TInputOptionWizardPage;
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
  LocalOnlyPage := CreateInputOptionPage(wpSelectDir, 'Internal test deployment', 'Choose the access mode', 'This package is unsigned and is for phase 1 technical validation.', True, False);
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
 Result := (PageID = CertPage.ID) and (LocalOnlyPage.SelectedValueIndex = 0);
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
 if FileExists(ExpandConstant('{commonappdata}\MetaExam\installation.json')) then
   Result := 'An existing installation was found. Phase 1 does not implement in-place upgrades. Preserve the database and follow the maintenance guide.';
end;
procedure CurStepChanged(CurStep: TSetupStep);
var Code: Integer; Cert, Key, Args: String;
begin
 if CurStep = ssPostInstall then begin
   if NeedsVCRuntime then
     if not Exec(ExpandConstant('{app}\vendor\vc_redist.x64.exe'), '/install /quiet /norestart', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or ((Code <> 0) and (Code <> 3010) and (Code <> 1638)) then
       RaiseException('Visual C++ runtime installation failed.');
   Cert := ''; Key := '';
   if LocalOnlyPage.SelectedValueIndex = 1 then begin Cert := CertPage.Values[0]; Key := CertPage.Values[1]; end;
   Args := '"' + ExpandConstant('{app}\maintenance\setup.mjs') + '" install "' + ExpandConstant('{app}') + '" "' + ExpandConstant('{commonappdata}\MetaExam') + '" "' + Cert + '" "' + Key + '" "' + NetworkPage.Values[0] + '" "' + NetworkPage.Values[1] + '" "' + NetworkPage.Values[2] + '"';
   if not Exec(ExpandConstant('{app}\runtime\node.exe'), Args, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
     RaiseException('Service configuration failed. Inspect installer and service logs. Existing data has been retained.');
 end;
end;
