# Bench summary

6 runs, 2026-10-17T21:22:14.655Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants hive,naive,isolated --repeats 2 --parallel 1 --server http://localhost:4317 --timeout-min 8 --out results-v4`

## Per variant

"success" = full suite plus acceptance tests green; "acceptance-only" = the acceptance file alone green on the same files.

| variant | runs | success | acceptance-only success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hive | 2 | 50% | 50% | 47992 | 43.6 | 67.0 | 12.5 | 50% | 7 | 100% | 0/0 |
| naive | 2 | 50% | 50% | 46422 | 48.1 | 60.0 | 2.5 | 0% | 0 | n/a | 0/0 |
| isolated | 2 | 0% | 0% | 35653 | 36.1 | 44.5 | 1.5 | 0% | 0 | n/a | 0/0 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | acceptance-only success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|---|
| s01-double-tax | hive | 0/1 | 0/1 | 19.0/5.0 | 42507 | 48.1 | 12.0 | 1.0 | 1/1 |
| s01-double-tax | naive | 0/1 | 0/1 | 20.0/3.0 | 56597 | 60.1 | 2.0 | 0.0 | - |
| s01-double-tax | isolated | 0/1 | 0/1 | 17.0/2.0 | 50500 | 51.1 | 3.0 | 0.0 | - |
| s02-rename | hive | 1/1 | 1/1 | 24.0/0.0 | 53477 | 39.1 | 13.0 | 0.0 | 1/1 |
| s02-rename | naive | 1/1 | 1/1 | 24.0/0.0 | 36246 | 36.1 | 3.0 | 0.0 | - |
| s02-rename | isolated | 0/1 | 0/1 | 21.0/2.0 | 20805 | 21.0 | 0.0 | 0.0 | - |
