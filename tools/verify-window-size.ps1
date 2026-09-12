# verify-window-size.ps1 - End-to-end check of LogLens window-size memory.
#
#   restore : pre-seed window-size.json -> launch -> outer rect must match seeded size + frame
#   save    : resize the live window    -> after the 500ms debounce -> json must match the new inner size
#
# Frame: the window is decorations:false, so the OUTER rect is larger than the inner
# (client) size. The frame delta is MEASURED at runtime from the app's own reporting
# in the perf log rather than hardcoded, so this stays correct across DPI settings.
param(
  [string]$Exe = 'E:\Workspace\submodules\LogLens\src-tauri\target\release\LogLens.exe',
  [int]$SettleSeconds = 15
)

$ErrorActionPreference = 'Stop'
$appDir = Join-Path $env:APPDATA 'com.loglens.LogLens'
$jsonPath = Join-Path $appDir 'window-size.json'

Add-Type -Namespace Win -Name Api -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool MoveWindow(System.IntPtr h, int x, int y, int w, int ht, bool repaint);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

function Get-Outer($hwnd) {
  $rc = New-Object Win.Api+RECT
  [void][Win.Api]::GetWindowRect($hwnd, [ref]$rc)
  return @{ W = $rc.Right - $rc.Left; H = $rc.Bottom - $rc.Top; X = $rc.Left; Y = $rc.Top }
}

function Stop-LogLens {
  Get-Process LogLens -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

function Start-LogLens {
  Start-Process -FilePath $Exe | Out-Null
  for ($i = 0; $i -lt ($SettleSeconds * 4); $i++) {
    Start-Sleep -Milliseconds 250
    $proc = Get-Process LogLens -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      Start-Sleep -Seconds 2
      return $proc
    }
  }
  throw 'LogLens did not come up in time'
}

function Seed($json) { Set-Content -Path $jsonPath -Value $json -Encoding ASCII -NoNewline }
function Read-Seed { return (Get-Content -Path $jsonPath -Raw -ErrorAction Stop).Trim() }

$script:failed = 0
function Assert-Equal($label, $actual, $expected) {
  if ("$actual" -eq "$expected") {
    Write-Host ('PASS  ' + $label + '  -> ' + $actual)
  } else {
    Write-Host ('FAIL  ' + $label + '  actual=' + $actual + ' expected=' + $expected)
    $script:failed++
  }
}

New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# ---------- 0) measure the frame delta ----------
Stop-LogLens
Seed '{"width":1000,"height":650}'
$proc = Start-LogLens
$outer = Get-Outer $proc.MainWindowHandle
$frameW = $outer.W - 1000
$frameH = $outer.H - 650
Write-Host ('       frame measured: +' + $frameW + ' x, +' + $frameH + ' y')

# ---------- 1) restore the seeded size ----------
Assert-Equal 'restore seeded 1000x650' ($outer.W.ToString() + 'x' + $outer.H.ToString()) ((1000 + $frameW).ToString() + 'x' + (650 + $frameH).ToString())

# ---------- 2) resize -> saved after debounce ----------
$newW = 1180
$newH = 820
$outerTargetW = $newW + $frameW
$outerTargetH = $newH + $frameH
[void][Win.Api]::MoveWindow($proc.MainWindowHandle, $outer.X, $outer.Y, $outerTargetW, $outerTargetH, $true)
Start-Sleep -Seconds 3
Assert-Equal 'save after resize to inner 1180x820' (Read-Seed) '{"width":1180,"height":820}'

# ---------- 3) the newly saved size comes back on next launch ----------
Stop-LogLens
$proc = Start-LogLens
$outer2 = Get-Outer $proc.MainWindowHandle
Assert-Equal 'restore round-trip 1180x820' ($outer2.W.ToString() + 'x' + $outer2.H.ToString()) ($outerTargetW.ToString() + 'x' + $outerTargetH.ToString())

# ---------- 4) corrupt json -> default, no crash ----------
Stop-LogLens
Seed 'definitely not json'
$proc = Start-LogLens
$outer3 = Get-Outer $proc.MainWindowHandle
Assert-Equal 'corrupt json -> default 800x600' ($outer3.W.ToString() + 'x' + $outer3.H.ToString()) ((800 + $frameW).ToString() + 'x' + (600 + $frameH).ToString())

# ---------- 5) out-of-range size -> default, no crash ----------
Stop-LogLens
Seed '{"width":99999,"height":10}'
$proc = Start-LogLens
$outer4 = Get-Outer $proc.MainWindowHandle
Assert-Equal 'absurd size -> default 800x600' ($outer4.W.ToString() + 'x' + $outer4.H.ToString()) ((800 + $frameW).ToString() + 'x' + (600 + $frameH).ToString())

Stop-LogLens
Write-Host ''
if ($script:failed -eq 0) { Write-Host 'ALL WINDOW-SIZE CHECKS PASSED' } else { Write-Host ('FAILED ' + $script:failed + ' check(s)') }
exit $script:failed
