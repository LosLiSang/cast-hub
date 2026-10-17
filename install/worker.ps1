# cast-worker installer for Windows. Served by the hub with __HUB__/__CODE__ filled in.
# Usage (PowerShell):  irm "__HUB__/install/worker.ps1?code=__CODE__" | iex
$ErrorActionPreference = 'Stop'
$Hub  = '__HUB__'
$Code = '__CODE__'
$Dir  = Join-Path $env:LOCALAPPDATA 'cast-worker'

function Say($m) { Write-Host "[cast-worker] $m" -ForegroundColor Cyan }

# 1. Node.js 20+
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$ok = $false
if ($node) { $v = (& $node -v) -replace '^v',''; $ok = [int]($v.Split('.')[0]) -ge 20 }
if (-not $ok) {
  Say '需要 Node.js 20+，尝试用 winget 安装…'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw '安装 Node.js 失败，请手动安装 https://nodejs.org 后重试' }
}

# 2. ffmpeg (needed to transcode; without it the worker can still share folders)
$ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ff) {
  Say '没有找到 ffmpeg，尝试用 winget 安装 Gyan.FFmpeg…'
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
  if (-not $ff) { Say '仍然没有 ffmpeg：这台 worker 只能共享文件，不能转码' }
}
$fp = if ($ff) { Join-Path (Split-Path $ff) 'ffprobe.exe' } else { '' }

# 3. Worker files
Say "下载 worker 到 $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$tar = Join-Path $env:TEMP 'cast-worker.tar'
Invoke-WebRequest -UseBasicParsing "$Hub/install/worker.tar" -OutFile $tar
# Use Windows' own bsdtar: a GNU tar earlier on PATH (Git Bash) treats "C:" as a remote host.
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
Push-Location $Dir
try { & $tarExe -xf $tar } finally { Pop-Location }
Remove-Item $tar
if (-not (Test-Path (Join-Path $Dir 'src\agent.mjs'))) { throw '解压 worker 失败' }

# 4. Stop an old copy, then start hidden + autostart at login
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*cast-worker*agent.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$argList = @("`"$Dir\src\agent.mjs`"", '--config', "`"$Dir\worker.json`"", '--hub', $Hub)
if ($Code) { $argList += @('--pair', $Code) }
if ($ff)   { $argList += @('--ffmpeg', "`"$ff`"", '--ffprobe', "`"$fp`"") }
$vbs = Join-Path $Dir 'start-worker.vbs'
$runArgs = ($argList | Where-Object { $_ -ne '--pair' -and $_ -ne $Code }) -join ' '
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Dir"
sh.Run """$node"" $($runArgs -replace '"','""')", 0, False
"@ | Set-Content -Encoding ASCII $vbs
$startup = [Environment]::GetFolderPath('Startup')
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'cast-worker.lnk'))
$lnk.TargetPath = 'wscript.exe'; $lnk.Arguments = "`"$vbs`""; $lnk.WorkingDirectory = $Dir; $lnk.Save()

# 5. Allow the hub/TV to reach the worker port on private networks
try {
  if (-not (Get-NetFirewallRule -DisplayName 'cast-worker' -ErrorAction SilentlyContinue)) {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command',"New-NetFirewallRule -DisplayName 'cast-worker' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8791 -Profile Private,Domain | Out-Null"
  }
} catch { Say '没有添加防火墙规则（被取消）。如果投屏中心连不上这台 worker，请放行 TCP 8791' }

# Start now (the pairing code is consumed on first contact and saved as a secret in worker.json).
Say '正在加入投屏中心…'
$cfgFile = Join-Path $Dir 'worker.json'
$p = Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $Dir -WindowStyle Hidden -PassThru
$joined = $false
for ($i = 0; $i -lt 30 -and -not $joined; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path $cfgFile) { $joined = [bool]((Get-Content $cfgFile -Raw | ConvertFrom-Json).secret) }
}
if ($joined) { Say "完成。回到投屏中心的「Worker」页，就能看到这台电脑（$env:COMPUTERNAME）。" }
else { Say "没能加入：配对码可能已过期，或连不上 $Hub。在网页上重新生成配对码后再运行一次。" }
