# Brief 06: web UI

You own `web/`. Read `CONTRACTS.md` and `shared/src/contracts.ts`. Do not edit `web/package.json` or `web/tsconfig.json`: dependencies (`vite`, `react`, `react-dom`, `@vitejs/plugin-react`, `codemirror`, `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-javascript`, `@codemirror/theme-one-dark`, `yjs`, `y-websocket`, `y-codemirror.next`, `qrcode`, `vitest`, `@testing-library/react`, `jsdom`) and scripts (`dev` on 5173, `build`, `test`, `typecheck`) are set, and the tsconfig is set up for Vite + React (bundler resolution, so no `.js` extensions needed in `web/`). You create `web/index.html`, `web/vite.config.ts` (proxy `/api` to `http://localhost:4317`, and `/ws` and `/yjs` with `ws: true`; vitest `environment: "jsdom"`; the client always connects through the page origin, e.g. `ws://${location.host}/yjs`, so it works from a phone too), and `web/src/**`. Run `npm ci` at the worktree root.

## Goal

The screen judges watch and humans use: one live shared file like Google Docs, with agents' intents on it, agent cards, a feed, history, and the culprit search grid. Plus a phone page to edit contracts.

## Layout (desktop, 1440×900 target, dark)

- Top bar: "Hive", mode badge (`hive`/`naive`/`isolated`), project rev, last green rev, counters: briefings sent, plan changes (acks `adapted`), conflicts caught before code, culprit searches.
- Left (60%): file tabs + CodeMirror editor bound to the shared doc via `new WebsocketProvider(\`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/yjs\`, "project", doc)` (the provider appends `/project`; through the Vite proxy this reaches the server) (`Y.Map<Y.Text>` `files`, y-codemirror.next with awareness cursors). In `?mock=1` mode no provider is created and the editor is a plain `<pre>` with the mock file text, so tests run in jsdom without CodeMirror or sockets. Humans can type. Intent decorations: for each active intent, highlight the target symbol's line range (ranges from `GET /api/files/<path>` symbols, refetched on each `edit_applied` for that file, or recompute with a small client-side regex for `function name(`), with a label widget "M1 · agent-masha: add state tax → returns total + tax". Colors: grey declared, agent color in progress, green verified, red conflict/failed.
- Right top: agent cards: human name, agent id, status dot, current task, current intent, last 3 actions, buttons Note, Urgent, Pause/Resume, Stop. Note opens a one-line input.
- Right bottom: feed (newest on top), one line per `FeedEvent`, color by type, briefings expandable to show summary and ack.
- Tabs over the right column: Feed | History | Culprit | Contracts.
  - History: change sets as versions (who, what, +/−, files), click shows the patch.
  - Culprit: grid of variant cards keyed by the server's `label` (`green+A1`, `all-M1`, ASCII only) turning green/red live from `culprit_variant_result`, then a banner with the report ("A1 alone ok, M1 alone ok, together red: conflict between agent-andrii and agent-masha").
  - Contracts: list of intents with outputs, editable by humans (`POST /api/intents/:id/output`), conflict resolution buttons (`/api/intents/resolve`).
- "Start agent" dialog: agentId, humanId, task → `POST /api/agents`.
- A QR code (top right) linking to `/m` on the machine's LAN IP.

## Phone page `/m`

Contracts list with big edit buttons, and a note box to any agent. No editor.

## Data

- `src/state.ts`: pure reducer `reduce(state: HiveState, e: FeedEvent): HiveState` plus selectors for counters. Initial load `GET /api/state`, then `/ws/feed` with auto-reconnect and re-sync via `/api/state` on reconnect.
- `src/mock.ts`: a scripted feed of ~40 events covering the demo story (two agents, contradiction caught, briefing acked, tests red, culprit pair found, fixed, green). `?mock=1` runs the UI without a server. Build this first so the UI is developed independently.

## Tests (all required)

1. Reducer: `intent_declared` adds an intent; `intent_status` updates it.
2. Reducer: `briefing_acked` with `adapted` increments the plan-changes counter.
3. Reducer: `intent_declared` with conflicts increments "conflicts caught before code".
4. Reducer: culprit events build the grid state and final report.
5. Reducer ignores duplicate event ids.
6. Feed line formatter returns readable text for every `FeedEvent` type (exhaustive switch, type-checked).
7. Component: agent card renders status and fires the right fetch on Pause (mock fetch).
8. Component: Contracts tab edit posts the new output.
9. Mock mode renders without a server (render App with `?mock=1`, advance timers, expect culprit banner text).

## Done

`npm run dev -w @hive/web` shows the mock story at `?mock=1`; tests and typecheck pass. First version (layout + mock feed + feed list) in 40 minutes, editor binding next.
