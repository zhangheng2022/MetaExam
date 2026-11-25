param([string]$Proxy = '', [string]$NodeVersion = '24.22.3')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
Set-Location $root
New-Item -ItemType Directory -Force '.tools','.tools\node' | Out-Null
function Download([string]$Url,[string]$Out) {
  $args=@('-L','--fail','--retry','2','--tlsv1.2','--tls-max','1.2',$Url,'-o',$Out)
  if($Proxy){$args=@('--proxy',$Proxy)+$args}
  & curl.exe @args
  if($LASTEXITCODE -ne 0){throw "Download failed: $Url"}
}
if(-not(Test-Path '.tools\node\node.exe')){
  $zip="node-v$NodeVersion-win-x64.zip"
  Download "https://nodejs.org/dist/v$NodeVersion/$zip" ".tools\$zip"
  Download "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" '.tools\node-checksums.txt'
  $line=Get-Content '.tools\node-checksums.txt' | Where-Object {$_ -match [regex]::Escape($zip)+'$'}
  if(-not $line){throw 'Missing Node checksum'}
  if((Get-FileHash ".tools\$zip" -Algorithm SHA256).Hash -ne ($line -split '\s+')[0]){throw 'Node checksum mismatch'}
  & tar.exe -xf ".tools\$zip" -C .tools
  Copy-Item ".tools\node-v$NodeVersion-win-x64\node.exe" '.tools\node\node.exe'
  Copy-Item ".tools\node-v$NodeVersion-win-x64\LICENSE" '.tools\node\LICENSE'
}
$env:PATH=(Join-Path $root '.tools\node')+';'+$env:PATH
$env:NODE_OPTIONS='--tls-max-v1.2'
if($Proxy){$env:npm_config_https_proxy=$Proxy; $env:ELECTRON_GET_USE_PROXY='1'; $env:GLOBAL_AGENT_HTTPS_PROXY=$Proxy}
if(-not(Test-Path '.tools\pnpm\node_modules\pnpm\bin\pnpm.cjs')){
  Download 'https://registry.npmjs.org/pnpm/-/pnpm-10.24.0.tgz' '.tools\pnpm.tgz'
  New-Item -ItemType Directory -Force '.tools\pnpm\node_modules\pnpm' | Out-Null
  & tar.exe -xf '.tools\pnpm.tgz' -C '.tools\pnpm\node_modules\pnpm' --strip-components=1
}
& tools/run.ps1 install --frozen-lockfile
if($LASTEXITCODE -ne 0){throw 'Dependency installation failed'}
& .tools/node/node.exe apps/desktop/node_modules/electron/install.js
if($LASTEXITCODE -ne 0){throw 'Electron runtime download failed'}
