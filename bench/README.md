# Hive bench

Scenarios, verified reference patches and the experiment runner for the demo app in `demo-app/`.

## Layout

- `scenarios/<id>.json`: two agents, their tasks, start delays, expected culprits. `scenarios/extra/<name>.accept.test.ts` is the file added to the project as `extraTests` at the end of a run; it encodes the intended combined behavior.
- `reference/<id>/{a,b,combined}.patch`: hand-verified solutions. `a` and `b` each keep their own suite green and apply in either order; `a+b` with the extra tests fails for conflict scenarios and passes for controls; `combined` is the correct merge and passes everything. `npm test -w @hive/bench` checks all of this in `.hive/bench/<id>/` (inside the repo so vitest resolves from the root `node_modules`).
- `src/run.ts`: the runner. `src/runner.ts` drives one run, `src/feed.ts` counts feed events, `src/summary.ts` writes CSV and markdown.

## Running the experiment

Start a server, then:

```sh
npm run bench -w @hive/bench -- --scenarios s01,c01 --variants hive,naive,isolated --repeats 2 --server http://localhost:4317
```

Options: `--scenarios all|s01,s02,...` (id or prefix), `--variants`, `--repeats`, `--timeout-min` (default 5), `--poll-sec` (default 3), `--out` (default `bench/results/`).

One server runs one scenario at a time. To run `--parallel N`, start N servers on consecutive ports and point `--server` at the first one:

```sh
PORT=4317 npm run dev -w @hive/server &
PORT=4318 npm run dev -w @hive/server &
PORT=4319 npm run dev -w @hive/server &
npm run bench -w @hive/bench -- --parallel 3 --repeats 2
```

Each run: `POST /api/reset {mode}`, open `/ws/feed`, `POST /api/agents` per agent after its delay, poll `/api/state` until both agents are terminal, `POST /api/merge` in isolated mode, `POST /api/test` with the extra tests. Output: `results/results.csv`, `results/results.json`, `results/summary.md` (rewritten after every run, so a partial experiment is still usable).

Counters per row: tool calls (`agent_status` with status `tool`), LLM calls and tokens (`llm_call`), briefings sent, acks with `adapted`, conflicts caught before code (`intent_declared` with conflicts), culprit searches, and whether the last `culprit_found` report names exactly `expectedCulprits` (intent ids mapped to owners). On controls, any conflict caught or culprit search counts as a false alarm in the summary.
