import { applyPatch, createPatch } from "diff";
import type { ChangeSet, Intent, IntentId, Rev, Snapshot } from "@hive/shared";
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

/**
 * Applies each patch in order with fuzzFactor 2: a later patch's context may include
 * neighbouring edits by other intents, so exact-context matching would fail on adjacent edits.
 * A patch for a path missing from `files` is applied to "" (file created by the intent).
 */
export function applyEdits(
  files: Record<string, string>,
  edits: ChangeSet["edits"],
): { ok: true; files: Record<string, string> } | { ok: false; path: string; index: number } {
  const out: Record<string, string> = { ...files };
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;
    const current = out[edit.path] ?? "";
    const next = applyPatch(current, edit.patch, { fuzzFactor: 2 });
    if (next === false) return { ok: false, path: edit.path, index };
    out[edit.path] = next;
  }
  return { ok: true, files: out };
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

  /** Finished change sets in finish order. */
  changeSets(): ChangeSet[] {
    return [...this.finishedOrder];
  }

  /** Finished change sets with endRev > rev, ordered by endRev (finish order breaks ties). */
  changeSetsSince(rev: Rev): ChangeSet[] {
    return this.finishedOrder.filter((cs) => cs.endRev > rev).sort((a, b) => a.endRev - b.endRev);
  }

  saveSnapshot(green: boolean): Snapshot {
    const snap: Snapshot = { rev: this.store.rev, files: this.store.allFiles(), green, at: Date.now() };
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
