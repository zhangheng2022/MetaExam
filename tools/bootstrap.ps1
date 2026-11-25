param([string]$Proxy='', [switch]$Packaging, [switch]$SkipDependencies)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
New-Item -ItemType Directory -Force '.tools','.tools/node' | Out-Null
$toolchain=Get-Content toolchain.lock.json -Raw | ConvertFrom-Json
function Download([string]$Url,[string]$Destination) {
  $downloadArgs=@('-L','--fail','--retry','2','--tlsv1.2','--tls-max','1.2',$Url,'-o',$Destination)
  if($Proxy){$downloadArgs=@('--proxy',$Proxy)+$downloadArgs}
  & curl.exe @downloadArgs
  if($LASTEXITCODE -ne 0){throw "Download failed: $Url"}
}
foreach($entry in $toolchain.files){
  if(-not $Packaging -and $entry.file -notin @('.tools/node-official.zip','.tools/postgres.zip')){continue}
  if(-not(Test-Path -LiteralPath $entry.file)){Download $entry.url $entry.file}
  if((Get-FileHash -LiteralPath $entry.file -Algorithm SHA256).Hash -ne $entry.sha256){throw "Checksum mismatch: $($entry.file). Do not automatically rewrite toolchain.lock.json."}
}
$nodeVersion=($toolchain.files | Where-Object {$_.file -eq '.tools/node-official.zip'}).version
if(-not(Test-Path '.tools/node/node.exe')){
  & tar.exe -xf .tools/node-official.zip -C .tools
  if($LASTEXITCODE -ne 0){throw 'Node extraction failed'}
  Copy-Item ".tools/node-v$nodeVersion-win-x64/node.exe" '.tools/node/node.exe'
  Copy-Item ".tools/node-v$nodeVersion-win-x64/LICENSE" '.tools/node/LICENSE'
}
if((& .tools/node/node.exe --version) -ne "v$nodeVersion"){throw 'Project Node version differs from toolchain.lock.json'}
if(-not(Test-Path '.tools/pgsql/bin/postgres.exe')){
  & tar.exe -xf .tools/postgres.zip -C .tools
  if($LASTEXITCODE -ne 0){throw 'PostgreSQL extraction failed'}
}
if($Packaging -and -not(Test-Path '.tools/inno/ISCC.exe')){
  $compilerDir=Join-Path $projectRoot '.tools/inno'
  $compilerProcess=Start-Process -FilePath (Join-Path $projectRoot '.tools/innosetup.exe') -ArgumentList @('/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/TASKS=!fileassoc',('/DIR="'+$compilerDir+'"')) -Wait -PassThru -WindowStyle Hidden
  if($compilerProcess.ExitCode -ne 0){throw 'Inno Setup compiler installation failed'}
}
$env:PATH=(Join-Path $projectRoot '.tools/node')+';'+$env:PATH
$env:NODE_OPTIONS='--tls-max-v1.2'
if($Proxy){$env:npm_config_https_proxy=$Proxy;$env:ELECTRON_GET_USE_PROXY='1';$env:GLOBAL_AGENT_HTTPS_PROXY=$Proxy}
$pnpmVersion=((Get-Content package.json -Raw|ConvertFrom-Json).packageManager -split '@')[1]
if(-not(Test-Path '.tools/pnpm/node_modules/pnpm/bin/pnpm.cjs')){
  Download "https://registry.npmjs.org/pnpm/-/pnpm-$pnpmVersion.tgz" '.tools/pnpm.tgz'
  New-Item -ItemType Directory -Force '.tools/pnpm/node_modules/pnpm' | Out-Null
  & tar.exe -xf '.tools/pnpm.tgz' -C '.tools/pnpm/node_modules/pnpm' --strip-components=1
  if($LASTEXITCODE -ne 0){throw 'pnpm extraction failed'}
}
if(-not $SkipDependencies){
  & tools/run.ps1 install --frozen-lockfile
  if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'}
  & .tools/node/node.exe apps/desktop/node_modules/electron/install.js
  if($LASTEXITCODE -ne 0){throw 'Electron runtime preparation failed'}
}
Write-Output 'Project tools ready. No global PATH changes or application Windows services.'
