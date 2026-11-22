## CDP 截图脚本（每个截图一个全新浏览器会话）
## 为什么不用一个长会话连拍：实测长会话里连续 Page.navigate 会复现"页面不渲染"，
## 每张单开一个浏览器则稳定。慢一点，但结果可信。
## 为什么不用 --window-size：headless 有约 500px 最小宽度，390px 手机视口会被
## 悄悄改写（实测 innerWidth 变成 500），必须用 Emulation.setDeviceMetricsOverride。
param(
  [string]$Root = "C:\Users\Administrator\Documents\deepseek-harness\default-workspace\drift-town\prototype\dive"
)
$ErrorActionPreference = 'Continue'
$chrome = "C:\Users\Administrator\AppData\Local\Google\Chrome\Application\chrome.exe"
$shots = Join-Path $Root "shots"
New-Item -ItemType Directory -Force -Path $shots | Out-Null

$jobs = @(
  @{ name='p-title';    w=390; h=844; shot='title' },
  @{ name='p-shallow';  w=390; h=844; shot='shallow' },
  @{ name='p-mid';      w=390; h=844; shot='mid' },
  @{ name='p-deep';     w=390; h=844; shot='deep' },
  @{ name='p-resist';   w=390; h=844; shot='resist' },
  @{ name='p-transit';  w=390; h=844; shot='transit' },
  @{ name='p-settled';  w=390; h=844; shot='settled' },
  @{ name='p-blackout'; w=390; h=844; shot='blackout' },
  @{ name='l-title';    w=844; h=390; shot='title' },
  @{ name='l-mid';      w=844; h=390; shot='mid' },
  @{ name='l-deep';     w=844; h=390; shot='deep' }
)

$basePort = 9400
$idx = 0
foreach ($j in $jobs) {
  $idx++
  $port = $basePort + $idx
  $profile = Join-Path $env:TEMP ("cdp-" + [guid]::NewGuid().ToString("N").Substring(0,8))
  $proc = Start-Process -FilePath $chrome -ArgumentList @(
    '--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars',
    "--user-data-dir=$profile","--remote-debugging-port=$port"
  ) -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $env:TEMP "cso$idx.txt") `
    -RedirectStandardError (Join-Path $env:TEMP "cse$idx.txt")

  $wsUrl = $null
  for ($i=0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 200
    try {
      $tabs = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 2
      $t = $tabs | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
      if ($t) { $wsUrl = $t.webSocketDebuggerUrl; break }
    } catch { }
  }
  if (-not $wsUrl) { Write-Host ("FAIL(no devtools) " + $j.name); continue }

  try {
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $cts = New-Object System.Threading.CancellationTokenSource
    $ws.ConnectAsync([Uri]$wsUrl, $cts.Token).Wait()
    $script:msgId = 0

    function Send-Cdp2 {
      param($Sock, $Token, [string]$Method, [hashtable]$Params = @{})
      $script:msgId++
      $id = $script:msgId
      $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 12 -Compress
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
      $Sock.SendAsync((New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)),
        [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Token).Wait()
      $buf = New-Object byte[] 8388608
      for ($k=0; $k -lt 5000; $k++) {
        $sb = New-Object System.Text.StringBuilder
        do {
          $r = $Sock.ReceiveAsync((New-Object System.ArraySegment[byte] -ArgumentList @(,$buf)), $Token).Result
          [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
        } while (-not $r.EndOfMessage)
        try { $obj = $sb.ToString() | ConvertFrom-Json } catch { continue }
        if ($obj.id -eq $id) { return $obj }
      }
      return $null
    }

    [void](Send-Cdp2 $ws $cts.Token 'Page.enable')
    [void](Send-Cdp2 $ws $cts.Token 'Runtime.enable')
    [void](Send-Cdp2 $ws $cts.Token 'Emulation.setDeviceMetricsOverride' @{
      width = $j.w; height = $j.h; deviceScaleFactor = 2; mobile = $true
    })
    $url = "file:///" + ($Root -replace '\\','/') + "/index.html?shot=$($j.shot)"
    [void](Send-Cdp2 $ws $cts.Token 'Page.navigate' @{ url = $url })
    Start-Sleep -Milliseconds 2600

    $chk = Send-Cdp2 $ws $cts.Token 'Runtime.evaluate' @{
      expression = 'document.querySelectorAll("canvas").length>0 && typeof window.__diveState==="function"'
      returnByValue = $true
    }
    $ready = $false
    if ($chk -and $chk.result -and $chk.result.result) { $ready = [bool]$chk.result.result.value }

    $png = Join-Path $shots ($j.name + '.png')
    $res = Send-Cdp2 $ws $cts.Token 'Page.captureScreenshot' @{ format='png' }
    if ($res -and $res.result -and $res.result.data) {
      [System.IO.File]::WriteAllBytes($png, [System.Convert]::FromBase64String($res.result.data))
      $mark = if ($ready) { 'ready' } else { 'NOT-READY' }
      Write-Host ("OK   {0,-12} {1,4}x{2,-4} {3,8} bytes  {4}" -f $j.name, $j.w, $j.h, (Get-Item $png).Length, $mark)
    } else {
      Write-Host ("FAIL(capture) " + $j.name)
    }
    $ws.Dispose()
  } catch {
    Write-Host ("FAIL(exception) " + $j.name + " : " + $_.Exception.Message)
  }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
}
Write-Host "done"
