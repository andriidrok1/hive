# Bench summary

18 runs, 2026-10-17T20:46:11.113Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants hive,naive,isolated --repeats 2 --parallel 1 --server http://localhost:4317 --timeout-min 6 --out results-v3`

## Per variant

| variant | runs | success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|
| hive | 6 | 67% | 329857 | 29.6 | 42.5 | 6.5 | 25% | 9 | 75% | 0/2 |
| naive | 6 | 83% | 252979 | 28.0 | 41.3 | 2.7 | 0% | 0 | n/a | 0/2 |
| isolated | 6 | 33% | 144489 | 21.5 | 32.0 | 0.8 | 0% | 0 | n/a | 0/2 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|
| s01-double-tax | hive | 0/2 | 20.0/4.0 | 603864 | 39.1 | 13.5 | 0.5 | 2/2 |
| s01-double-tax | naive | 1/2 | 23.0/0.5 | 395158 | 37.6 | 4.5 | 0.0 | - |
| s01-double-tax | isolated | 0/2 | 17.5/5.5 | 246468 | 28.5 | 2.5 | 0.0 | - |
| s02-rename | hive | 2/2 | 22.5/0.0 | 316536 | 34.6 | 5.5 | 0.0 | 1/2 |
| s02-rename | naive | 2/2 | 24.0/0.0 | 312065 | 33.1 | 3.5 | 0.0 | - |
| s02-rename | isolated | 0/2 | 21.0/2.5 | 134643 | 24.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | hive | 2/2 | 25.5/0.0 | 69171 | 15.0 | 0.5 | 0.0 | - |
| c01-control-wa-and-validation | naive | 2/2 | 25.0/0.0 | 51715 | 13.5 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 2/2 | 26.5/0.0 | 52357 | 12.0 | 0.0 | 0.0 | - |
