$ErrorActionPreference='Continue'
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath -like '*juyuan-0.1.10*')
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Seconds 2
function PortFree($port) { $hit = netstat -ano | Select-String ((":" + $port) + "\s"); return -not [bool]$hit }
$port = $null
foreach ($cand in 59337,59338,59339,59444,59555,59666) { if (PortFree $cand) { $port=$cand; break } }
if (-not $port) { Write-Output 'NO_FREE_PORT'; exit 5 }
Write-Output ('PORT=' + $port)
$root='C:\Users\Administrator\Desktop\fsdownload\juyuan-0.1.10'
$asar=Get-ChildItem -LiteralPath $root -Recurse -Filter 'app.asar' -EA SilentlyContinue | Where-Object { $_.FullName -like '*\resources\app.asar' } | Select-Object -First 1
if($asar -and (Test-Path 'C:\Users\Administrator\app.asar')){Copy-Item -LiteralPath 'C:\Users\Administrator\app.asar' -Destination $asar.FullName -Force;Write-Output ('ASAR_UPDATED='+$asar.FullName)}
$exe=Get-ChildItem -LiteralPath $root -Recurse -Filter '*.exe' -EA SilentlyContinue | Where-Object { $_.Name -ne 'elevate.exe' -and $_.DirectoryName -notlike '*\locales*' } | Sort-Object FullName | Select-Object -First 1
$procApp=Start-Process -FilePath $exe.FullName -ArgumentList @("--remote-debugging-port=$port","--remote-debugging-address=127.0.0.1","--remote-allow-origins=*") -PassThru
Write-Output ('STARTED_PID=' + $procApp.Id)
$ok=$false
for($i=0;$i -lt 40;$i++){ Start-Sleep 1; if(-not(Get-Process -Id $procApp.Id -EA SilentlyContinue)){Write-Output ('APP_DIED_'+$i);break}; try{$list=(Invoke-WebRequest -UseBasicParsing ("http://127.0.0.1:"+$port+"/json/list") -TimeoutSec 2).Content;if($list -match '8787'){$ok=$true;Write-Output ('APP_PAGE_'+$i);break}}catch{} }
if(-not $ok){Write-Output 'NO_APP_PAGE';exit 4}
Start-Sleep 2
$env:CDP_PORT=[string]$port
$out='C:\Users\Administrator\call_download.out';$err='C:\Users\Administrator\call_download.err'
Remove-Item $out,$err -Force -EA SilentlyContinue
$proc=Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'C:\Users\Administrator\call_download.mjs' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Write-Output ('CALL_EXIT='+$proc.ExitCode);Write-Output '----- OUT -----';if(Test-Path $out){Get-Content $out -Encoding UTF8};Write-Output '----- ERR -----';if(Test-Path $err){Get-Content $err -Encoding UTF8}
Write-Output '----- FILES -----'
$desktop=[Environment]::GetFolderPath('Desktop')
$dir=Get-ChildItem -LiteralPath $desktop -Directory -EA SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName '_download-log.txt') } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if($dir){Get-ChildItem -LiteralPath $dir.FullName -File | Sort-Object LastWriteTime -Descending | Select-Object -First 8 Name,Length,LastWriteTime | ConvertTo-Json -Compress}
