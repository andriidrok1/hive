// Local copy of core's applyEdits (brief 01, CONTRACTS.md "core"). Brief 04 allows this copy until
// server/src/core is merged; afterwards replace the import in CulpritFinder.ts with "../core/index.js".
import { applyPatch } from "diff";
import type { ChangeSet } from "@hive/shared";

export type ApplyEditsResult = { ok: true; files: Record<string, string> } | { ok: false; path: string; index: number };

/** Applies each patch in order with fuzzFactor 2 (neighbouring edits by other intents may shift context). */
export function applyEdits(files: Record<string, string>, edits: ChangeSet["edits"]): ApplyEditsResult {
  const out: Record<string, string> = { ...files };
  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index]!;
    const current = out[edit.path] ?? "";
    const next = applyPatch(current, edit.patch, { fuzzFactor: 2 });
    if (next === false) return { ok: false, path: edit.path, index };
    out[edit.path] = next;
  }
  return { ok: true, files: out };
}
