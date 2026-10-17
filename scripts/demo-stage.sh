#!/bin/sh
# Stage demo (3 agents). Step 1 (run 10–15 s before walking up): reset the project and start Alex's agent.
# Step 2 (live, from the web UI "Start agent"): agentId agent-andrii, human andrii, task = ANDRII_TASK below.
# Usage: sh scripts/demo-stage.sh            # reset + start Alex
#        sh scripts/demo-stage.sh andrii     # start Andrii's agent from the terminal instead of the UI
set -e
BASE=${HIVE_URL:-http://localhost:4317}
MODE=${HIVE_MODE:-hive}

ALEX_TASK='In src/order.ts add two exported functions and tests for both in test/order.test.ts. (1) receipt(items, promo?) returns one string: the lines of orderSummary(items, promo) joined with "\n", with an extra first line "Items: N" where N is the total quantity. (2) receiptWidth(items, promo?) returns the length of the longest line of receipt(items, promo). Cover: empty cart, one item without promo, two items with a percent promo. You own the new functions receipt and receiptWidth and their tests; do not change orderSummary itself.'
NIKA_TASK='In src/order.ts add two exported functions: taxLine(totalCents, state) that returns the string "Tax $x.xx" where the tax is applyTax(totalCents, state) - totalCents (import applyTax from ./tax.js), and orderSummaryWithTax(items, promo, state) that calls orderSummary(items, promo), appends the tax line before the Total line, and returns the summary with total including tax. Add tests for both in test/order.test.ts (CA and OR). You own taxLine and orderSummaryWithTax and their tests; do not change orderSummary itself.'
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
sleep 3
post agent-nika nika "$NIKA_TASK"
echo
echo "Now walk up. In the UI: open src/order.ts (Alex's intent shows there), then Start agent:"
echo "  agentId: agent-andrii   human: andrii"
echo "  task: $ANDRII_TASK"
