# cdp.ps1 - Evaluate a JS expression inside LogLens's WebView2 page over CDP.
# ASCII-only on purpose: Windows PowerShell 5.1 decodes BOM-less files as ANSI,
# which corrupts non-ASCII text and breaks parsing on zh-CN systems.
param(
  [string]$Expr = '',
  [int]$Port = 9222,
  [string]$JsFile = ''
)

if ($JsFile) { $Expr = [System.IO.File]::ReadAllText($JsFile) }
if (-not $Expr) { throw 'provide -Expr or -JsFile' }

$ErrorActionPreference = 'Stop'

$targets = Invoke-RestMethod "http://127.0.0.1:$Port/json"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -match 'tauri' } | Select-Object -First 1
if (-not $page) { $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1 }
if (-not $page) { throw 'no page target found' }

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).GetAwaiter().GetResult()

function Send-Cdp($id, $method, $params) {
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 10
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
}

function Read-Cdp($wantId) {
  while ($true) {
    $buf = New-Object byte[] 1048576
    $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
    $res = $ws.ReceiveAsync($seg, $ct).GetAwaiter().GetResult()
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
    $obj = $text | ConvertFrom-Json
    if ($obj.id -eq $wantId) { return $obj }
  }
}

$id = 1
Send-Cdp $id 'Runtime.evaluate' @{
  expression    = $Expr
  returnByValue = $true
  awaitPromise  = $true
}
$r = Read-Cdp $id
$ws.Dispose()

if ($r.result.exceptionDetails) {
  'EXCEPTION: ' + ($r.result.exceptionDetails | ConvertTo-Json -Compress -Depth 6)
  exit 1
}
$r.result.result.value
