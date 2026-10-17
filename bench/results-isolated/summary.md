# Bench summary

3 runs, 2026-10-17T20:05:02.416Z, args: `--scenarios s01-double-tax,s02-rename,c01-control --variants isolated --repeats 1 --parallel 1 --server http://localhost:4317 --timeout-min 6 --out results-isolated`

## Per variant

| variant | runs | success | mean tokens | mean wall s | mean tool calls | mean briefings | conflicts caught | culprit searches | culprit correct | false alarms (controls) |
|---|---|---|---|---|---|---|---|---|---|---|
| isolated | 3 (1 errored) | 33% | 65581 | 29.0 | 22.0 | 0.0 | 0% | 0 | n/a | 0/1 |

## Per scenario

One row per scenario and variant, means over repeats.

| scenario | variant | success | passed/failed | tokens | wall s | briefings | conflicts caught | culprit correct |
|---|---|---|---|---|---|---|---|---|
| s01-double-tax | isolated | 0/1 | 0.0/0.0 | 141198 | 0.0 | 0.0 | 0.0 | - |
| s02-rename | isolated | 0/1 | 21.0/2.0 | 90029 | 29.0 | 0.0 | 0.0 | - |
| c01-control-wa-and-validation | isolated | 1/1 | 25.0/0.0 | 41133 | 29.0 | 0.0 | 0.0 | - |

## Errors

- s01-double-tax/isolated#1: TypeError: fetch failed
