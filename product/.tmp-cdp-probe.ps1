$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.UseProxy = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(5)
foreach ($path in @('/json/version','/json')) {
  try {
    $text = $client.GetStringAsync('http://127.0.0.1:59336' + $path).GetAwaiter().GetResult()
    Write-Output ('PATH=' + $path)
    Write-Output $text
  } catch {
    Write-Output ('ERROR=' + $path + ' ' + $_.Exception.Message)
  }
}
