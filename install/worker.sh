#!/bin/sh
# cast-worker installer for Linux/macOS. Served by the hub with __HUB__/__CODE__ filled in.
# Usage:  curl -fsSL "__HUB__/install/worker.sh?code=__CODE__" | sh
set -e
HUB='__HUB__'
CODE='__CODE__'
DIR="$HOME/.local/share/cast-worker"
say() { printf '\033[36m[cast-worker]\033[0m %s\n' "$*"; }

command -v node >/dev/null 2>&1 || { say "需要 Node.js 20+，请先安装 (https://nodejs.org)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { say "Node.js 版本太旧，需要 20+"; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || say "没有找到 ffmpeg：这台 worker 只能共享文件，不能转码（安装 ffmpeg 后重启 worker 即可）"

say "下载 worker 到 $DIR"
mkdir -p "$DIR"
curl -fsSL "$HUB/install/worker.tar" | tar -xf - -C "$DIR"

pkill -f "cast-worker/src/agent.mjs" 2>/dev/null || true
NODE="$(command -v node)"
ARGS="$DIR/src/agent.mjs --config $DIR/worker.json --hub $HUB"

if [ "$(uname)" = "Darwin" ]; then
  PL="$HOME/Library/LaunchAgents/com.casthub.worker.plist"
  mkdir -p "$(dirname "$PL")"
  cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.casthub.worker</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/src/agent.mjs</string><string>--config</string><string>$DIR/worker.json</string><string>--hub</string><string>$HUB</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$DIR/worker.log</string><key>StandardErrorPath</key><string>$DIR/worker.log</string>
</dict></plist>
EOF
  [ -n "$CODE" ] && "$NODE" $ARGS --pair "$CODE" >"$DIR/pair.log" 2>&1 & PAIR=$!
  sleep 12; kill $PAIR 2>/dev/null || true
  launchctl unload "$PL" 2>/dev/null || true
  launchctl load "$PL"
else
  UNIT="$HOME/.config/systemd/user/cast-worker.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=cast-worker (transcode/file worker for cast-hub)
After=network-online.target
[Service]
ExecStart=$NODE $ARGS
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
  [ -n "$CODE" ] && { "$NODE" $ARGS --pair "$CODE" >"$DIR/pair.log" 2>&1 & PAIR=$!; sleep 12; kill $PAIR 2>/dev/null || true; }
  systemctl --user daemon-reload
  systemctl --user enable --now cast-worker.service
  command -v loginctl >/dev/null 2>&1 && loginctl enable-linger "$(id -un)" 2>/dev/null || true
fi
say "完成。回到投屏中心的「Worker」页，就能看到这台机器（$(hostname)）。"
