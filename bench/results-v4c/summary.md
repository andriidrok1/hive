# Bench summary

9 runs, 2026-10-17T21:30:34.332Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants hive,naive,isolated --repeats 1 --parallel 1 --server http://localhost:4317 --timeout-min 8 --out results-v4c`

## Per variant

"success" = full suite plus acceptance tests green; "acceptance-only" = the acceptance file alone green on the same files.

| variant | runs | success | acceptance-only success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hive | 3 | 67% | 67% | 31695 | 38.1 | 48.7 | 10.3 | 50% | 6 | 50% | 0/1 |
| naive | 3 | 67% | 67% | 22727 | 33.0 | 35.0 | 1.3 | 0% | 0 | n/a | 0/1 |
| isolated | 3 | 33% | 33% | 16920 | 21.0 | 27.3 | 1.0 | 0% | 0 | n/a | 0/1 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | acceptance-only success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|---|
| s01-double-tax | hive | 0/1 | 0/1 | 18.0/2.0 | 53411 | 63.1 | 20.0 | 2.0 | 1/1 |
| s01-double-tax | naive | 1/1 | 1/1 | 23.0/0.0 | 29197 | 36.1 | 2.0 | 0.0 | - |
| s01-double-tax | isolated | 0/1 | 0/1 | 19.0/4.0 | 24355 | 24.0 | 3.0 | 0.0 | - |
| s02-rename | hive | 1/1 | 1/1 | 23.0/0.0 | 29435 | 36.1 | 11.0 | 0.0 | 0/1 |
| s02-rename | naive | 0/1 | 0/1 | 21.0/3.0 | 27522 | 48.1 | 2.0 | 0.0 | - |
| s02-rename | isolated | 0/1 | 0/1 | 21.0/3.0 | 15195 | 24.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | hive | 1/1 | 1/1 | 25.0/0.0 | 12239 | 15.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | naive | 1/1 | 1/1 | 26.0/0.0 | 11461 | 15.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 1/1 | 1/1 | 25.0/0.0 | 11211 | 15.0 | 0.0 | 0.0 | - |
