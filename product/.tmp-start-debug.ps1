$ErrorActionPreference = 'Stop'
$root = 'C:\Users\Administrator\Desktop\fsdownload\juyuan-0.1.10'
$exe = Get-ChildItem -LiteralPath $root -Recurse -File -Filter '*.exe' | Where-Object {
  Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources\app.asar')
} | Select-Object -First 1 -ExpandProperty FullName
if (-not $exe) { throw 'Packaged app executable not found' }
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$proc = Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=59336','--remote-allow-origins=*' -PassThru
Write-Output ("EXE=" + $exe)
Write-Output ("STARTED_PID=" + $proc.Id)
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  $listener = Get-NetTCPConnection -State Listen -LocalPort 59336 -ErrorAction SilentlyContinue
  if ($listener) {
    Write-Output 'CDP_READY=59336'
    exit 0
  }
}
throw 'CDP did not start'
