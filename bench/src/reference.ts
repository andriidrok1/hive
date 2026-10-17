import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResult } from "@hive/shared";
import { hiveBenchDir } from "./paths.js";
import { exec, readProjectFiles, resetDir, runVitest, writeProjectFiles } from "./project.js";
import { readExtraTests, type Scenario } from "./scenarios.js";

export interface VariantCheck {
  name: string;
  applied: boolean;
  applyError?: string;
  result?: TestResult;
}

export interface ScenarioCheck {
  base: VariantCheck;
  a: VariantCheck;
  b: VariantCheck;
  ab: VariantCheck; // a then b, plus extraTests
  ba: VariantCheck; // b then a: both orders must apply, which proves the hunks do not overlap
  combined: VariantCheck; // combined.patch, plus extraTests
}

/** Fresh demo-app copy at .hive/bench/<id>/<name>, as its own git repo so `git apply` paths resolve there. */
export async function prepareCopy(id: string, name: string, files = readProjectFiles()): Promise<string> {
  const dir = join(hiveBenchDir, id, name);
  resetDir(dir);
  writeProjectFiles(dir, files);
  const init = await exec("git", ["init", "-q"], dir);
  if (init.code !== 0) throw new Error(`git init failed in ${dir}: ${init.stderr}`);
  return dir;
}

export async function applyPatches(dir: string, patchFiles: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const file of patchFiles) {
    const res = await exec("git", ["apply", "--whitespace=nowarn", file], dir);
    if (res.code !== 0) return { ok: false, error: `${file}: ${res.stderr || res.stdout}`.trim() };
  }
  return { ok: true };
}

async function checkVariant(
  scenario: Scenario,
  name: string,
  patches: string[],
  withExtra: boolean,
  files: Record<string, string>,
): Promise<VariantCheck> {
  const dir = await prepareCopy(scenario.id, name, files);
  const applied = await applyPatches(dir, patches);
  if (!applied.ok) return { name, applied: false, applyError: applied.error };
  if (withExtra) writeProjectFiles(dir, { [scenario.extraTests]: readExtraTests(scenario) });
  const result = await runVitest(dir);
  return { name, applied: true, result };
}

/** Runs the five checks of a scenario against its reference folder, all in parallel. */
export async function checkScenario(scenario: Scenario, refFolder: string): Promise<ScenarioCheck> {
  const files = readProjectFiles();
  const a = join(refFolder, "a.patch");
  const b = join(refFolder, "b.patch");
  const combined = join(refFolder, "combined.patch");
  const [base, ra, rb, rab, rba, rc] = await Promise.all([
    checkVariant(scenario, "base", [], false, files),
    checkVariant(scenario, "a", [a], false, files),
    checkVariant(scenario, "b", [b], false, files),
    checkVariant(scenario, "ab", [a, b], true, files),
    checkVariant(scenario, "ba", [b, a], true, files),
    checkVariant(scenario, "combined", [combined], true, files),
  ]);
  return { base, a: ra, b: rb, ab: rab, ba: rba, combined: rc };
}

/** Files touched by a unified diff (from the `+++ b/` headers; `/dev/null` for deletions is skipped). */
export function patchFiles(patchFile: string): string[] {
  const text = readFileSync(patchFile, "utf8");
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

export function describeCheck(v: VariantCheck): string {
  if (!v.applied) return `${v.name}: did not apply: ${v.applyError}`;
  const r = v.result!;
  const fails = r.failures.map((f) => `  - ${f.name}: ${f.message.split("\n")[0]}`).join("\n");
  return `${v.name}: ok=${r.ok} passed=${r.passed} failed=${r.failed}${fails ? "\n" + fails : ""}`;
}
