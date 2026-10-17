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
| `server/src/api/`, `server/src/index.ts`, `server/src/agents/` | `@hive/server` | 03 API server |
| `server/src/runner/` | `@hive/server` | 04 runner and culprit |
| `agent/` | `@hive/agent` | 05 agent loop |
| `web/` | `@hive/web` | 06 web UI |
| `demo-app/`, `bench/` | `@hive/demo-app`, `@hive/bench` | 07 demo app and bench |

Stack: Node 24, TypeScript strict, ESM (`"type": "module"`), vitest for all tests. npm workspaces. Each package adds its own dependencies to its own `package.json` only.

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
| `HIVE_PROJECT_DIR` | `../demo-app` | initial files loaded into the project |

Keys live in `.env` at the repo root (gitignored). Never print keys, never commit them. Tests must pass without any key (use fakes).

Ports: server `4317`, web `5173`.

## Server modules and their interfaces

All in `@hive/server`. Names below are the exported API each owner must provide.

### core (brief 01)

```ts
class ProjectStore {
  constructor(opts?: { onEvent?: (e: FeedEventBody) => void })
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
  constructor(store: ProjectStore)
  beginIntent(intent: Intent): void
  finishIntent(intentId: IntentId): ChangeSet          // builds the patch of only this intent's edits
  changeSets(): ChangeSet[]
  saveSnapshot(green: boolean): Snapshot
  lastGreen(): Snapshot | undefined
  changeSetsSince(rev: Rev): ChangeSet[]
}
```

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
  canEdit(agentId: AgentId, intentId: IntentId): { ok: true } | { ok: false; code: "NO_INTENT" | "INTENT_NOT_APPROVED" | "NOT_YOUR_INTENT" }
  humanEditOutput(humanId: HumanId, intentId: IntentId, newOutput: string): void // contract change -> briefings
  resolveConflict(humanId: HumanId, keepIntentId: IntentId, cancelIntentId: IntentId): void
}
class BriefingQueue {
  push(b: Omit<Briefing, "id" | "createdAt">): Briefing
  takeUndelivered(agentId: AgentId): Briefing[]       // marks delivered
  unackedRequired(agentId: AgentId): Briefing[]
  ack(agentId: AgentId, briefingId: string, ack: Omit<BriefingAck, "at">): boolean
  all(): Briefing[]
}
class ChangeWatcher { constructor(deps: {...}); onEdit(change): Promise<void> } // symbol diff + 1-line meaning + route briefings
class Mailbox { ask(from, to, about, question): AgentMessage | { error: "EXCHANGE_LIMIT" }; reply(from, messageId, text): AgentMessage | { error: ... }; forHumans(): AgentMessage[] }
class OpenAILLM implements LLM { constructor(opts: { apiKey: string; model: string }) }
class FakeLLM implements LLM { constructor(responder: (system: string, user: string) => unknown) }
```

### runner (brief 04)

```ts
class LocalRunner implements Runner { constructor(opts: { templateDir: string /* demo-app with node_modules */ }) }
class FreestyleRunner implements Runner { constructor(opts: { apiKey: string; baseSnapshotId: string; maxParallel?: number }) }
async function prepareBaseSnapshot(opts): Promise<string>     // script: npm run -w @hive/server runner:prepare
class CulpritFinder { constructor(runner: Runner, maxParallel = 8); find(green: Snapshot, changeSets: ChangeSet[], onVariant?: (v: CulpritVariant) => void): Promise<CulpritReport> }
class TestOrchestrator { constructor(deps); onIntentFinished(intentId): Promise<void> } // snapshot after 1s quiet -> check -> tests -> green or culprit search -> briefings
```

### api and agents (brief 03)

Wires everything, exposes HTTP and WebSocket, runs agent loops in-process via `@hive/agent`.

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
- `declare_intent` sets status `approved` or `conflict`. An intent in `conflict` cannot be edited until a human resolves it or the other intent is cancelled/finished.
- `finish_intent` sets `done`, closes the change set, triggers `TestOrchestrator`.
- `run_command` and `run_tests` run on a snapshot of the current files via the runner.
- `ask_agent`: max 3 exchanges per thread; the 4th returns `EXCHANGE_LIMIT` and the thread goes to humans.

### Humans and UI

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/api/state` | | `HiveState` |
| GET | `/api/files/:path*` | | `{ content, rev }` |
| POST | `/api/agents` | `{ agentId, humanId, task }` | start an agent loop with this task |
| POST | `/api/agents/:agentId/control` | `{ humanId, control: "run" \| "pause" \| "stop" }` | pause/resume/stop |
| POST | `/api/agents/:agentId/note` | `{ humanId, text, urgent?: boolean }` | `human_note` briefing; urgent aborts the current model call |
| POST | `/api/intents/:id/output` | `{ humanId, output }` | contract change, briefings to dependents |
| POST | `/api/intents/resolve` | `{ humanId, keep, cancel }` | resolve a conflict |
| POST | `/api/reset` | `{ mode?: HiveMode }` | reload initial files, clear state (bench uses this) |

### WebSockets

- `ws://localhost:4317/ws/feed`: server sends `FeedEvent` JSON, one per message. On connect, the client then calls `GET /api/state`.
- `ws://localhost:4317/yjs/project`: y-websocket sync of `ProjectStore.ydoc`. One `Y.Map<Y.Text>` named `files`, keyed by path. Awareness carries `{ user: { name, color, kind: "human" | "agent" } }`.

## Agent loop rules (brief 05)

- OpenAI Chat Completions with tools, model `HIVE_MODEL_AGENT`, `reasoning_effort: "low"`, `parallel_tool_calls: false`.
- Each tool result message content = JSON of `ToolResponse`. If `briefings` is non-empty, the loop also appends them as readable text under `HIVE BRIEFINGS:` at the end of the tool result, so the model cannot miss them.
- If `control` is `pause`, the loop waits and polls `/control`; if `stop`, it ends.
- Budget per agent run: 40 tool calls, 15 minutes, 400k tokens. Logs `llm_call` timing for each call.
- The system prompt states the protocol: read → declare_intent → edit_region → finish_intent → ack every briefing that requires it before the next edit.

## Feed events

See `FeedEvent` in `contracts.ts`. Every server module emits through one `emit(body)` function that adds `id` (monotonic) and `ts`, keeps the last 200 in memory, and broadcasts on `/ws/feed`.

## Demo app (brief 07)

`demo-app/` is a small TypeScript checkout module with vitest tests. It is the project the agents edit. Symbols: `calculateTotal(items, promo?)` returns subtotal minus discount, **no tax**; `applyDiscount(subtotal, promo)`; `applyTax(total, state)`; `formatPrice(cents)`; types `Item`, `Promo`. Prices are integer cents.

## Definition of done for every brief

1. `npm test -w <package>` passes with no API keys set.
2. `npx tsc -p <package> --noEmit` passes.
3. Only your folder changed (`git status`).
4. A short report: what works, what is stubbed, measured timings if any, contract change requests if any.
