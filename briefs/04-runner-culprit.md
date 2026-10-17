# Brief 04: runner, test orchestration, culprit finder (Freestyle)

You own `server/src/runner/` and `server/test/runner/`. Read `CONTRACTS.md`, `shared/src/contracts.ts`, and the Freestyle docs skill (`~/.claude/skills/freestyle-docs/SKILL.md`; fetch `https://www.freestyle.sh/docs/llms.txt` and the pages on VMs, snapshots, exec and files before writing Freestyle code: answer from the docs, the API changes). Dependencies in `server/package.json`: `freestyle` (npm SDK, latest), `diff`, `vitest`.

Credits: $500 are on the team account; `FREESTYLE_API_KEY` is in the repo `.env`. Delete every VM you create in tests and scripts (try/finally). Never print the key.

## Goal

Run tests and commands on any set of files, locally or in Freestyle VMs, and find which change set (or pair) broke the tests by running variants in parallel.

## Files

- `LocalRunner.ts`: copy `templateDir` (the demo app with `node_modules` installed) to a temp dir once per call (`fs.cp` with `node_modules` symlinked, not copied), write files, run `npx vitest run --reporter=json --outputFile=<tmp>/r.json` (and `filter` as a test name pattern), parse into `TestResult`. `runCommand` runs `sh -c cmd` with timeout, truncates output to 8000 chars.
- `FreestyleRunner.ts`: create VM from `baseSnapshotId` (idle timeout off for agent sandboxes, short for test VMs; public internet off unless needed), write files (prefer the SDK file API; fallback: one `exec` with a base64 tar), run the same vitest command, parse, delete VM. Semaphore `maxParallel` (default 8). Record `vmId` and timings. Retries once on VM creation failure.
- `prepare.ts` + script `runner:prepare` in `server/package.json`: create a VM, copy `demo-app` (without node_modules), `npm ci`, verify `npx vitest run` passes, snapshot, write `{ snapshotId, createdAt }` to `.hive/base-snapshot.json`, delete the VM. Print timings.
- `CulpritFinder.ts`: see algorithm below.
- `TestOrchestrator.ts`: deps `{ store, history, intents, briefings, runner, culprit, emit, mode }`. On `onIntentFinished(id)`: wait until 1s without store changes (max 5s), save a snapshot, run the intent's `check` if present (write a temp test file `__hive_check__.test.ts` with an `import` of the target and the check lines; failure → intent `failed`, `verification_failed` briefings to dependents), then the full suite; green → `saveSnapshot(true)`, intent `verified`; red → culprit search over `changeSetsSince(lastGreen.rev)`, emit variant results live, then `culprit` briefings: single → to the culprit's owner; pair → to both owners with both intents' outputs; unknown → to all suspects' owners. Emits `test_run_*` and `culprit_*` events.
- `index.ts` re-exports and `makeRunner(env)` picks local or freestyle.

## Culprit algorithm

Input: green snapshot G, change sets S1..Sn (n ≤ 6; if more, take the last 6).
1. Variants: `G+Si` for each i, and `All−Si` for each i (`All` = apply every Si in order; `All−Si` = apply all except Si). Apply with `diff.applyPatch`; if a patch fails to apply, record `applyError` and mark Si as dependent on earlier ones.
2. Run all variants in parallel through the runner (respect `maxParallel`), call `onVariant` as each finishes.
3. Decide:
   - exactly one i with `All−Si` green and `G+Si` red → `single [Si]`;
   - every `G+Si` green, `All` red, and some j,k with `G+Sj+Sk` red (run pairs only among suspects, max 6 pair runs) → `pair [Sj, Sk]`;
   - patch dependency prevented isolation → `dependent`;
   - else `unknown` with all suspects.

## Tests (all required; Freestyle tests skipped unless `FREESTYLE_API_KEY` is set and `HIVE_E2E=1`)

1. LocalRunner: green demo files → `ok true, failed 0`.
2. LocalRunner: break `calculateTotal` → `ok false`, failure names present.
3. LocalRunner `runCommand("node -e 'console.log(1)'")` → exitCode 0, stdout "1".
4. Timeout kills a hanging command.
5. Culprit single: S1 (format change, harmless) + S2 (breaks discount) → `single [S2]`.
6. Culprit pair: S1 makes `calculateTotal` include tax, S2 makes `applyTax` multiply again; each alone green (tests written so), together red → `pair [S1, S2]`.
7. Culprit with a patch that only applies after another → `dependent`.
8. TestOrchestrator with fakes: green path marks `verified` and saves a green snapshot; red path emits culprit events and pushes briefings to the right agents.
9. `check` failure → `verification_failed` to dependents.
10. (E2E) `prepare` creates a snapshot, FreestyleRunner runs the green suite from it, VM deleted afterwards; log VM create and test durations.
11. (E2E) 6 variants in parallel on Freestyle finish; total wall time logged.

Use the demo app files as fixtures (from `demo-app/`, owned by brief 07). Until they exist, use a minimal local copy inside `server/test/runner/fixtures/`.

## Done

Unit tests pass with no keys; E2E 10–11 pass with keys and report timings. First version (LocalRunner + tests 1–3) in 30 minutes, culprit next, Freestyle last.
