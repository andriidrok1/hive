import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Walks up from this file to the folder whose package.json declares npm workspaces. */
export function findRepoRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = resolve(from);
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (json.workspaces) return dir;
      } catch {
        // not the one we want
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root with workspaces not found");
    dir = parent;
  }
}

export const repoRoot = findRepoRoot();
export const benchDir = join(repoRoot, "bench");
export const scenariosDir = join(benchDir, "scenarios");
export const referenceDir = join(benchDir, "reference");
export const resultsDir = join(benchDir, "results");
export const demoAppDir = join(repoRoot, "demo-app");
/** Scratch space for scenario checks. Must stay inside the repo so vitest resolves from the root node_modules. */
export const hiveBenchDir = join(repoRoot, ".hive", "bench");
export const vitestBin = join(repoRoot, "node_modules", ".bin", "vitest");
