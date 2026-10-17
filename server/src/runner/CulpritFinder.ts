import type { ChangeSet, CulpritReport, CulpritVariant, IntentId, Runner, Snapshot } from "@hive/shared";
import { applyEdits } from "../core/index.js";
import { Semaphore } from "./util.js";

export const MAX_SUSPECTS = 6;
/** Pair variants are only run when there are at most this many groups (<= 6 pairs). */
export const MAX_PAIR_GROUPS = 4;

/** Consecutive change sets of one agent, searched as a unit (agents split one logical change into several intents). */
export interface SuspectGroup {
  label: string; // ASCII short name, e.g. "andrii"
  agentId: string;
  sets: ChangeSet[];
  ids: IntentId[];
}

interface PreparedVariant {
  label: string;
  applied: IntentId[];
  files?: Record<string, string>;
  applyError?: string;
}

/**
 * Finds which agent's work (or which pair of agents) broke the tests by running variants in parallel.
 * Change sets are grouped per agent (consecutive intents of one agent = one group):
 * `green+<agent>` (green snapshot plus that group) and `all-<agent>` (all except it) first; then
 * `green+<a>+<b>` pairs when every group is green alone and there are 2..4 groups. With a single
 * red group of several intents, per-intent variants inside the group try to narrow it down.
 */
export class CulpritFinder {
  private readonly sem: Semaphore;

  constructor(
    private readonly runner: Runner,
    maxParallel = 8,
  ) {
    this.sem = new Semaphore(maxParallel);
  }

  async find(green: Snapshot, changeSets: ChangeSet[], onVariant?: (v: CulpritVariant) => void): Promise<CulpritReport> {
    const started = Date.now();
    const sets = changeSets.slice(-MAX_SUSPECTS);
    const allIds = sets.map((s) => s.id);
    const variants: CulpritVariant[] = [];
    const report = (kind: CulpritReport["kind"], culprits: IntentId[]): CulpritReport => ({
      kind,
      culprits,
      greenRev: green.rev,
      variants,
      durationMs: Date.now() - started,
    });
    if (sets.length === 0) return report("unknown", []);

    const groups = groupByAgent(sets);

    // Phase 1: one variant pair per group.
    const prepared: PreparedVariant[] = [];
    const dependent = new Set<string>();
    for (const g of groups) {
      const alone = this.prepare(green.files, g.sets, `green+${g.label}`);
      if (alone.applyError) dependent.add(g.label);
      prepared.push(alone);
      prepared.push(this.prepare(green.files, groups.filter((o) => o !== g).flatMap((o) => o.sets), `all-${g.label}`));
    }
    const groupResults = await this.runAll(prepared, variants, onVariant);
    const okOf = (label: string): boolean | undefined => groupResults.get(label)?.ok;

    const singleGroups = groups.filter((g) => okOf(`all-${g.label}`) === true && okOf(`green+${g.label}`) === false && !dependent.has(g.label));
    if (singleGroups.length === 1) {
      const g = singleGroups[0]!;
      if (groups.length === 1 && g.sets.length > 1) {
        // Only one agent's work is in play: try to narrow it down to one of its intents.
        const narrowed = await this.narrowInsideGroup(green, g, variants, onVariant);
        return report("single", narrowed ?? g.ids);
      }
      return report("single", g.ids);
    }

    if (dependent.size > 0) {
      // A group's patches only apply on top of another group's: suspects are the dependent groups and everything before them.
      const lastDependent = Math.max(...groups.map((g, i) => (dependent.has(g.label) ? i : -1)));
      return report("dependent", groups.slice(0, lastDependent + 1).flatMap((g) => g.ids));
    }

    // Phase 2: pairs of groups, only when every group is green alone.
    const everyGroupGreen = groups.every((g) => okOf(`green+${g.label}`) === true);
    if (everyGroupGreen && groups.length >= 2 && groups.length <= MAX_PAIR_GROUPS) {
      const pairs: { variant: PreparedVariant; a: SuspectGroup; b: SuspectGroup }[] = [];
      for (let j = 0; j < groups.length; j += 1) {
        for (let k = j + 1; k < groups.length; k += 1) {
          const a = groups[j]!;
          const b = groups[k]!;
          pairs.push({ variant: this.prepare(green.files, [...a.sets, ...b.sets], `green+${a.label}+${b.label}`), a, b });
        }
      }
      const pairResults = await this.runAll(
        pairs.map((p) => p.variant),
        variants,
        onVariant,
      );
      const redPairs = pairs.filter((p) => pairResults.get(p.variant.label)?.ok === false && !p.variant.applyError);
      if (redPairs.length === 1) return report("pair", [...redPairs[0]!.a.ids, ...redPairs[0]!.b.ids]);
      if (redPairs.length > 1) {
        // one group red with every partner -> it is the odd one out
        const counts = new Map<string, number>();
        for (const p of redPairs) for (const g of [p.a, p.b]) counts.set(g.label, (counts.get(g.label) ?? 0) + 1);
        const hot = groups.filter((g) => counts.get(g.label) === redPairs.length);
        if (hot.length === 1 && redPairs.length === groups.length - 1) return report("single", hot[0]!.ids);
        return report("pair", [...redPairs[0]!.a.ids, ...redPairs[0]!.b.ids]);
      }
    }

    return report("unknown", allIds);
  }

