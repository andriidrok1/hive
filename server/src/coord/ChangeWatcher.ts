import { createTwoFilesPatch } from "diff";
import type { AgentId, FeedEventBody, HiveMode, Intent, IntentStatus, LLM } from "@hive/shared";
import { analyzeFile, normalizeCode, symbolSources, type SymbolSource } from "./analyze.js";
import { clip, type BriefingQueue } from "./BriefingQueue.js";
import type { CallGraph } from "./CallGraph.js";
import type { ReadLogLike, StoreChange } from "./deps.js";
import type { IntentRegistry } from "./IntentRegistry.js";
import { CHECK_PROMPTS } from "./llm.js";

export interface ChangeWatcherDeps {
  llm: LLM;
  graph: CallGraph;
  reads: ReadLogLike;
  intents: Pick<IntentRegistry, "list">;
  briefings: BriefingQueue;
  onEvent: (e: FeedEventBody) => void;
  mode: HiveMode;
}

export interface SymbolChange {
  symbol: string; // old name
  kind: "signature" | "body" | "removed" | "added" | "renamed";
  renamedTo?: string;
}

const ACTIVE: readonly IntentStatus[] = ["approved", "in_progress"];

function tokens(s: string): Set<string> {
  return new Set(s.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 1));
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
}

function sameAfterRename(oldName: string, oldSrc: SymbolSource, newName: string, newSrc: SymbolSource): boolean {
  const re = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  const renamed = (oldSrc.sig + " " + oldSrc.body).replace(re, newName);
  return renamed === newSrc.sig + " " + newSrc.body;
}

/** Symbol-level diff of one file. Comment and whitespace changes are invisible here. */
export function diffSymbols(path: string, before: string, after: string): SymbolChange[] {
  const a = symbolSources(path, before);
  const b = symbolSources(path, after);
  const changes: SymbolChange[] = [];
  const removed: string[] = [];
  const added: string[] = [];

  for (const [name, src] of a) {
    const next = b.get(name);
    if (!next) {
      removed.push(name);
      continue;
    }
    if (next.sig !== src.sig) changes.push({ symbol: name, kind: "signature" });
    else if (next.body !== src.body) changes.push({ symbol: name, kind: "body" });
  }
  for (const name of b.keys()) if (!a.has(name)) added.push(name);

  const usedAdded = new Set<string>();
  for (const oldName of removed) {
    const oldSrc = a.get(oldName)!;
    let match: string | undefined;
    let bestScore = 0;
    for (const newName of added) {
      if (usedAdded.has(newName)) continue;
      const newSrc = b.get(newName)!;
      if (newSrc.kind !== oldSrc.kind) continue;
      if (sameAfterRename(oldName, oldSrc, newName, newSrc)) {
        match = newName;
        bestScore = 1;
        break;
      }
      const score = dice(tokens(oldSrc.body), tokens(newSrc.body));
      if (score > bestScore && score >= 0.6 && oldSrc.body.length > 0) {
        match = newName;
        bestScore = score;
      }
    }
    if (match) {
      usedAdded.add(match);
      changes.push({ symbol: oldName, kind: "renamed", renamedTo: match });
    } else {
      changes.push({ symbol: oldName, kind: "removed" });
    }
  }
  for (const newName of added) if (!usedAdded.has(newName)) changes.push({ symbol: newName, kind: "added" });
  return changes;
}

function describe(c: SymbolChange): string {
  switch (c.kind) {
    case "signature":
      return `changed the signature of ${c.symbol}`;
    case "body":
      return `changed the body of ${c.symbol}`;
    case "removed":
      return `removed ${c.symbol}`;
    case "added":
      return `added ${c.symbol}`;
    case "renamed":
      return `renamed ${c.symbol} to ${c.renamedTo}`;
  }
}

interface Affected {
  usages: { file: string; line: number }[];
  why: string[];
}

/** Turns one applied edit into symbol_changed briefings for the agents it affects. */
export class ChangeWatcher {
  constructor(private readonly deps: ChangeWatcherDeps) {}

  async onEdit(change: StoreChange): Promise<void> {
    if (this.deps.mode !== "hive") return;
    if (change.before === change.after) return;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(change.path)) return;
    if (normalizeCode(change.path, change.before) === normalizeCode(change.path, change.after)) return;

    const changes = diffSymbols(change.path, change.before, change.after);
    if (changes.length === 0) return;

    const excluded = new Set<string>([change.actor]);
    const intentOwner = change.intentId ? this.deps.intents.list().find((i) => i.id === change.intentId)?.agentId : undefined;
    if (intentOwner) excluded.add(intentOwner);

