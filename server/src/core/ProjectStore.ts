import * as Y from "yjs";
import { diffLines } from "diff";
import type { FeedEventBody, FileInfo, HumanId, IntentId, Rev } from "@hive/shared";

/** Transaction origin for every write made by ProjectStore itself. */
export const HIVE_ORIGIN = "hive";
/** How long a human may pause between keystrokes before a foreign change is recorded. */
export const FOREIGN_DEBOUNCE_MS = 300;

export interface FileChange {
  path: string;
  rev: Rev;
  actor: string;
  intentId?: IntentId;
  before: string;
  after: string;
}

export type EditRegionResult =
  | { ok: true; rev: Rev; added: number; removed: number }
  | { ok: false; code: "NOT_FOUND" | "OLD_TEXT_NOT_FOUND" | "OLD_TEXT_AMBIGUOUS"; current?: string };

export type CreateFileResult = { ok: true; rev: Rev } | { ok: false; code: "BAD_ARGS" };

export interface ProjectStoreOptions {
  onEvent?: (e: FeedEventBody) => void;
  /** Maps a foreign Yjs transaction origin to an actor id. Default: every foreign write is "human". */
  resolveActor?: (origin: unknown) => string;
}

interface PendingForeign {
  actor: string;
  timer: ReturnType<typeof setTimeout>;
}

export function badArgs(msg: string): Error {
  return Object.assign(new Error(msg), { code: "BAD_ARGS" as const });
}

