{ Inno can report a successful file-copy phase even when ssPostInstall raises.
  Preserve the failure as a nonzero process exit code for unattended callers. }
var
  PostInstallFailed: Boolean;

procedure BeginPostInstall;
begin
  PostInstallFailed := True;
end;

procedure CompletePostInstall;
begin
  PostInstallFailed := False;
end;

function GetCustomSetupExitCode: Integer;
begin
  if PostInstallFailed then Result := 10 else Result := 0;
end;