  /** Per-intent variants inside one red group; returns the one intent that explains it, or undefined. */
  private async narrowInsideGroup(green: Snapshot, g: SuspectGroup, sink: CulpritVariant[], onVariant?: (v: CulpritVariant) => void): Promise<IntentId[] | undefined> {
    const prepared: PreparedVariant[] = [];
    for (const s of g.sets) {
      const alone = this.prepare(green.files, [s], `green+${s.id}`);
      if (alone.applyError) return undefined; // intents of one agent build on each other: the group is the unit
      prepared.push(alone);
      prepared.push(this.prepare(green.files, g.sets.filter((o) => o.id !== s.id), `all-${s.id}`));
    }
    if (prepared.some((p) => p.applyError)) return undefined;
    const results = await this.runAll(prepared, sink, onVariant);
    const single = g.ids.filter((id) => results.get(`all-${id}`)?.ok === true && results.get(`green+${id}`)?.ok === false);
    return single.length === 1 ? single : undefined;
  }

  private prepare(base: Record<string, string>, sets: ChangeSet[], label: string): PreparedVariant {
    let files: Record<string, string> = base;
    for (const s of sets) {
      const res = applyEdits(files, s.edits);
      if (!res.ok) {
        return { label, applied: sets.map((x) => x.id), applyError: `${s.id}: edit ${res.index} on ${res.path} did not apply` };
      }
      files = res.files;
    }
    return { label, applied: sets.map((x) => x.id), files };
  }

  private async runAll(prepared: PreparedVariant[], sink: CulpritVariant[], onVariant?: (v: CulpritVariant) => void): Promise<Map<string, CulpritVariant>> {
    const results = new Map<string, CulpritVariant>();
    const record = (v: CulpritVariant) => {
      results.set(v.label, v);
      sink.push(v);
      onVariant?.(v);
    };
    await Promise.all(
      prepared.map(async (p) => {
        if (!p.files) {
          record({ label: p.label, applied: p.applied, ok: false, applyError: p.applyError ?? "patch did not apply" });
          return;
        }
        const files = p.files;
        let ok = false;
        let applyError: string | undefined;
        try {
          const r = await this.sem.run(() => this.runner.runTests(files));
          ok = r.ok;
        } catch (err) {
          applyError = `runner error: ${err instanceof Error ? err.message : String(err)}`;
        }
        record(applyError ? { label: p.label, applied: p.applied, ok, applyError } : { label: p.label, applied: p.applied, ok });
      }),
    );
    return results;
  }
}

/** Consecutive change sets of the same agent form one group, labelled by a unique ASCII short name. */
export function groupByAgent(sets: ChangeSet[]): SuspectGroup[] {
  const groups: SuspectGroup[] = [];
  for (const s of sets) {
    const last = groups[groups.length - 1];
    if (last && last.agentId === s.agentId) {
      last.sets.push(s);
      last.ids.push(s.id);
    } else {
      groups.push({ label: shortName(s), agentId: s.agentId, sets: [s], ids: [s.id] });
    }
  }
  const used = new Map<string, number>();
  for (const g of groups) {
    const n = (used.get(g.label) ?? 0) + 1;
    used.set(g.label, n);
    if (n > 1) g.label = `${g.label}-${n}`;
  }
  return groups;
}

/** Human-readable ASCII label for an agent: the humanId, else the agentId without its "agent-" prefix. */
export function shortName(s: Pick<ChangeSet, "agentId" | "humanId">): string {
  const raw = (s.humanId || s.agentId.replace(/^agent-/, "") || s.agentId).toLowerCase();
  const clean = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean : "agent";
}
