# Hive contracts

Read this before writing any code. The machine-readable source of truth is `shared/src/contracts.ts`. If this file and `contracts.ts` disagree, `contracts.ts` wins.

## Change rule

Nobody changes `shared/`, `CONTRACTS.md`, root `package.json`, root `tsconfig.base.json` or another package's folder. If you need a contract change, stop and write the request at the top of your final report: what, why, which packages it affects. The human owner decides.

## What Hive is (one paragraph)

Each human has their own AI agent; all agents work in one live shared project, like a Google Doc. Code lives only on the Hive server in Yjs documents, so every read returns the latest version. Before editing a symbol an agent declares its intent (what it does, the promised output). Hive checks intents for conflicts before any code exists, tells dependent agents what is about to change, delivers briefings when something an agent read has changed, groups edits into change sets per intent, runs tests in Freestyle VMs after each finished intent, and when tests fail runs variants with/without each change set in parallel to find the culprit change or the conflicting pair.

## Repo layout and owners

| Folder | Package | Owner brief |
|---|---|---|
| `shared/` | `@hive/shared` | human only |
| `server/src/core/` | `@hive/server` | 01 core state |
| `server/src/coord/` | `@hive/server` | 02 coordination |
| `server/src/api/`, `server/src/agents/`, `server/src/index.ts`, `server/src/hive.ts`, `server/src/emit.ts` | `@hive/server` | 03 API server |
| `server/src/runner/` | `@hive/server` | 04 runner and culprit |
| `agent/` | `@hive/agent` | 05 agent loop |
| `web/` | `@hive/web` | 06 web UI |
| `demo-app/`, `bench/` | `@hive/demo-app`, `@hive/bench` | 07 demo app and bench |

Stack: Node 24, TypeScript strict, ESM (`"type": "module"`), vitest for all tests. npm workspaces.

**Dependencies are pre-installed.** Every package's `package.json` already lists the dependencies the briefs need, and `package-lock.json` is committed. Do not edit any `package.json` (four briefs share `server/package.json`; parallel edits would conflict on merge). Run `npm ci` at the root of your worktree. If you truly need a new dependency, list it in your report; the human adds it.

TypeScript is pinned to 5.9: TypeScript 7 (the Go port) has no JS compiler API, and brief 02 needs `ts.createSourceFile`. Do not upgrade it.

TypeScript rules (the base config uses `module: NodeNext`; `web/` uses bundler resolution instead):
- relative imports need the `.js` extension: `import { ProjectStore } from "./ProjectStore.js"`;
- re-export types with `export type { ... }` (`isolatedModules` is on);
- `noUncheckedIndexedAccess` is on: handle `undefined` from index access;
- import shared types from `@hive/shared`.

Tests live next to the code owner's folder: `server/test/<module>/`, `agent/test/`, `web/src/**/*.test.tsx`, `demo-app/test/`, `bench/test/`.

Server internals talk through the TypeScript interfaces each module exports (listed below). Modules must be usable without the HTTP layer so they can be unit-tested in isolation.

## Environment

| Var | Default | Used by |
|---|---|---|
| `OPENAI_API_KEY` | none | agent loop, OpenAI LLM in coord |
| `FREESTYLE_API_KEY` | none | runner (freestyle) |
| `HIVE_RUNNER` | `local` | `local` runs in a temp dir on this machine, `freestyle` in VMs |
| `HIVE_MODE` | `hive` | `hive`, `naive` (no intents/briefings), `isolated` (per-agent copies, merge at end) |
| `HIVE_MODEL_AGENT` | `gpt-5.4-mini` | agent loop |
| `HIVE_MODEL_CHECK` | `gpt-5.4-nano` | coord checks |
| `HIVE_PROJECT_DIR` | `../demo-app` | initial files loaded into the project (resolved from `server/`); loads `src/**`, `test/**`, `package.json`, `tsconfig.json`, never `node_modules` |
| `PORT` | `4317` | server port; the bench starts extra servers on 4318+ |

