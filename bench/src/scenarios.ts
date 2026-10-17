import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentId, HumanId } from "@hive/shared";
import { referenceDir, scenariosDir } from "./paths.js";

export interface ScenarioAgent {
  agentId: AgentId;
  humanId: HumanId;
  task: string;
  // Files this agent is told it owns. The first agent is "A" (a.patch), the second "B" (b.patch).
  // A reference patch alone may leave tests red only inside files the other agent owns.
  owns?: string[];
}

export interface Scenario {
  id: string; // "s01-double-tax", file name without .json
  title: string;
  conflict: boolean; // false = control, the two tasks must combine cleanly
  agents: ScenarioAgent[]; // exactly two
  startDelaysMs: Record<AgentId, number>;
  expectedCulprits: AgentId[]; // owners the culprit report should name; empty for controls
  acceptance: string; // "npm test"
  extraTests: string; // path inside the project, e.g. "test/s01.accept.test.ts"
  notes?: string;
}

export class ScenarioValidationError extends Error {
  constructor(public readonly file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

const ID_RE = /^[sc]\d{2}-[a-z0-9-]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Runtime check mirroring the Scenario type. Throws ScenarioValidationError with the first problem. */
export function validateScenario(raw: unknown, file = "<inline>"): Scenario {
  const fail = (msg: string): never => {
    throw new ScenarioValidationError(file, msg);
  };
  if (!isRecord(raw)) return fail("not an object");
  const { id, title, conflict, agents, startDelaysMs, expectedCulprits, acceptance, extraTests, notes } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return fail(`id must match ${ID_RE}`);
  if (typeof title !== "string" || title.length === 0) return fail("title required");
  if (typeof conflict !== "boolean") return fail("conflict must be boolean");
  if (!Array.isArray(agents) || agents.length !== 2) return fail("agents must have exactly 2 entries");
  const parsedAgents: ScenarioAgent[] = agents.map((a, i) => {
    if (!isRecord(a)) return fail(`agents[${i}] not an object`);
    if (typeof a.agentId !== "string" || !a.agentId) return fail(`agents[${i}].agentId required`);
    if (typeof a.humanId !== "string" || !a.humanId) return fail(`agents[${i}].humanId required`);
    if (typeof a.task !== "string" || a.task.length < 10) return fail(`agents[${i}].task too short`);
    if (a.owns !== undefined && !(Array.isArray(a.owns) && a.owns.every((f) => typeof f === "string" && /^(src|test)\//.test(f)))) {
      return fail(`agents[${i}].owns must list src/ or test/ paths`);
    }
    return { agentId: a.agentId, humanId: a.humanId, task: a.task, ...(a.owns ? { owns: a.owns as string[] } : {}) };
  });
  const ids = parsedAgents.map((a) => a.agentId);
  if (new Set(ids).size !== 2) return fail("agentIds must differ");
  if (!isRecord(startDelaysMs)) return fail("startDelaysMs must be an object");
  const delays: Record<string, number> = {};
  for (const agentId of ids) {
    const d = startDelaysMs[agentId];
    if (typeof d !== "number" || d < 0 || !Number.isFinite(d)) return fail(`startDelaysMs.${agentId} must be a number >= 0`);
    delays[agentId] = d;
  }
  for (const k of Object.keys(startDelaysMs)) if (!ids.includes(k)) return fail(`startDelaysMs has unknown agent ${k}`);
  if (!Array.isArray(expectedCulprits) || !expectedCulprits.every((c) => typeof c === "string" && ids.includes(c))) {
    return fail("expectedCulprits must list scenario agentIds");
  }
  if (conflict && expectedCulprits.length === 0) return fail("conflict scenarios need expectedCulprits");
  if (!conflict && expectedCulprits.length !== 0) return fail("controls must have empty expectedCulprits");
  if (typeof acceptance !== "string" || !acceptance) return fail("acceptance required");
  if (typeof extraTests !== "string" || !/^test\/[\w.-]+\.test\.ts$/.test(extraTests)) {
    return fail("extraTests must look like test/<name>.test.ts");
  }
  if (notes !== undefined && typeof notes !== "string") return fail("notes must be a string");
  return {
    id,
    title,
    conflict,
    agents: parsedAgents,
    startDelaysMs: delays,
    expectedCulprits: expectedCulprits as string[],
    acceptance,
    extraTests,
    ...(notes !== undefined ? { notes } : {}),
  };
}

/** Where the content of `scenario.extraTests` lives in the bench. */
export function extraTestsSourcePath(scenario: Scenario, dir = scenariosDir): string {
  return join(dir, "extra", basename(scenario.extraTests));
}

export function readExtraTests(scenario: Scenario, dir = scenariosDir): string {
  return readFileSync(extraTestsSourcePath(scenario, dir), "utf8");
}

/**
 * vitest `-t` pattern that selects only the acceptance tests: the first describe name in the extra tests file
 * (regex-escaped), falling back to "<sNN> acceptance".
 */
export function acceptanceFilter(scenario: Scenario, dir = scenariosDir): string {
  const m = /describe\(\s*"([^"]+)"/.exec(readExtraTests(scenario, dir));
  const name = m?.[1] ?? `${scenario.id.slice(0, 3)} acceptance`;
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Folder with a.patch / b.patch / combined.patch, or null if this scenario has no verified reference yet. */
export function referenceFolder(scenario: Scenario, dir = referenceDir): string | null {
  const folder = join(dir, scenario.id);
  const ok = ["a.patch", "b.patch", "combined.patch"].every((f) => existsSync(join(folder, f)));
  return ok ? folder : null;
}

export function loadScenario(file: string): Scenario {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  const s = validateScenario(raw, file);
  const expectedId = basename(file, ".json");
  if (s.id !== expectedId) throw new ScenarioValidationError(file, `id "${s.id}" must equal file name "${expectedId}"`);
  if (!existsSync(extraTestsSourcePath(s, join(file, "..")))) {
    throw new ScenarioValidationError(file, `missing extra tests file ${extraTestsSourcePath(s, join(file, ".."))}`);
  }
  return s;
}

export function loadScenarios(dir = scenariosDir): Scenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadScenario(join(dir, f)));
}

/** Resolves "s01,c01" or "s01-double-tax" against the loaded list; a bare prefix matches by id prefix. */
export function selectScenarios(all: Scenario[], spec?: string): Scenario[] {
  if (!spec || spec === "all") return all;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  return wanted.map((w) => {
    const hit = all.find((s) => s.id === w) ?? all.find((s) => s.id.startsWith(w + "-"));
    if (!hit) throw new Error(`unknown scenario "${w}"; have ${all.map((s) => s.id).join(", ")}`);
    return hit;
  });
}