/** Counts added and removed lines between two texts. */
export function lineDelta(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** A relative POSIX path with no empty, ".", ".." segments, no backslashes, no NUL. */
export function isValidProjectPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export class ProjectStore {
  readonly ydoc: Y.Doc;
  private readonly files: Y.Map<Y.Text>;
  private _rev: Rev = 0;
  private readonly fileRevs = new Map<string, Rev>();
  /** Content of each file as of the last recorded change; the `before` of the next change. */
  private readonly known = new Map<string, string>();
  private readonly pending = new Map<string, PendingForeign>();
  private readonly listeners = new Set<(c: FileChange) => void>();
  private readonly onEvent: ((e: FeedEventBody) => void) | undefined;
  private readonly resolveActor: (origin: unknown) => string;

  constructor(opts: ProjectStoreOptions = {}) {
    this.onEvent = opts.onEvent;
    this.resolveActor = opts.resolveActor ?? (() => "human");
    this.ydoc = new Y.Doc({ gc: false });
    this.files = this.ydoc.getMap<Y.Text>("files");
    this.files.observeDeep((events, tr) => this.onDeepEvents(events, tr));
  }

  get rev(): Rev {
    return this._rev;
  }

  /** Initial load. Rev stays 0, nothing is emitted. Existing keys are overwritten. */
  loadFiles(files: Record<string, string>): void {
    this.ydoc.transact(() => {
      for (const [path, content] of Object.entries(files)) {
        if (!isValidProjectPath(path)) throw badArgs(`invalid path: ${path}`);
        const text = new Y.Text();
        text.insert(0, content);
        this.files.set(path, text);
        this.known.set(path, content);
        this.fileRevs.set(path, 0);
      }
    }, HIVE_ORIGIN);
  }

  listFiles(): FileInfo[] {
    this.flushForeign();
    const out: FileInfo[] = [];
    for (const path of this.files.keys()) out.push({ path, rev: this.fileRevs.get(path) ?? 0 });
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  readFile(path: string): { content: string; rev: Rev } | null {
    this.flushForeign(path);
    const text = this.files.get(path);
    if (!text) return null;
    return { content: text.toString(), rev: this.fileRevs.get(path) ?? 0 };
  }

  allFiles(): Record<string, string> {
    this.flushForeign();
    const out: Record<string, string> = {};
    for (const [path, text] of this.files.entries()) out[path] = text.toString();
    return out;
  }

  editRegion(args: { actor: string; intentId?: IntentId; path: string; oldText: string; newText: string }): EditRegionResult {
    const { actor, intentId, path, oldText, newText } = args;
    if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string" || typeof actor !== "string") {
      throw badArgs("editRegion: path, oldText, newText and actor must be strings");
    }
    if (oldText.length === 0) throw badArgs("editRegion: oldText must not be empty");
    this.flushForeign(path);
    const text = this.files.get(path);
    if (!text) return { ok: false, code: "NOT_FOUND" };
    const before = text.toString();
    const first = before.indexOf(oldText);
    if (first < 0) return { ok: false, code: "OLD_TEXT_NOT_FOUND", current: before };
    if (before.indexOf(oldText, first + 1) >= 0) return { ok: false, code: "OLD_TEXT_AMBIGUOUS", current: before };
    this.ydoc.transact(() => {
      text.delete(first, oldText.length);
      text.insert(first, newText);
    }, HIVE_ORIGIN);
    const after = text.toString();
    const { added, removed } = this.commit(path, actor, intentId, before, after);
    return { ok: true, rev: this._rev, added, removed };
  }

  createFile(args: { actor: string; intentId?: IntentId; path: string; content: string }): CreateFileResult {
    const { actor, intentId, path, content } = args;
    if (typeof content !== "string" || typeof actor !== "string" || !isValidProjectPath(path)) return { ok: false, code: "BAD_ARGS" };
    this.flushForeign(path);
    if (this.files.has(path)) return { ok: false, code: "BAD_ARGS" };
    this.ydoc.transact(() => {
      const text = new Y.Text();
      text.insert(0, content);
      this.files.set(path, text);
    }, HIVE_ORIGIN);
    this.commit(path, actor, intentId, "", content);
    return { ok: true, rev: this._rev };
  }

  /** Whole-file replacement attributed to a human (tests and HTTP). Creates the file if missing. */
  humanReplaceFile(humanId: HumanId, path: string, content: string): { rev: Rev } {
    if (typeof content !== "string" || typeof humanId !== "string" || !isValidProjectPath(path)) {
      throw badArgs("humanReplaceFile: bad arguments");
    }
    this.flushForeign(path);
    const existing = this.files.get(path);
    const before = existing ? existing.toString() : "";
    this.ydoc.transact(() => {
      if (existing) {
        existing.delete(0, existing.length);
        existing.insert(0, content);
      } else {
        const text = new Y.Text();
        text.insert(0, content);
        this.files.set(path, text);
      }
    }, HIVE_ORIGIN);
    this.commit(path, humanId, undefined, before, content);
    return { rev: this._rev };
  }

  onChange(cb: (c: FileChange) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Records pending foreign (web editor) changes now instead of waiting for the debounce.
   * Called automatically by every read and by own writes to the same file.
   */
  flushForeign(path?: string): void {
    if (path !== undefined) {
      const p = this.pending.get(path);
      if (p) this.flushOne(path, p);
      return;
    }
    for (const [key, p] of [...this.pending.entries()]) this.flushOne(key, p);
  }

  /** Cancels debounce timers; pending changes are recorded first. */
  dispose(): void {
    this.flushForeign();
  }

  // ---------- internals ----------

  private commit(path: string, actor: string, intentId: IntentId | undefined, before: string, after: string): { added: number; removed: number } {
    this._rev += 1;
    const rev = this._rev;
    this.fileRevs.set(path, rev);
    if (this.files.has(path)) this.known.set(path, after);
    else this.known.delete(path);
    const { added, removed } = lineDelta(before, after);
    const change: FileChange = intentId === undefined ? { path, rev, actor, before, after } : { path, rev, actor, intentId, before, after };
    for (const cb of [...this.listeners]) cb(change);
    if (this.onEvent) {
      this.onEvent(intentId === undefined ? { type: "edit_applied", agentId: actor, path, rev, added, removed } : { type: "edit_applied", agentId: actor, intentId, path, rev, added, removed });
    }
    return { added, removed };
  }

  private onDeepEvents(events: Y.YEvent<any>[], tr: Y.Transaction): void {
    if (tr.origin === HIVE_ORIGIN) return;
    const touched = new Set<string>();
    for (const ev of events) {
      if (ev.target === this.files) {
        for (const key of (ev as Y.YMapEvent<Y.Text>).keysChanged) touched.add(key);
      } else {
        const key = ev.path[0];
        if (typeof key === "string") touched.add(key);
      }
    }
    if (touched.size === 0) return;
    const actor = this.resolveActor(tr.origin);
    for (const path of touched) this.schedule(path, actor);
  }

  private schedule(path: string, actor: string): void {
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const p = this.pending.get(path);
      if (p) this.flushOne(path, p);
    }, FOREIGN_DEBOUNCE_MS);
    timer.unref?.();
    this.pending.set(path, { actor, timer });
  }

  private flushOne(path: string, p: PendingForeign): void {
    clearTimeout(p.timer);
    this.pending.delete(path);
    const text = this.files.get(path);
    const after = text ? text.toString() : "";
    const before = this.known.get(path) ?? "";
    if (before === after) return; // typed and undone within one pause: nothing to record
    this.commit(path, p.actor, undefined, before, after);
  }
}