Keys live in `.env` at the repo root (gitignored). Never print keys, never commit them. Tests must pass without any key (use fakes).

Ports: server `4317`, web `5173`.

## Server modules and their interfaces

All in `@hive/server`. Names below are the exported API each owner must provide.

### core (brief 01)

```ts
class ProjectStore {
  // resolveActor maps a foreign Yjs transaction origin to an actor id; default () => "human".
  // The ws layer (brief 03) passes one that looks the origin up in awareness.
  constructor(opts?: { onEvent?: (e: FeedEventBody) => void; resolveActor?: (origin: unknown) => string })
  loadFiles(files: Record<string, string>): void          // initial load, rev stays 0
  get rev(): Rev
  listFiles(): FileInfo[]
  readFile(path: string): { content: string; rev: Rev } | null
  allFiles(): Record<string, string>
  editRegion(args: { actor: string; intentId?: IntentId; path: string; oldText: string; newText: string }):
    { ok: true; rev: Rev; added: number; removed: number } |
    { ok: false; code: "NOT_FOUND" | "OLD_TEXT_NOT_FOUND" | "OLD_TEXT_AMBIGUOUS"; current?: string }
  createFile(args: { actor: string; intentId?: IntentId; path: string; content: string }): { ok: true; rev: Rev } | { ok: false; code: "BAD_ARGS" }
  humanReplaceFile(humanId: HumanId, path: string, content: string): { rev: Rev } // edits from the web editor arrive via Yjs; this is for tests and API
  ydoc: Y.Doc                                              // shared with y-websocket in brief 03
  onChange(cb: (c: { path: string; rev: Rev; actor: string; intentId?: IntentId; before: string; after: string }) => void): () => void
}
class ReadLog {
  record(agentId: AgentId, path: string, rev: Rev, symbols: string[]): void
  readsOf(agentId: AgentId): { path: string; rev: Rev; symbols: string[] }[]
  readersOf(path: string, symbol?: string): { agentId: AgentId; rev: Rev }[]
}
class History {
  constructor(store: ProjectStore) // uses store only for allFiles()/rev in saveSnapshot; it does NOT subscribe to onChange (brief 03 wires recordEdit)
  beginIntent(intent: Intent): void
  recordEdit(change: { path: string; intentId?: IntentId; before: string; after: string; rev: Rev }): void // wired to store.onChange
  finishIntent(intentId: IntentId): ChangeSet          // edits[] = one small patch per edit, in order; patch = display diff
  changeSets(): ChangeSet[]
  saveSnapshot(green: boolean): Snapshot
  lastGreen(): Snapshot | undefined
  changeSetsSince(rev: Rev): ChangeSet[]
}
// Applies each patch in order with diff.applyPatch(text, patch, { fuzzFactor: 2 }): a later patch's context
// may include neighbouring edits by other intents, so exact-context matching would fail on adjacent edits.
function applyEdits(files: Record<string, string>, edits: ChangeSet["edits"]): { ok: true; files: Record<string, string> } | { ok: false; path: string; index: number }
```

In `naive` and `isolated` modes, coord components (IntentRegistry conflict checks, ChangeWatcher, briefings) are no-ops; only the store, reads log, history and runner work.

### coord (brief 02)

