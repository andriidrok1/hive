# Bench summary

9 runs, 2026-10-17T20:17:00.249Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants hive,naive,isolated --repeats 1 --parallel 1 --server http://localhost:4317 --timeout-min 6 --out results-v2b`

## Per variant

| variant | runs | success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|
| hive | 3 | 67% | 335396 | 52.1 | 45.7 | 9.0 | 50% | 4 | 0% | 0/1 |
| naive | 3 | 100% | 233415 | 40.0 | 38.3 | 0.0 | 0% | 0 | n/a | 0/1 |
| isolated | 3 | 33% | 208616 | 39.0 | 36.3 | 0.0 | 0% | 0 | n/a | 0/1 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|
| s01-double-tax | hive | 0/1 | 20.0/3.0 | 795937 | 89.2 | 23.0 | 2.0 | 0/1 |
| s01-double-tax | naive | 1/1 | 24.0/0.0 | 560751 | 56.1 | 0.0 | 0.0 | - |
| s01-double-tax | isolated | 0/1 | 17.0/2.0 | 493637 | 56.1 | 0.0 | 0.0 | - |
| s02-rename | hive | 1/1 | 23.0/0.0 | 146860 | 35.0 | 3.0 | 0.0 | 0/1 |
| s02-rename | naive | 1/1 | 23.0/0.0 | 90472 | 32.0 | 0.0 | 0.0 | - |
| s02-rename | isolated | 0/1 | 21.0/2.0 | 90387 | 29.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | hive | 1/1 | 25.0/0.0 | 63391 | 32.0 | 1.0 | 0.0 | - |
| c01-control-wa-and-validation | naive | 1/1 | 26.0/0.0 | 49023 | 32.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 1/1 | 25.0/0.0 | 41825 | 32.0 | 0.0 | 0.0 | - |
