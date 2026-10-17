# Brief 02: coordination (symbols, call graph, intents, briefings, mailbox, LLM)

You own `server/src/coord/` and `server/test/coord/`. Read `CONTRACTS.md` and `shared/src/contracts.ts` first. You may import types from `server/src/core/` (brief 01) but must not edit it; until it exists, code against the interfaces in `CONTRACTS.md` and use tiny local fakes in tests. Do not edit any `package.json`: dependencies (`typescript` for the compiler API, `diff`, `vitest`) are pre-installed, run `npm ci` at the worktree root. The LLM adapter uses plain `fetch` (no SDK) so it has no extra dependency.

## Goal

Everything that decides who needs to know what: TypeScript symbol and call analysis, the intent registry with conflict checks, briefing generation and queue, change watching, the agent mailbox, and the LLM adapter.

## Files

- `analyze.ts`: `analyzeFile(path, content)` using the TypeScript compiler API (`ts.createSourceFile`, walk top-level declarations and `CallExpression`s). Symbols: top-level functions, classes, exported consts, types, interfaces, with 1-based line ranges. Calls: identifier callee name, line, enclosing top-level symbol.
- `CallGraph.ts`: `update(files)` re-analyzes changed files (cache by content hash); `callersOf(symbol)`; `symbolAt(path, line)`.
- `BriefingQueue.ts`: ids `br_<n>`; `takeUndelivered` returns and marks delivered; `unackedRequired` returns delivered-or-not briefings with `requiresAck` and no `ack`; `ack` validates ownership.
- `IntentRegistry.ts`: see CONTRACTS. Ids per agent: first letter of the agent name after `agent-`, uppercased, plus counter (`agent-andrii` → `A1`, `A2`; collisions get `A`, `AA`... keep it simple and deterministic).
- `ChangeWatcher.ts`: given a change from `ProjectStore.onChange`, compute changed symbols (compare `analyzeFile` before/after: signature text, body text, removed, renamed if one removed + one added with similar body), ask the LLM for a one-line meaning (`<= 160 chars`), find affected agents (readers of the changed symbol at an older rev, callers' owners via `ReadLog` + `CallGraph`, agents whose active intents target a caller), and push `symbol_changed` briefings with `yourUsages` and a trimmed diff. Skip whitespace/comment-only changes. Never brief the actor about their own change.
- `Mailbox.ts`: threads by root message id; exchange counter; 4th exchange → `EXCHANGE_LIMIT` and the thread appears in `forHumans()`. Delivers messages as `message` briefings (requiresAck false).
- `llm.ts`: `OpenAILLM` (Chat Completions, `response_format: { type: "json_object" }`, model from ctor, `reasoning_effort: "low"`, 20s timeout, 1 retry on invalid JSON, reports timing via an optional callback) and `FakeLLM`.
- `index.ts` re-exports.

## Intent checks (in `declare`)

Order:
1. Validate: `what` 5..200 chars, `output` 10..300 chars and not vague (reject outputs equal to or containing only words like "works", "done", "fixed", "updated" → throw a `BAD_ARGS` error the API maps to a tool error).
2. Mode `naive` or `isolated`: approve immediately, no briefings.
3. Same target: another active intent (`approved|in_progress`) on the same `file+symbol` by another agent → conflict `same_target`.
4. Contradiction: collect active intents of other agents whose target is the same symbol, a caller of it, or a callee of it (via CallGraph), plus finished `verified` intents on those symbols (their outputs are standing contracts). If any, one LLM call with system prompt "You check if promised behaviors contradict. Answer JSON {conflict: boolean, with: string[], reason: string}." Conflict → `contradiction`.
5. Status `conflict` if any conflict, else `approved`. Both agents involved get an `intent_conflict` briefing (requiresAck true) on conflict.
6. Dependents: readers of the target symbol + owners of active intents on callers. Each gets an `intent_declared` briefing (requiresAck true) with the promised output.
7. Emit `intent_declared`.

`humanEditOutput`: update output, push `contract_changed` (requiresAck true) to the intent owner and dependents, emit `human_action`.

## Tests (all required, no network: use FakeLLM)

1. `analyzeFile` on a fixture with `calculateTotal`, `applyTax` (calls `calculateTotal`), `formatPrice`, a type and an interface → correct names, kinds, line ranges, exported flags.
2. Calls: `applyTax` calling `calculateTotal` is found with caller `applyTax`; calls inside nested arrow functions attribute to the top-level symbol.
3. `CallGraph.callersOf("calculateTotal")` across two files.
4. `BriefingQueue`: push → takeUndelivered returns it once; second call empty; unackedRequired until ack; ack by the wrong agent fails.
5. Intent ids: `agent-andrii` gets `A1`, `A2`; `agent-masha` gets `M1`.
6. Vague output rejected; good intent approved when nothing else is active.
7. Same-target conflict between two agents.
8. Contradiction: A declares `calculateTotal` output "returns total WITH tax included"; B has active intent on `applyTax` "multiplies calculateTotal() by tax rate"; FakeLLM returns conflict → both get `intent_conflict`, status conflict.
9. No contradiction when FakeLLM says false → approved.
10. Dependents: agent B read `calculateTotal` at rev 2; A declares a change to it → B gets `intent_declared` with requiresAck.
11. `canEdit`: wrong owner, not approved, unknown id; ok for `approved` and `in_progress`.
11b. Re-approval: A and B conflict (`same_target`); `setStatus(A, "cancelled")` → B becomes `approved` and an `intent_status` event is emitted. Same when A goes `done`. If B also conflicts with a still-active C, B stays `conflict`.
11c. `Mailbox` constructed with `{ briefings, onEvent }` delivers each message as a `message` briefing to the recipient and emits `message_sent`.
12. ChangeWatcher: rename `calculateTotal` → `calcTotal` by A; B read it earlier and calls it → B gets `symbol_changed` with `yourUsages` pointing at the call line; A gets nothing.
13. ChangeWatcher ignores a comment-only change.
14. Mailbox: 3 exchanges ok, 4th → `EXCHANGE_LIMIT`, thread in `forHumans()`.
15. `naive` mode: declare approves, no briefings.
16. `OpenAILLM` is tested only with a mocked `fetch` (valid JSON, invalid then valid JSON retry).

## Done

`npm test -w @hive/server -- coord` and typecheck pass. First version (tests 1–7) within 30–40 minutes.
