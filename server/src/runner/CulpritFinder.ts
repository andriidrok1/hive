import type { ChangeSet, CulpritReport, CulpritVariant, IntentId, Runner, Snapshot } from "@hive/shared";
import { applyEdits } from "./applyEdits.js";
import { Semaphore } from "./util.js";

export const MAX_SUSPECTS = 6;
/** Pair variants are only run when there are at most this many suspects (<= 6 pairs). */
export const MAX_PAIR_SUSPECTS = 4;

interface PreparedVariant {
  label: string;
  applied: IntentId[];
  files?: Record<string, string>;
  applyError?: string;
}

/**
 * Finds which change set (or pair) broke the tests by running variants in parallel:
 * `green+<id>` (green snapshot plus that change set) and `all-<id>` (all except it),
 * then `green+<j>+<k>` pairs when every single is green and n <= 4.
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
    const ids = sets.map((s) => s.id);
    const variants: CulpritVariant[] = [];
    const report = (kind: CulpritReport["kind"], culprits: IntentId[]): CulpritReport => ({
      kind,
      culprits,
      greenRev: green.rev,
      variants,
      durationMs: Date.now() - started,
    });
    if (sets.length === 0) return report("unknown", []);

    // Phase 1: singles.
    const singles: PreparedVariant[] = [];
    const dependent = new Set<IntentId>();
    for (const s of sets) {
      const alone = this.prepare(green.files, [s], `green+${s.id}`);
      if (alone.applyError) dependent.add(s.id);
      singles.push(alone);
      singles.push(this.prepare(green.files, sets.filter((o) => o.id !== s.id), `all-${s.id}`));
    }
    const singleResults = await this.runAll(singles, variants, onVariant);
    const okOf = (label: string): boolean | undefined => singleResults.get(label)?.ok;

    const singleCulprits = ids.filter((id) => okOf(`all-${id}`) === true && okOf(`green+${id}`) === false && !dependent.has(id));
    if (singleCulprits.length === 1) return report("single", singleCulprits);

    if (dependent.size > 0) {
      // A patch only applies on top of an earlier one: suspects are the dependent sets and everything before them.
      const lastDependent = Math.max(...sets.map((s, i) => (dependent.has(s.id) ? i : -1)));
      return report("dependent", ids.slice(0, lastDependent + 1));
    }

    // Phase 2: pairs, only when every change set is green alone.
    const everySingleGreen = ids.every((id) => okOf(`green+${id}`) === true);
    if (everySingleGreen && sets.length >= 2 && sets.length <= MAX_PAIR_SUSPECTS) {
      const pairs: PreparedVariant[] = [];
      for (let j = 0; j < sets.length; j += 1) {
        for (let k = j + 1; k < sets.length; k += 1) {
          const a = sets[j]!;
          const b = sets[k]!;
          pairs.push(this.prepare(green.files, [a, b], `green+${a.id}+${b.id}`));
        }
      }
      const pairResults = await this.runAll(pairs, variants, onVariant);
      const redPairs = pairs.filter((p) => pairResults.get(p.label)?.ok === false && !p.applyError);
      if (redPairs.length === 1) return report("pair", redPairs[0]!.applied);
      if (redPairs.length > 1) {
        // several pairs red: report the ids that appear in red pairs (likely one set conflicting with many)
        const counts = new Map<IntentId, number>();
        for (const p of redPairs) for (const id of p.applied) counts.set(id, (counts.get(id) ?? 0) + 1);
        const max = Math.max(...counts.values());
        const hot = ids.filter((id) => counts.get(id) === max);
        if (hot.length === 1 && max === redPairs.length) return report("single", hot);
        return report("pair", redPairs[0]!.applied);
      }
    }

    return report("unknown", ids);
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

  private async runAll(
    prepared: PreparedVariant[],
    sink: CulpritVariant[],
    onVariant?: (v: CulpritVariant) => void,
  ): Promise<Map<string, CulpritVariant>> {
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
