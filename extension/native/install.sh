#!/bin/bash
# Installs the native messaging host: Wi-Fi name, CPU/memory, and the remote
# actions (microphone volume and input, Wi-Fi join, quit an app).
# Usage: ./install.sh <extension-id>
# The extension id is on chrome://extensions (Developer mode on).

set -euo pipefail

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "usage: ./install.sh <extension-id>"
  echo "Find the id on chrome://extensions, then rerun."
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="$DIR/host.py"
chmod +x "$HOST"

DEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$DEST"

cat > "$DEST/com.setupcheck.host.json" <<JSON
{
  "name": "com.setupcheck.host",
  "description": "Setup Check local helper (Wi-Fi, CPU, audio, remote actions)",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON

echo "Installed: $DEST/com.setupcheck.host.json"
echo
echo "Test it without Chrome:"
echo "  python3 -c 'import json,struct,sys;b=json.dumps({\"cmd\":\"wifi\"}).encode();sys.stdout.buffer.write(struct.pack(\"<I\",len(b))+b)' | \"$HOST\" | python3 -c 'import json,struct,sys;d=sys.stdin.buffer.read();print(json.loads(d[4:]))'"
echo
echo "Then press Reload on the extension card."
