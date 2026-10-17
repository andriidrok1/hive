# Brief 07: demo app and bench (scenarios + experiment runner)

You own `demo-app/` and `bench/`. Read `CONTRACTS.md` and `shared/src/contracts.ts`. Write the scenarios **before** looking at how Hive detects conflicts, and include no-conflict controls. Do this brief first: briefs 01, 02, 04 use `demo-app` as fixtures.

## Part 1: demo app (`demo-app/`), target 30 minutes

TypeScript checkout module, integer cents everywhere, vitest tests. Keep it small and readable (it is shown on stage).

- `src/types.ts`: `Item { sku: string; priceCents: number; qty: number }`, `Promo { code: string; kind: "percent" | "fixed"; value: number }`.
- `src/discount.ts`: `applyDiscount(subtotalCents, promo?)` percent or fixed, never below 0.
- `src/checkout.ts`: `subtotal(items)`, `calculateTotal(items, promo?)` = subtotal minus discount, **no tax**.
- `src/tax.ts`: `TAX_RATES` (CA 0.0725, NY 0.04, TX 0.0625, OR 0), `applyTax(totalCents, state)` = round(total × (1 + rate)).
- `src/format.ts`: `formatPrice(cents)` → `"$12.34"`.
- `src/order.ts`: `orderSummary(items, promo)` returns `{ subtotal, discount, total, lines: string[] }` using `calculateTotal` and `formatPrice` only. **It does not apply tax in the base project** (several scenarios have one agent add tax handling to it, and the other agent change `calculateTotal`; if the base already combined them, both agents would need to touch `order.ts` and the merge would not be clean).
- `test/*.test.ts`: 12–20 tests covering each function and `orderSummary` end to end. Tests import sources with the `.js` extension (`import { calculateTotal } from "../src/checkout.js"`), NodeNext requires it.
- `package.json` is set (do not edit; `vitest` comes from the root). `npm test -w @hive/demo-app` green.
- Keep `demo-app` free of a `vitest.config.*` and of `node_modules`: the runner copies its files elsewhere.

`bench/package.json` already has the `bench` script (`tsx src/run.ts`). Do not edit package files.

## Part 2: scenarios (`bench/scenarios/*.json`), target 45 minutes

Each scenario = two agents with tasks that are individually reasonable, whose edits merge cleanly as text, but whose combination fails tests (unless it is a control). Format:

```json
{
  "id": "s01-double-tax",
  "title": "Tax added twice",
  "conflict": true,
  "agents": [
    { "agentId": "agent-andrii", "humanId": "andrii", "task": "Make calculateTotal return the final price the customer pays, including state tax. Add a state parameter." },
    { "agentId": "agent-masha", "humanId": "masha", "task": "Add an orderSummary line showing tax separately: tax = applyTax(calculateTotal(...)) - calculateTotal(...)." }
  ],
  "startDelaysMs": { "agent-andrii": 0, "agent-masha": 20000 },
  "expectedCulprits": ["agent-andrii", "agent-masha"],
  "acceptance": "npm test",
  "extraTests": "test/s01.accept.test.ts",
  "notes": "Each task alone keeps tests green; together tax is applied twice."
}
```

`extraTests`: a test file added to the project at the end of the run that encodes the intended combined behavior (both tasks done correctly). The run succeeds only if the full suite plus extraTests is green.

Write 6 conflict scenarios and 2 controls:
1. s01 double tax (above).
2. s02 rename: one agent renames `formatPrice` → `formatCents` and updates call sites; the other adds a new `receiptLine` that calls `formatPrice`.
3. s03 units: one changes `applyDiscount` `fixed` promos to take dollars instead of cents; the other adds a `WELCOME5` fixed promo in cents.
4. s04 rounding: one rounds in `calculateTotal`, the other adds rounding in `applyTax` for totals with fractional cents from percent promos (double rounding → off by one cent in an extraTest).
5. s05 signature: one adds a required `currency` param to `formatPrice`; the other adds a `formatPrice` call in `order.ts`.
6. s06 semantic: one changes `subtotal` to skip items with `qty <= 0`; the other adds refunds as negative qty lines.
7. c01 control: one adds `TAX_RATES.WA`, the other adds a `percent` promo validation. No conflict.
8. c02 control: one improves `formatPrice` for negative values, the other adds an `itemCount(items)` helper. No conflict.

