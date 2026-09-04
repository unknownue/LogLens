# e2e-cdp-check.ps1 — 通过 WebView2 CDP 校验 LogLens 表格视图 DOM
param(
  [int]$Port = 9222,
  [string]$Expr = "JSON.stringify({tab: document.querySelector('.tab-title')?.textContent, head: !!document.querySelector('.cfg-head'), name: document.querySelector('.cfg-name')?.textContent, lang: document.querySelector('.cfg-lang')?.textContent, count: document.querySelector('.cfg-count')?.textContent, cells: document.querySelectorAll('.cfg-cell').length, firstRowKey: document.querySelector('.cfg-row .cfg-key')?.textContent, headCols: [...document.querySelectorAll('.cfg-head-cell')].map(x=>x.textContent.trim().replace(/\s+.*$/,'')).join('|')})"
)

$ErrorActionPreference = 'Stop'
# 获取页面 target
$targets = Invoke-RestMethod "http://127.0.0.1:$Port/json"
$page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -match 'tauri|localhost' } | Select-Object -First 1
if (-not $page) {
  $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
}
if (-not $page) { throw 'no page target found' }
"target: $($page.url)"

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).GetAwaiter().GetResult()

function Send-Cdp($id, $method, $params) {
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Compress -Depth 8
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
}
function Read-Cdp($wantId) {
  while ($true) {
    $buf = New-Object byte[] 65536
    $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)
    $res = $ws.ReceiveAsync($seg, $ct).GetAwaiter().GetResult()
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $res.Count)
    $obj = $text | ConvertFrom-Json
    if ($obj.id -eq $wantId) { return $obj }
  }
}

$id = 1
Send-Cdp $id 'Runtime.evaluate' @{ expression = $Expr; returnByValue = $true }
$r = Read-Cdp $id
$ws.Dispose()
"eval result:"
$r.result.result.value
