#!/bin/sh
# Stage demo. Step 1 (run 10–15 s before walking up): reset the project and start Alex's agent.
# Step 2 (live, from the web UI "Start agent"): agentId agent-andrii, human andrii, task = ANDRII_TASK below.
# Usage: sh scripts/demo-stage.sh            # reset + start Alex
#        sh scripts/demo-stage.sh andrii     # start Andrii's agent from the terminal instead of the UI
set -e
BASE=${HIVE_URL:-http://localhost:4317}
MODE=${HIVE_MODE:-hive}

ALEX_TASK='In src/order.ts add an exported function receipt(items, promo?) that returns a single string: the lines of orderSummary(items, promo) joined with "\n", with an extra first line "Items: N" where N is the total quantity. Add tests for it in test/order.test.ts (with and without a promo). You own the new function receipt and its tests; do not change orderSummary itself.'
ANDRII_TASK='In src/order.ts add an exported helper discountLine(subtotalCents, promo?) that returns the string "Discount -$x.xx" for a promo (use applyDiscount and formatPrice) or null when there is no promo, and make orderSummary use it for its Discount line instead of formatting inline. Add tests for discountLine in test/order.test.ts. You own discountLine and orderSummary.'

post() {
  python3 -I - "$BASE" "$1" "$2" "$3" <<'EOF'
import json, sys, urllib.request
base, agent, human, task = sys.argv[1:5]
req = urllib.request.Request(base + "/api/agents", data=json.dumps({"agentId": agent, "humanId": human, "task": task}).encode(), headers={"Content-Type": "application/json"})
print(agent, urllib.request.urlopen(req, timeout=10).read().decode())
EOF
}

if [ "$1" = "andrii" ]; then
  post agent-andrii andrii "$ANDRII_TASK"
  exit 0
fi

curl -s -X POST "$BASE/api/reset" -H 'Content-Type: application/json' -d "{\"mode\":\"$MODE\"}" >/dev/null
post agent-alex alex "$ALEX_TASK"
echo
echo "Now walk up. In the UI: open src/order.ts (Alex's intent shows there), then Start agent:"
echo "  agentId: agent-andrii   human: andrii"
echo "  task: $ANDRII_TASK"