    const diff = this.diffFor(change);
    const meaning = await this.meaningOf(change, changes, diff);

    for (const c of changes) {
      if (c.kind === "added") continue; // nobody depends on a symbol that did not exist
      const affected = this.affectedBy(change, c.symbol, excluded);
      for (const [agentId, info] of affected) {
        const mechanical = `${change.actor} ${describe(c)} in ${change.path}`;
        const summary = `${mechanical}${meaning ? `: ${meaning}` : ""}. ${info.why.join("; ")}. Re-check your usage before your next edit.`;
        this.deps.briefings.push({
          toAgent: agentId,
          kind: "symbol_changed",
          ...(change.actor.startsWith("agent-") ? { fromAgent: change.actor } : { fromHuman: change.actor }),
          summary,
          details: {
            file: change.path,
            symbol: c.symbol,
            ...(change.intentId ? { intentId: change.intentId } : {}),
            diff,
            yourUsages: info.usages,
          },
          requiresAck: true,
        });
      }
    }
  }

  private diffFor(change: StoreChange): string {
    const patch = createTwoFilesPatch(change.path, change.path, change.before, change.after, `rev ${change.rev - 1}`, `rev ${change.rev}`, { context: 2 });
    return clip(patch.replace(/^=+\n/, ""), 2000);
  }

  private async meaningOf(change: StoreChange, changes: SymbolChange[], diff: string): Promise<string> {
    const user = JSON.stringify({ file: change.path, actor: change.actor, intentId: change.intentId, changes: changes.map(describe), diff: clip(diff, 3000) }, null, 2);
    try {
      const raw = await this.deps.llm.json<{ meaning?: unknown }>(CHECK_PROMPTS.meaning, user, "{meaning: string}");
      const meaning = typeof raw?.meaning === "string" ? raw.meaning.replace(/\s+/g, " ").trim() : "";
      return clip(meaning, 160);
    } catch {
      return "";
    }
  }

  /** Readers of the symbol, readers of its callers, and owners of active intents on its callers. */
  private affectedBy(change: StoreChange, symbol: string, excluded: Set<string>): Map<AgentId, Affected> {
    const out = new Map<AgentId, Affected>();
    const add = (agentId: AgentId, usage: { file: string; line: number } | null, why: string) => {
      if (excluded.has(agentId)) return;
      const entry = out.get(agentId) ?? { usages: [], why: [] };
      if (usage && !entry.usages.some((u) => u.file === usage.file && u.line === usage.line)) entry.usages.push(usage);
      if (!entry.why.includes(why)) entry.why.push(why);
      out.set(agentId, entry);
    };

    // call sites: the graph (other files, maybe already re-analyzed) plus the pre-edit version of this file
    const sites = new Map<string, { file: string; line: number; caller: string | null }>();
    for (const s of this.deps.graph.callersOf(symbol)) sites.set(`${s.file}:${s.line}`, s);
    for (const s of analyzeFile(change.path, change.before).calls) if (s.callee === symbol) sites.set(`${s.file}:${s.line}`, s);

    for (const r of this.deps.reads.readersOf(change.path, symbol)) {
      if (r.rev >= change.rev) continue;
      add(r.agentId, null, `You read ${symbol} at rev ${r.rev}; it changed at rev ${change.rev}`);
    }

    const activeIntents: Intent[] = this.deps.intents.list().filter((i) => ACTIVE.includes(i.status));
    for (const site of sites.values()) {
      const where = site.caller ? `${site.caller} (${site.file}:${site.line})` : `${site.file}:${site.line}`;
      for (const r of this.deps.reads.readersOf(site.file)) {
        if (r.rev >= change.rev && site.file === change.path) continue;
        add(r.agentId, { file: site.file, line: site.line }, `You call ${symbol} from ${where}`);
      }
      for (const i of activeIntents) {
        if (i.target.file === site.file && i.target.symbol === site.caller) {
          add(i.agentId, { file: site.file, line: site.line }, `Your intent ${i.id} targets ${site.caller}, which calls ${symbol} at ${site.file}:${site.line}`);
        }
      }
    }

    // readers of the symbol also get the usages inside files they read
    for (const [agentId, entry] of out) {
      if (entry.usages.length > 0) continue;
      const readFiles = new Set(this.deps.reads.readsOf(agentId).map((r) => r.path));
      for (const site of sites.values()) if (readFiles.has(site.file)) entry.usages.push({ file: site.file, line: site.line });
    }
    return out;
  }
}