```ts
function analyzeFile(path: string, content: string): { symbols: SymbolInfo[]; calls: CallSite[] }
class CallGraph { update(files: Record<string, string>): void; callersOf(symbol: string): CallSite[]; symbolAt(path: string, line: number): SymbolInfo | null }
class IntentRegistry {
  constructor(deps: { llm: LLM; graph: CallGraph; reads: ReadLog; briefings: BriefingQueue; onEvent: (e: FeedEventBody) => void; mode: HiveMode })
  declare(agentId: AgentId, humanId: HumanId, input: IntentInput, rev: Rev): Promise<DeclareIntentResult>
  get(id: IntentId): Intent | undefined
  list(): Intent[]
  setStatus(id: IntentId, status: IntentStatus): void
  canEdit(agentId: AgentId, intentId: IntentId): { ok: true } | { ok: false; code: "NO_INTENT" | "INTENT_NOT_APPROVED" | "NOT_YOUR_INTENT" } // ok for approved | in_progress
  // setStatus to done | verified | cancelled | failed also re-evaluates intents stuck in `conflict`
  // because of this one: if no other active conflict remains, they become `approved` (emit intent_status
  // AND push an `intent_conflict` briefing with requiresAck=false to the owner saying it is now approved,
  // otherwise the agent keeps waiting). resolveConflict does the same for both owners.
  // Contradiction checks consider other agents' intents in approved | in_progress | done | verified.
  humanEditOutput(humanId: HumanId, intentId: IntentId, newOutput: string): void // contract change -> briefings
  resolveConflict(humanId: HumanId, keepIntentId: IntentId, cancelIntentId: IntentId): void
}
class BriefingQueue {
  constructor(opts?: { onEvent?: (e: FeedEventBody) => void }) // emits briefing_sent on push, briefing_acked on ack
  push(b: Omit<Briefing, "id" | "createdAt">): Briefing
  takeUndelivered(agentId: AgentId): Briefing[]       // marks delivered
  unackedRequired(agentId: AgentId): Briefing[]
  ack(agentId: AgentId, briefingId: string, ack: Omit<BriefingAck, "at">): boolean
  all(): Briefing[]
}
class ChangeWatcher {
  constructor(deps: { llm: LLM; graph: CallGraph; reads: ReadLog; intents: IntentRegistry; briefings: BriefingQueue; onEvent: (e: FeedEventBody) => void; mode: HiveMode })
  onEdit(change: { path: string; rev: Rev; actor: string; intentId?: IntentId; before: string; after: string }): Promise<void> // symbol diff + 1-line meaning + route briefings; no-op in naive/isolated
}
class Mailbox {
  constructor(deps: { briefings: BriefingQueue; onEvent: (e: FeedEventBody) => void })
  ask(from: AgentId | HumanId, to: AgentId, about: string, question: string): AgentMessage | { error: "EXCHANGE_LIMIT" }
  reply(from: AgentId | HumanId, messageId: string, text: string): AgentMessage | { error: "NOT_FOUND" | "EXCHANGE_LIMIT" }
  forHumans(): AgentMessage[]
}
class OpenAILLM implements LLM { constructor(opts: { apiKey: string; model: string }) }
class FakeLLM implements LLM { constructor(responder: (system: string, user: string) => unknown) }
```

### runner (brief 04)

```ts
class LocalRunner implements Runner { constructor(opts: { templateDir: string /* demo-app with node_modules */ }) }
class FreestyleRunner implements Runner { constructor(opts: { apiKey: string; baseSnapshotId: string; maxParallel?: number }) }
async function prepareBaseSnapshot(opts): Promise<string>     // script: npm run -w @hive/server runner:prepare
class CulpritFinder { constructor(runner: Runner, maxParallel = 8); find(green: Snapshot, changeSets: ChangeSet[], onVariant?: (v: CulpritVariant) => void): Promise<CulpritReport> }
class TestOrchestrator {
  constructor(deps: { store: ProjectStore; history: History; intents: IntentRegistry; briefings: BriefingQueue; reads: ReadLog; graph: CallGraph; runner: Runner; culprit: CulpritFinder; onEvent: (e: FeedEventBody) => void; mode: HiveMode })
  onIntentFinished(intentId: IntentId): Promise<void> // snapshot after 1s quiet -> check -> tests -> green or culprit search -> briefings
}
```

### api and agents (brief 03)

Wires everything, exposes HTTP and WebSocket, runs agent loops in-process via `@hive/agent`. `createHive` calls `history.saveSnapshot(true)` right after `loadFiles`, so a green baseline (rev 0) always exists before the first test run; the runner treats a missing `lastGreen()` as rev 0 anyway.

