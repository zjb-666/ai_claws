$ErrorActionPreference='Continue'
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($_.ExecutablePath -like '*juyuan-0.1.10*')
} | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Seconds 2
function PortFree($port) {
  $hit = netstat -ano | Select-String ((":" + $port) + "\s")
  return -not [bool]$hit
}
$port = $null
foreach ($cand in 59337,59338,59339,59444,59555,59666) {
  if (PortFree $cand) { $port = $cand; break }
}
if (-not $port) { Write-Output 'NO_FREE_PORT'; exit 5 }
Write-Output ('PORT=' + $port)
$root = 'C:\Users\Administrator\Desktop\fsdownload\juyuan-0.1.10'
$exe = Get-ChildItem -LiteralPath $root -Recurse -Filter '*.exe' -EA SilentlyContinue |
  Where-Object { $_.Name -ne 'elevate.exe' -and $_.DirectoryName -notlike '*\locales*' } |
  Sort-Object FullName | Select-Object -First 1
$arg = @("--remote-debugging-port=$port","--remote-debugging-address=127.0.0.1","--remote-allow-origins=*")
$procApp = Start-Process -FilePath $exe.FullName -ArgumentList $arg -PassThru
Write-Output ('STARTED_PID=' + $procApp.Id)
$ok=$false
for ($i=0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  if (-not (Get-Process -Id $procApp.Id -EA SilentlyContinue)) { Write-Output ('APP_DIED_'+$i); break }
  try {
    $list = (Invoke-WebRequest -UseBasicParsing ("http://127.0.0.1:"+$port+"/json/list") -TimeoutSec 2).Content
    if ($list -match '8787') { $ok=$true; Write-Output ('APP_PAGE_'+$i); break }
  } catch {}
}
if (-not $ok) { Write-Output 'NO_APP_PAGE'; exit 4 }
Start-Sleep -Seconds 2
$env:CDP_PORT = [string]$port
$out = 'C:\Users\Administrator\call_scrape.out'
$err = 'C:\Users\Administrator\call_scrape.err'
Remove-Item $out,$err -Force -EA SilentlyContinue
$proc = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'C:\Users\Administrator\call_scrape.mjs' -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
Write-Output ('CALL_EXIT=' + $proc.ExitCode)
Write-Output '----- OUT -----'
if (Test-Path $out) { Get-Content $out -Encoding UTF8 }
Write-Output '----- ERR -----'
if (Test-Path $err) { Get-Content $err -Encoding UTF8 }
Write-Output '----- APP ALIVE -----'
Write-Output ('parent=' + [bool](Get-Process -Id $procApp.Id -EA SilentlyContinue))
