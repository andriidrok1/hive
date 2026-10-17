import { applyPatch, createPatch, parsePatch, type StructuredPatch } from "diff";
import type { AgentId, ChangeSet, Intent, IntentId, Rev, Snapshot } from "@hive/shared";
import { badArgs, lineDelta, type ProjectStore } from "./ProjectStore.js";

export interface EditRecord {
  path: string;
  intentId?: IntentId;
  before: string;
  after: string;
  rev: Rev;
}

interface OpenIntent {
  intent: Intent;
  edits: { path: string; patch: string }[];
  files: string[]; // in first-touch order
  firstBefore: Map<string, string>;
  lastAfter: Map<string, string>;
  lastRev: Rev | undefined;
  added: number;
  removed: number;
}

const PATCH_OPTS = { context: 3 } as const;

/** Returns a copy of the hunk with at most `n` leading and trailing context lines. */
function trimHunkContext(hunk: StructuredPatch["hunks"][number], n: number): StructuredPatch["hunks"][number] {
  const lines = [...hunk.lines];
  let { oldStart, newStart, oldLines, newLines } = hunk;
  let lead = 0;
  while (lead < lines.length && lines[lead]!.startsWith(" ")) lead++;
  const dropLead = Math.max(0, lead - n);
  lines.splice(0, dropLead);
  oldStart += dropLead;
  newStart += dropLead;
  oldLines -= dropLead;
  newLines -= dropLead;
  // trailing: a "\ No newline at end of file" marker belongs to the line before it
  let trail = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.startsWith("\\")) continue;
    if (!l.startsWith(" ")) break;
    trail++;
  }
  let dropTrail = Math.max(0, trail - n);
  while (dropTrail > 0) {
    const last = lines[lines.length - 1]!;
    lines.pop();
    if (last.startsWith("\\")) continue;
    dropTrail--;
    oldLines--;
    newLines--;
  }
  return { ...hunk, lines, oldStart, newStart, oldLines, newLines };
}

/**
 * Applies one stored patch. First exactly as the contract says: `applyPatch(text, patch, { fuzzFactor: 2 })`.
 * jsdiff never tolerates a mismatch on the context line directly next to an insertion, so a patch made
 * right after another intent edited the neighbouring line (N vs N+1) cannot apply alone on green that way.
 * In that case the same hunks are retried with their outer context trimmed to 1 and then 0 lines; the
 * removed lines still have to be found exactly, nearest to the expected position first.
 */
export function applyOnePatch(text: string, patch: string): string | false {
  const direct = applyPatch(text, patch, { fuzzFactor: 2 });
  if (direct !== false) return direct;
  const parsed = parsePatch(patch);
  const structured = parsed[0];
  if (!structured || parsed.length !== 1) return false;
  for (const n of [1, 0]) {
    const trimmed: StructuredPatch = { ...structured, hunks: structured.hunks.map((h) => trimHunkContext(h, n)) };
    const res = applyPatch(text, trimmed, { fuzzFactor: 2 });
    if (res !== false) return res;
  }
  return false;
}

/**
 * Applies each patch in order (see applyOnePatch): a later patch's context may include
 * neighbouring edits by other intents, so exact-context matching would fail on adjacent edits.
 * A patch for a path missing from `files` is applied to "" (file created by the intent).
 * The input object is not mutated.
 */
export function applyEdits(
  files: Record<string, string>,
  edits: ChangeSet["edits"],
): { ok: true; files: Record<string, string> } | { ok: false; path: string; index: number } {
  const out: Record<string, string> = { ...files };
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    const current = out[edit.path] ?? "";
    const next = applyOnePatch(current, edit.patch);
    if (next === false) return { ok: false, path: edit.path, index };
    out[edit.path] = next;
  }
  return { ok: true, files: out };
}

/**
 * The files an agent is judged on: `base` (normally the last green snapshot) + every finished
 * change set in the given order + `extraEdits` (normally the agent's own in-progress edits).
 * Pure; the inputs are not mutated.
 */
export function buildView(
  base: Record<string, string>,
  sets: ChangeSet[],
  extraEdits?: ChangeSet["edits"],
): { ok: true; files: Record<string, string> } | { ok: false; failedAt: { intentId?: IntentId; path: string; index: number } } {
  let files: Record<string, string> = { ...base };
  for (const set of sets) {
    const res = applyEdits(files, set.edits);
    if (!res.ok) return { ok: false, failedAt: { intentId: set.id, path: res.path, index: res.index } };
    files = res.files;
  }
  if (extraEdits && extraEdits.length > 0) {
    const res = applyEdits(files, extraEdits);
    if (!res.ok) return { ok: false, failedAt: { path: res.path, index: res.index } };
    files = res.files;
  }
  return { ok: true, files };
}