Web client connection, literally: `new WebsocketProvider(\`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/yjs\`, "project", doc)` (the provider appends `/project` itself).

## HTTP API

Base `http://localhost:4317`. JSON in, JSON out.

### Agent tools

`POST /api/agents/:agentId/tools/:tool` with body `ToolArgs[tool]`, returns `ToolResponse<ToolResults[tool]>`.

Rules applied to every tool call, in this order:
1. Unknown agent → 404. Bad args → `ok: false, BAD_ARGS`.
2. Execute the tool.
3. Attach `briefings = briefingQueue.takeUndelivered(agentId)` (also on errors), `control`, `rev`.
4. Emit feed events.

Per-tool rules:
- `read_file` records a read (`ReadLog.record`) with the symbols overlapping the returned line range.
- `edit_region` and `create_file`: in `hive` mode require `canEdit` ok and no `unackedRequired` briefings (`UNACKED_BRIEFINGS`). In `naive` and `isolated` modes intents are not required.
- `edit_region` replaces exactly one occurrence of `oldText` in the latest content. Zero matches → `OLD_TEXT_NOT_FOUND` with `error.current` = fresh file content. More than one → `OLD_TEXT_AMBIGUOUS`.
- `declare_intent` sets status `approved` or `conflict`, and calls `history.beginIntent(intent)`. An intent in `conflict` cannot be edited until a human resolves it or the other intent is cancelled/finished (then the registry re-approves it, see coord).
- The first successful `edit_region`/`create_file` under an intent moves it to `in_progress`.
- `finish_intent` sets `done`, closes the change set, triggers `TestOrchestrator`.
- `run_command` and `run_tests` run on a snapshot of the current files via the runner.
- `ask_agent`: max 3 exchanges per thread; the 4th returns `EXCHANGE_LIMIT` and the thread goes to humans.

