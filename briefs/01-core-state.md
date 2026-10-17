# Brief 01: core state (live project, revisions, reads, history)

You own `server/src/core/` and `server/test/core/`. Read `CONTRACTS.md` and `shared/src/contracts.ts` first. Do not edit anything else. Add dependencies to `server/package.json` only (`yjs`, `diff`, `vitest`, `typescript`, `@types/diff`); if another brief already added one, keep their version.

## Goal

The in-memory truth of the shared project: files in a Yjs document, a project-wide revision counter, region edits applied to the latest content, a log of what each agent read, and per-intent change sets with snapshots. Pure TypeScript, no HTTP.

## Files

- `server/src/core/ProjectStore.ts`
- `server/src/core/ReadLog.ts`
- `server/src/core/History.ts`
- `server/src/core/index.ts` (re-exports)
- `server/test/core/*.test.ts`

## Spec

### ProjectStore

- `ydoc = new Y.Doc({ gc: false })`, `files = ydoc.getMap<Y.Text>("files")`.
- `loadFiles` fills the map, rev stays 0, emits nothing.
- `rev` increments by 1 on every successful `editRegion`, `createFile`, `humanReplaceFile`, and on every Yjs update that did not originate from this class (human typing in the web editor via y-websocket). Use a transaction origin (`"hive"`) for own writes and observe `ydoc.on("afterTransaction")` for foreign ones, attributing them to the awareness user if known, else `"human"`.
- Per-file rev: the rev of the last change to that file.
- `editRegion`: read the latest text; count exact occurrences of `oldText`; 0 → `OLD_TEXT_NOT_FOUND` with `current`; >1 → `OLD_TEXT_AMBIGUOUS`; 1 → apply as Y.Text delete+insert at that index inside one transaction (do not replace the whole text, so concurrent human typing elsewhere survives). Return `added`/`removed` line counts computed with `diff.diffLines`.
- `createFile` fails with `BAD_ARGS` if the path exists or is not a relative POSIX path inside the project.
- `onChange` fires after every change with `before`/`after` full text of the file.
- `onEvent` (optional) receives `edit_applied` bodies.

### ReadLog

- `record` keeps every read; `readsOf` returns the latest read per (path, symbol set); `readersOf(path, symbol?)` returns each agent's latest read rev of that path (and that symbol if given).

### History

- `beginIntent(intent)` starts collecting edits whose `intentId` matches.
- Each change set's `patch` must contain only that intent's edits. Approach: keep, per intent, the file text right before its first edit and right after its last edit, **minus** foreign edits made in between. Simplest correct approach for the hackathon: record each edit of the intent as its own small hunk (`diff.structuredPatch` of before/after of that single edit) and concatenate hunks per file in order; `finishIntent` joins them into one unified patch per file (`diff.formatPatch`). Document the approach in a comment.
- `saveSnapshot(green)` stores all files at current rev. `lastGreen()` returns the latest green one. `changeSetsSince(rev)` returns finished change sets with `endRev > rev`, ordered by `endRev`.

## Tests (all required)

1. load 3 files → `rev === 0`, `listFiles()` returns 3 with rev 0.
2. `editRegion` unique match → content updated, rev 1, file rev 1, added/removed correct.
3. `editRegion` missing text → `OLD_TEXT_NOT_FOUND` and `current` equals the latest content.
4. `editRegion` ambiguous → `OLD_TEXT_AMBIGUOUS`, nothing changed.
5. Two edits to different functions of the same file applied back to back (simulating two agents) → both present in the final text.
6. A foreign Yjs update (apply an update from a second `Y.Doc` via `Y.applyUpdate`) increments rev and fires `onChange` with actor `"human"`.
7. A human inserting text at the top of the file between two agent edits does not break the second agent edit (edit by `oldText` still found).
8. `createFile` happy path and duplicate path → `BAD_ARGS`.
9. `ReadLog.readersOf("src/checkout.ts", "calculateTotal")` returns only agents whose read included that symbol, with their latest rev.
10. History: intent A edits `calculateTotal`, intent B edits `applyTax` in between A's two edits; `finishIntent(A).patch` applied with `diff.applyPatch` to the green snapshot reproduces A's change only (B's absent); same for B.
11. `changeSetsSince(greenRev)` returns change sets in `endRev` order.
12. `saveSnapshot(true)` then more edits → `lastGreen().files` unchanged by later edits.

Use small inline fixtures modeled on the demo app (`calculateTotal`, `applyTax`).

## Done

`npm test -w @hive/server -- core` and `npx tsc -p server --noEmit` pass. First working version (tests 1–5) within 30 minutes, then the rest.
