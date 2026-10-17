# Brief 03: API server (wiring, HTTP tools, WebSockets, agent runs)

You own `server/src/api/`, `server/src/agents/`, `server/src/index.ts`, `server/src/emit.ts`, `server/test/api/`. Read `CONTRACTS.md` and `shared/src/contracts.ts`. Other server folders belong to briefs 01, 02, 04: import their classes, never edit them. Until they land, write thin local stubs **inside your test folder only** that follow the interfaces in CONTRACTS.md, and switch to real imports as soon as they exist. Dependencies in `server/package.json`: `fastify`, `@fastify/websocket`, `@fastify/cors`, `ws`, `y-websocket` (or `@y/websocket-server`, whichever exports `setupWSConnection` for the installed yjs), `dotenv`, `tsx` (dev), `vitest`.

## Goal

One process that holds all state, exposes the agent tool API and the human/UI API from CONTRACTS.md, streams the feed, serves Yjs sync, and runs agent loops in-process.

## Files

- `server/src/emit.ts`: `createEmitter()` → `{ emit(body), recent(), subscribe(cb) }`, monotonic ids, keeps last 200.
- `server/src/api/app.ts`: `buildApp(deps)` returns a Fastify instance (no listen), so tests use `app.inject`.
- `server/src/api/tools.ts`: the 11 tool handlers mapping `ToolArgs` → `ToolResponse`, applying the rules in CONTRACTS.md in order (validation, mode checks, unacked briefings, attach briefings/control/rev, emit).
- `server/src/api/humans.ts`: human/UI routes.
- `server/src/api/ws.ts`: `/ws/feed` broadcast and `/yjs/project` y-websocket bound to `ProjectStore.ydoc`.
- `server/src/agents/AgentManager.ts`: `start({agentId, humanId, task})` runs `runAgent` from `@hive/agent` with a `HiveClient` that calls the tool handlers **directly in-process** (no HTTP hop) and an `AbortController` per agent; `control(agentId, c)`; `note(...)` pushes a `human_note` briefing and, if urgent, aborts the in-flight model call (the loop retries the step with the note). Emits `agent_status`.
- `server/src/hive.ts`: `createHive({ mode, projectDir, runner, llm })` builds ProjectStore, ReadLog, History, CallGraph, BriefingQueue, IntentRegistry, ChangeWatcher, Mailbox, TestOrchestrator, AgentManager, wires `store.onChange` → CallGraph.update + ChangeWatcher + History, and returns them; `reset(mode)` rebuilds.
- `server/src/index.ts`: loads `.env` from the repo root, picks runner (`HIVE_RUNNER`), LLM (`OpenAILLM` if key, else a FakeLLM that always answers no-conflict and echoes a generic meaning, with a console warning), listens on 4317, CORS for 5173. `npm run dev -w @hive/server` → `tsx watch src/index.ts`.

## Isolated mode

`HIVE_MODE=isolated`: each agent gets its own ProjectStore copy (lazy, on first tool call). `POST /api/merge` does a 3-way merge of every agent copy into the main store (line-based, `diff3` via the `node-diff3` package or a simple merge using `diff.applyPatch` of each agent's patch against base; on a textual conflict keep both versions with conflict markers) and runs tests. The bench uses this as the "isolated + merge" baseline.

## Tests (all required, use `app.inject`, FakeLLM, a fake Runner)

1. `GET /api/state` on a fresh hive returns files from the fixture project, rev 0.
2. Tool envelope: `read_file` returns `ok, data.content, briefings: [], control: "run", rev`.
3. `read_file` records a read with the symbols in range (check ReadLog).
4. `edit_region` without intent in `hive` mode → `NO_INTENT`; in `naive` mode → ok.
5. Full happy path: declare_intent → edit_region → finish_intent; feed has `intent_declared`, `edit_applied`, `intent_status`.
6. Briefings ride on the next tool call of the dependent agent, exactly once.
7. `UNACKED_BRIEFINGS` blocks edits until `ack_briefing`.
8. `OLD_TEXT_NOT_FOUND` returns fresh content in `error.current`.
9. `POST /api/agents/:id/control` pause → next tool response has `control: "pause"`.
10. `POST /api/intents/:id/output` → dependents receive `contract_changed`.
11. `/ws/feed`: connect with `ws`, perform a tool call, receive the matching event.
12. `/yjs/project`: a `y-websocket` client (`WebsocketProvider` with `ws` polyfill) sees a file content and its edit after `edit_region`; a client-side Y.Text insert increments server rev.
13. `POST /api/reset` restores initial files and clears intents.
14. Isolated mode: two agents edit different copies; `/api/merge` merges non-overlapping edits.
15. AgentManager with a fake `runAgent` that calls two tools and finishes → `agent_status` events idle→tool→done.

## Done

All tests pass, `npm run dev -w @hive/server` starts and `curl localhost:4317/api/state` works. First version (tests 1–6, server starts) within 45 minutes.
