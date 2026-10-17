# Bench summary

3 runs, 2026-10-17T21:29:15.514Z, args: `--scenarios c01-control --variants hive,naive,isolated --repeats 1 --parallel 1 --server http://localhost:4317 --timeout-min 8 --out results-v4b`

## Per variant

"success" = full suite plus acceptance tests green; "acceptance-only" = the acceptance file alone green on the same files.

| variant | runs | success | acceptance-only success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hive | 1 | 100% | 100% | 23267 | 39.1 | 41.0 | 2.0 | 0% | 1 | n/a | 1/1 |
| naive | 1 | 100% | 100% | 8195 | 15.0 | 16.0 | 0.0 | 0% | 0 | n/a | 0/1 |
| isolated | 1 | 100% | 100% | 9215 | 15.0 | 18.0 | 0.0 | 0% | 0 | n/a | 0/1 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | acceptance-only success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|---|
| c01-control-wa-and-validation | hive | 1/1 | 1/1 | 25.0/0.0 | 23267 | 39.1 | 2.0 | 0.0 | 0/1 |
| c01-control-wa-and-validation | naive | 1/1 | 1/1 | 26.0/0.0 | 8195 | 15.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 1/1 | 1/1 | 25.0/0.0 | 9215 | 15.0 | 0.0 | 0.0 | - |
