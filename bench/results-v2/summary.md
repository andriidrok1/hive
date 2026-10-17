# Bench summary

9 runs, 2026-10-17T20:10:14.035Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants hive,naive,isolated --repeats 1 --parallel 1 --server http://localhost:4317 --timeout-min 6 --out results-v2`

## Per variant

| variant | runs | success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|
| hive | 3 | 67% | 238776 | 52.1 | 38.0 | 4.7 | 0% | 3 | 50% | 0/1 |
| naive | 3 | 67% | 92596 | 35.0 | 26.7 | 0.0 | 0% | 0 | n/a | 0/1 |
| isolated | 3 | 33% | 135560 | 34.0 | 30.7 | 0.0 | 0% | 0 | n/a | 0/1 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|
| s01-double-tax | hive | 0/1 | 20.0/3.0 | 469937 | 74.1 | 7.0 | 0.0 | 1/1 |
| s01-double-tax | naive | 0/1 | 19.0/4.0 | 107375 | 38.0 | 0.0 | 0.0 | - |
| s01-double-tax | isolated | 0/1 | 17.0/2.0 | 283410 | 38.0 | 0.0 | 0.0 | - |
| s02-rename | hive | 1/1 | 22.0/0.0 | 180413 | 47.0 | 5.0 | 0.0 | 0/1 |
| s02-rename | naive | 1/1 | 23.0/0.0 | 128432 | 35.0 | 0.0 | 0.0 | - |
| s02-rename | isolated | 0/1 | 21.0/2.0 | 81198 | 32.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | hive | 1/1 | 26.0/0.0 | 65977 | 35.0 | 2.0 | 0.0 | - |
| c01-control-wa-and-validation | naive | 1/1 | 27.0/0.0 | 41982 | 32.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 1/1 | 25.0/0.0 | 42073 | 32.0 | 0.0 | 0.0 | - |
