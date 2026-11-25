param([string]$Proxy='')
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$lock=Get-Content toolchain.lock.json -Raw|ConvertFrom-Json
New-Item -ItemType Directory -Force '.tools' | Out-Null
foreach($item in $lock.files){
 if(-not(Test-Path -LiteralPath $item.file)){
  $args=@('-L','--fail','--retry','2','--tlsv1.2','--tls-max','1.2',$item.url,'-o',$item.file)
  if($Proxy){$args=@('--proxy',$Proxy)+$args}
  & curl.exe @args
  if($LASTEXITCODE -ne 0){throw "Download failed: $($item.url)"}
 }
 if((Get-FileHash -LiteralPath $item.file -Algorithm SHA256).Hash -ne $item.sha256){throw "Checksum mismatch: $($item.file). Review upstream version before updating the lock."}
}
if(-not(Test-Path '.tools\pgsql\bin\postgres.exe')){& tar.exe -xf .tools/postgres.zip -C .tools}
if(-not(Test-Path '.tools\inno\ISCC.exe')){
 $dest=Join-Path $PWD '.tools\inno'
 $p=Start-Process -FilePath (Join-Path $PWD '.tools\innosetup.exe') -ArgumentList @('/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/TASKS=!fileassoc',('/DIR="'+$dest+'"')) -Wait -PassThru -WindowStyle Hidden
 if($p.ExitCode -ne 0){throw 'Inno Setup compiler installation failed'}
}
Write-Output 'Vendor tools ready. No application Windows services were registered.'
