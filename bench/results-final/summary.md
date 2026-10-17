# Bench summary

18 runs, 2026-10-17T20:26:17.596Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants hive,naive,isolated --repeats 2 --parallel 1 --server http://localhost:4317 --timeout-min 6 --out results-final`

## Per variant

| variant | runs | success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|
| hive | 6 | 50% | 279687 | 35.6 | 41.7 | 6.7 | 0% | 6 | 100% | 0/2 |
| naive | 6 | 67% | 216074 | 29.5 | 36.5 | 1.0 | 0% | 0 | n/a | 0/2 |
| isolated | 6 | 33% | 127489 | 23.5 | 28.3 | 0.5 | 0% | 0 | n/a | 0/2 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|
| s01-double-tax | hive | 0/2 | 20.5/3.0 | 460118 | 55.6 | 13.0 | 0.0 | 2/2 |
| s01-double-tax | naive | 0/2 | 18.5/5.0 | 459758 | 49.6 | 3.0 | 0.0 | - |
| s01-double-tax | isolated | 0/2 | 18.5/3.0 | 227108 | 33.0 | 1.5 | 0.0 | - |
| s02-rename | hive | 1/2 | 22.0/1.0 | 316532 | 34.6 | 7.0 | 0.0 | 1/1 |
| s02-rename | naive | 2/2 | 24.0/0.0 | 144915 | 24.0 | 0.0 | 0.0 | - |
| s02-rename | isolated | 0/2 | 21.0/2.5 | 107738 | 22.5 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | hive | 2/2 | 25.5/0.0 | 62410 | 16.5 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | naive | 2/2 | 25.5/0.0 | 43550 | 15.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 2/2 | 25.5/0.0 | 47621 | 15.0 | 0.0 | 0.0 | - |