export class History {
  private readonly open = new Map<IntentId, OpenIntent>();
  private readonly finished = new Map<IntentId, ChangeSet>();
  private readonly finishedOrder: ChangeSet[] = [];
  private readonly snapshots: Snapshot[] = [];

  /** `store` is used only for allFiles()/rev in saveSnapshot. Wire `store.onChange(c => history.recordEdit(c))` elsewhere, once. */
  constructor(private readonly store: ProjectStore) {}

  beginIntent(intent: Intent): void {
    if (this.finished.has(intent.id)) throw badArgs(`intent ${intent.id} already finished`);
    if (this.open.has(intent.id)) return;
    this.open.set(intent.id, {
      intent,
      edits: [],
      files: [],
      firstBefore: new Map(),
      lastAfter: new Map(),
      lastRev: undefined,
      added: 0,
      removed: 0,
    });
  }

  /** One small patch per edit, against the file as it was right before that edit. Edits without a known open intent are ignored. */
  recordEdit(change: EditRecord): void {
    if (change.intentId === undefined) return;
    const o = this.open.get(change.intentId);
    if (!o) return;
    o.edits.push({ path: change.path, patch: createPatch(change.path, change.before, change.after, "", "", PATCH_OPTS) });
    if (!o.firstBefore.has(change.path)) {
      o.firstBefore.set(change.path, change.before);
      o.files.push(change.path);
    }
    o.lastAfter.set(change.path, change.after);
    o.lastRev = change.rev;
    const d = lineDelta(change.before, change.after);
    o.added += d.added;
    o.removed += d.removed;
  }

  /** Closes the change set. Idempotent: a second call returns the same set. endRev = rev of the intent's last edit (store.rev if it made none). */
  finishIntent(intentId: IntentId): ChangeSet {
    const done = this.finished.get(intentId);
    if (done) return done;
    const o = this.open.get(intentId);
    if (!o) throw badArgs(`unknown intent ${intentId}`);
    this.open.delete(intentId);
    const display = o.files
      .map((path) => createPatch(path, o.firstBefore.get(path) ?? "", o.lastAfter.get(path) ?? "", "", "", PATCH_OPTS))
      .join("");
    const cs: ChangeSet = {
      id: o.intent.id,
      agentId: o.intent.agentId,
      humanId: o.intent.humanId,
      what: o.intent.what,
      files: [...o.files],
      edits: o.edits,
      patch: display,
      baseRev: o.intent.baseRev,
      endRev: o.lastRev ?? this.store.rev,
      added: o.added,
      removed: o.removed,
    };
    this.finished.set(intentId, cs);
    this.finishedOrder.push(cs);
    return cs;
  }

  /** Edits recorded so far for an intent that has begun but not finished, in order; [] for unknown or finished intents. */
  openEdits(intentId: IntentId): ChangeSet["edits"] {
    const o = this.open.get(intentId);
    return o ? o.edits.map((e) => ({ ...e })) : [];
  }

  /** Intents begun and not finished, in begin order; optionally only one agent's. */
  openIntents(agentId?: AgentId): { intentId: IntentId; agentId: AgentId; files: string[] }[] {
    const out: { intentId: IntentId; agentId: AgentId; files: string[] }[] = [];
    for (const o of this.open.values()) {
      if (agentId !== undefined && o.intent.agentId !== agentId) continue;
      out.push({ intentId: o.intent.id, agentId: o.intent.agentId, files: [...o.files] });
    }
    return out;
  }

  /** Finished change sets in finish order. */
  changeSets(): ChangeSet[] {
    return [...this.finishedOrder];
  }

  /** Finished change sets with endRev > rev, ordered by endRev (finish order breaks ties). */
  changeSetsSince(rev: Rev): ChangeSet[] {
    return this.finishedOrder.filter((cs) => cs.endRev > rev).sort((a, b) => a.endRev - b.endRev);
  }

  /** Stores the live store state, or `view` (the files the orchestrator actually tested) when given. */
  saveSnapshot(green: boolean, view?: { rev: Rev; files: Record<string, string> }): Snapshot {
    const snap: Snapshot = view
      ? { rev: view.rev, files: { ...view.files }, green, at: Date.now() }
      : { rev: this.store.rev, files: this.store.allFiles(), green, at: Date.now() };
    this.snapshots.push(snap);
    return snap;
  }

  lastGreen(): Snapshot | undefined {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const s = this.snapshots[i];
      if (s?.green) return s;
    }
    return undefined;
  }

  allSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }
}
