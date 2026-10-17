# Brief 07: demo app and bench (scenarios + experiment runner)

You own `demo-app/` and `bench/`. Read `CONTRACTS.md` and `shared/src/contracts.ts`. Write the scenarios **before** looking at how Hive detects conflicts, and include no-conflict controls. Do this brief first: briefs 01, 02, 04 use `demo-app` as fixtures.

## Part 1: demo app (`demo-app/`), target 30 minutes

TypeScript checkout module, integer cents everywhere, vitest tests. Keep it small and readable (it is shown on stage).

- `src/types.ts`: `Item { sku: string; priceCents: number; qty: number }`, `Promo { code: string; kind: "percent" | "fixed"; value: number }`.
- `src/discount.ts`: `applyDiscount(subtotalCents, promo?)` percent or fixed, never below 0.
- `src/checkout.ts`: `subtotal(items)`, `calculateTotal(items, promo?)` = subtotal minus discount, **no tax**.
- `src/tax.ts`: `TAX_RATES` (CA 0.0725, NY 0.04, TX 0.0625, OR 0), `applyTax(totalCents, state)` = round(total × (1 + rate)).
- `src/format.ts`: `formatPrice(cents)` → `"$12.34"`.
- `src/order.ts`: `orderSummary(items, promo, state)` uses `calculateTotal`, `applyTax`, `formatPrice`.
- `test/*.test.ts`: 12–20 tests covering each function and `orderSummary` end to end.
- `package.json`: devDependencies `vitest`, `typescript`; `npm test` green.

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
  "injection": { "agentId": "agent-andrii", "delayMs": 20000 },
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

For each scenario verify by hand (write the reference solutions in `bench/reference/<id>/a.patch`, `b.patch`, `combined.patch`) that: each patch alone keeps the original suite green, a+b combined applies cleanly with `git apply` and fails the suite plus extraTests (for conflict scenarios), and `combined.patch` (the correct merge) passes. Add `bench/test/scenarios.test.ts` that checks these properties automatically with a local temp dir.

## Part 3: experiment runner (`bench/src/run.ts`), target 60 minutes

CLI: `npm run bench -w @hive/bench -- --scenarios s01,s02 --variants hive,naive,isolated --repeats 2 --parallel 3 --server http://localhost:4317`.

For each (scenario, variant, repeat), sequentially per server (one server = one run; to parallelize, start several servers on ports 4317+k with `PORT` env, document it):
1. `POST /api/reset { mode }` with the scenario's base files.
2. `POST /api/agents` for both agents; start the second after `injection.delayMs` if `injection.agentId` is the first, so their work overlaps in time.
3. Wait until both agents are `done|stopped|budget` (poll `/api/state`, timeout 15 min).
4. Isolated variant: `POST /api/merge`.
5. Add `extraTests`, run the suite via `run_command`-equivalent endpoint (or `POST /api/test` if brief 03 adds it; otherwise run locally on `GET /api/state` files with LocalRunner logic).
6. Record a row: scenario, variant, repeat, success, tests passed/failed, toolCalls, tokens in/out, wall ms, briefings sent, acks adapted, conflicts caught before code, culprit searches, culprit correct (compare to scenario's known culprit pair).
Write `results/results.csv` and `results/summary.md` (success rate per variant, mean tokens, mean time, false alarms on controls).

## Tests (all required)

1. Demo app suite green.
2. Scenario JSON files validate against a TypeScript type + runtime check.
3. `scenarios.test.ts` properties for every scenario (as above).
4. Bench runner unit test with a fake server (mock fetch) produces a correct CSV row.
5. Summary aggregation math.

## Done

Demo app green within 30 minutes (others depend on it). Scenarios with verified reference patches next. Runner last.
