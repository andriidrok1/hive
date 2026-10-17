#!/bin/sh
# Live demo: reset the project and start both s01 agents at the same moment so their work overlaps.
# Usage: sh scripts/demo-run.sh [mode]   (mode: hive | naive | isolated, default hive)
set -e
MODE=${1:-hive}
BASE=${HIVE_URL:-http://localhost:4317}
curl -s -X POST "$BASE/api/reset" -H 'Content-Type: application/json' -d "{\"mode\":\"$MODE\"}" >/dev/null
python3 -I - "$BASE" <<'EOF'
import json, sys, urllib.request
base = sys.argv[1]
s = json.load(open("bench/scenarios/s01-double-tax.json"))
for a in s["agents"]:
    body = json.dumps({"agentId": a["agentId"], "humanId": a["humanId"], "task": a["task"]}).encode()
    req = urllib.request.Request(base + "/api/agents", data=body, headers={"Content-Type": "application/json"})
    print("started", a["agentId"], urllib.request.urlopen(req, timeout=10).read().decode())
EOF
echo "watch: node scripts/watch-feed.mjs $BASE .hive/feed.log"