### Humans and UI

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/state` | | `HiveState` |
| GET | `/api/files/*` | | `{ content, rev, symbols: SymbolInfo[] }`; the wildcard is `decodeURIComponent`-ed, so both `/api/files/src/checkout.ts` and `/api/files/src%2Fcheckout.ts` work |
| POST | `/api/agents` | `{ agentId, humanId, task }` | start an agent loop with this task → `{ ok: true }` (409 if that agentId is already running); progress via `agent_status` events and `GET /api/state`, terminal statuses in `TERMINAL_AGENT_STATUSES` |
| POST | `/api/agents/:agentId/control` | `{ humanId, control: "run" \| "pause" \| "stop" }` | pause/resume/stop |
| POST | `/api/agents/:agentId/note` | `{ humanId, text, urgent?: boolean }` | `human_note` briefing; urgent aborts the current model call |
| POST | `/api/intents/:id/output` | `{ humanId, output }` | contract change, briefings to dependents |
| POST | `/api/intents/resolve` | `{ humanId, keep, cancel }` | resolve a conflict |
| POST | `/api/reset` | `{ mode?: HiveMode }` | stop all agents, reload initial files, clear all state (bench uses this) |
| POST | `/api/test` | `TestRequest` | run the full suite on current files (+ `extraFiles`) via the runner → `TestResult` |
| POST | `/api/merge` | | `isolated` mode only: 3-way merge of agent copies into main → `MergeResult` |

### WebSockets

- `ws://localhost:4317/ws/feed`: server sends `FeedEvent` JSON, one per message. On connect, the client then calls `GET /api/state`.
- `ws://localhost:4317/yjs/project`: Yjs sync of `ProjectStore.ydoc` (the **main** store; in isolated mode agent copies are not exposed). **Implemented by hand** on the server with `y-protocols/sync` + `y-protocols/awareness` over `@fastify/websocket` (message type 0 = sync, 1 = awareness, same wire format as y-websocket, so the stock `WebsocketProvider` client works). Do not use `@y/websocket-server`: it bundles its own yjs 14 and cannot bind an external document. One `Y.Map<Y.Text>` named `files`, keyed by path. Awareness carries `{ user: { name, color, kind: "human" | "agent" } }`. Agents do not use Yjs directly: their edits go through tools and the server writes them into the same doc, so the web sees them live.

## Modes

- `hive`: everything on.
- `naive`: one shared live project, no intents required, no briefings, no culprit search (tests still run on `/api/test`). Baseline "shared workspace without coordination".
- `isolated`: each agent edits its own copy, `/api/merge` merges at the end. Baseline "worktrees + merge" (like CAID).

## Agent loop rules (brief 05)

- OpenAI Chat Completions with tools, model `HIVE_MODEL_AGENT`, `reasoning_effort: "low"`, `parallel_tool_calls: false`.
- Two cancellation channels: `signal` (stop for good; once aborted the run ends with `stopped`) and `interrupt: { current(): AbortSignal }` (urgent human note; the loop asks for a fresh signal before **every** model call, so after one interruption the next call proceeds). The AgentManager owns both controllers and replaces the interrupt controller after each use.
- Each tool result message content = JSON of `ToolResponse`. If `briefings` is non-empty, the loop also appends them as readable text under `HIVE BRIEFINGS:` at the end of the tool result, so the model cannot miss them.
- If `control` is `pause`, the loop waits and polls `/control`; if `stop`, it ends.
- Budget per agent run: 40 tool calls, 15 minutes, 400k tokens. Logs `llm_call` timing for each call.
- The system prompt states the protocol: read → declare_intent → edit_region → finish_intent → ack every briefing that requires it before the next edit.

## Feed events

See `FeedEvent` in `contracts.ts`. Every server module emits through one `emit(body)` function that adds `id` (monotonic) and `ts`, keeps the last 200 in memory, and broadcasts on `/ws/feed`.

**Exactly one producer per event type** (duplicates would double the UI counters):

| Event | Emitted by |
|---|---|
| `edit_applied` | core `ProjectStore` (via its `onEvent`) |
| `intent_declared`, `intent_status` (on every `setStatus`), `message_sent`, `human_action` | coord `IntentRegistry` / `Mailbox` |
| `briefing_sent`, `briefing_acked` | coord `BriefingQueue` (constructor `(opts?: { onEvent })`) |
| `file_read`, `agent_status`, `llm_call` for agents (`purpose: "agent:<agentId>"`) | api `tools.ts` / `AgentManager` |
| `llm_call` for checks (`purpose: "check:<what>"`) | coord `OpenAILLM` via its timing callback |
| `test_run_started/finished`, `culprit_*` | runner `TestOrchestrator` / `CulpritFinder` |

`tools.ts` never re-emits what a module already emitted.

HTTP status for tool calls is always 200 (errors travel in `ok: false`), except 404 for an unknown agent. Modules signal argument errors by throwing `Object.assign(new Error(msg), { code: "BAD_ARGS" })`; the API maps that to `ok: false, BAD_ARGS`. Anything that needs the full history of a run (the bench counters) must subscribe to `/ws/feed` for the whole run; `recentEvents` in `/api/state` is a tail, not a log.

## Demo app (brief 07)

`demo-app/` is a small TypeScript checkout module with vitest tests. It is the project the agents edit. Symbols: `calculateTotal(items, promo?)` returns subtotal minus discount, **no tax**; `applyDiscount(subtotal, promo)`; `applyTax(total, state)`; `formatPrice(cents)`; types `Item`, `Promo`. Prices are integer cents.

## Definition of done for every brief

1. `npm test -w <package>` passes with no API keys set.
2. `npx tsc -p <package> --noEmit` passes.
3. Only your folder changed (`git status`).
4. A short report: what works, what is stubbed, measured timings if any, contract change requests if any.