Important: an agent that changes a function's behavior also updates that function's existing tests (a real agent would). So each reference patch (`a.patch`, `b.patch`) includes its own test updates and new tests, and "alone green" means the suite as modified by that patch. The combination fails because each side's tests and code assume the other side's old behavior (for s01: A's change makes `calculateTotal` include tax and updates its tests; B's new `orderSummary` tax line and its test assume `calculateTotal` has no tax, so together B's test fails and the extraTest fails).

Design rule: `a.patch` and `b.patch` must touch **disjoint files** (or at least disjoint hunks far apart), otherwise "merges cleanly as text" is not guaranteed. The conflict must be semantic (behavior, units, names), never a textual overlap.

For each scenario verify by hand (write the reference solutions in `bench/reference/<id>/a.patch`, `b.patch`, `combined.patch`) that: each patch alone keeps the suite (as modified by that patch) green, a+b combined applies cleanly with `git apply` and fails the suite plus extraTests (for conflict scenarios), and `combined.patch` (the correct merge) passes. Add `bench/test/scenarios.test.ts` that checks these properties automatically. The temp dir for each check must live under `<repoRoot>/.hive/bench/<id>/` (gitignored), not `/tmp`: npm workspaces hoist `vitest` to the root `node_modules`, and a copy outside the repo cannot resolve it. Run vitest as `<repoRoot>/node_modules/.bin/vitest run --root <dir> --reporter=json --outputFile=<absolute path>`.

## Part 3: experiment runner (`bench/src/run.ts`), target 60 minutes

CLI: `npm run bench -w @hive/bench -- --scenarios s01,s02 --variants hive,naive,isolated --repeats 2 --parallel 3 --server http://localhost:4317`.

For each (scenario, variant, repeat), sequentially per server (one server = one run; to parallelize, start several servers on ports 4317+k with `PORT` env, document it):
1. `POST /api/reset { mode }` (the base project is always `demo-app`).
2. `POST /api/agents` for each agent after its `startDelaysMs`, so their work overlaps in time (the second agent starts while the first is mid-task).
3. Wait until both agents are `done|stopped|budget` (poll `/api/state` every 3s, timeout 15 min).
4. Isolated variant: `POST /api/merge`.
5. `POST /api/test { extraFiles: { [extraTests path]: content } }`.
6. Record a row: scenario, variant, repeat, success, tests passed/failed, toolCalls, tokens in/out, wall ms, briefings sent, acks adapted, conflicts caught before code, culprit searches, culprit correct (the `culprit_found` report's owners equal `expectedCulprits`). Counters come from a `/ws/feed` subscription opened **before** `POST /api/agents` and kept for the whole run (`/api/state.recentEvents` is only a 200-event tail). Token and tool-call counts come from `llm_call` and `agent_status` events.
Write `results/results.csv` and `results/summary.md` (success rate per variant, mean tokens, mean time, false alarms on controls).

## Priority if time runs out

Must: demo app; s01 and c01 with verified reference patches; `scenarios.test.ts` for scenarios that have a `reference/` folder; runner for one variant sequentially with CSV. Optional: the other six scenarios' reference patches (ship the JSON and extraTests anyway), `summary.md`, parallel servers.

## Tests (all required)

1. Demo app suite green.
2. Scenario JSON files validate against a TypeScript type + runtime check.
3. `scenarios.test.ts` properties for every scenario (as above).
4. Bench runner unit test with a fake server (mock fetch) produces a correct CSV row.
5. Summary aggregation math.

## Done

Demo app green within 30 minutes (others depend on it). Scenarios with verified reference patches next. Runner last.
