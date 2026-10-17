# Build plan: who does what and in which order

Every build agent gets: `CONTRACTS.md`, `shared/src/contracts.ts`, its brief, and the rule "only your folder". Each works in its own git worktree on branch `build/<nn>-<name>` and reports back; the human merges into `main`.

| Brief | Owns | Depends on | Start |
|---|---|---|---|
| 07 demo app + bench | `demo-app/`, `bench/` | nothing | **first, now** (demo app in 30 min unblocks others) |
| 01 core state | `server/src/core/` | demo-app fixtures (optional) | now |
| 02 coordination | `server/src/coord/` | 01 interfaces (code against CONTRACTS until merged) | now |
| 04 runner + culprit | `server/src/runner/` | demo-app | now |
| 05 agent loop | `agent/` | nothing | now |
| 06 web UI | `web/` | nothing (mock feed) | now |
| 03 API server | `server/src/api/`, `agents/`, `index.ts`, `emit.ts`, `hive.ts` | 01, 02, 04, 05 (stubs until merged) | now, integrate at ~13:30 |

## Shared install

The human runs `npm install` at the root once after the first merges add dependencies. Agents in worktrees run `npm install` in their worktree.

## Checkpoints

- 12:15: demo app merged; first versions of 01, 05, 06 merged.
- 13:30: 02 and 04 (local runner + culprit) merged; 03 integrates real modules; first end-to-end run of one scenario with two real agents.
- 14:30: Freestyle runner E2E; bench runs start (hive vs naive vs isolated).
- 15:30: results table; UI polished on the real feed; demo recording.

## Integration test (human, after 13:30)

1. `npm run dev:server` and `npm run dev:web`.
2. Start agent-andrii and agent-masha with scenario s01 tasks from the UI.
3. Expect: intents on the editor, a contradiction or briefing, acks, finish, tests, green or culprit search.

## Merge rule

Merge only when the brief's Done criteria pass in the worktree. Never merge a branch that touched files outside its folder.
