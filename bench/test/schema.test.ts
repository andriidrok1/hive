import { describe, expect, it } from "vitest";
import { loadScenarios, selectScenarios, validateScenario, ScenarioValidationError, readExtraTests } from "../src/scenarios.js";

const good = {
  id: "s99-example",
  title: "Example",
  conflict: true,
  agents: [
    { agentId: "agent-a", humanId: "a", task: "Do the first thing carefully." },
    { agentId: "agent-b", humanId: "b", task: "Do the second thing carefully." },
  ],
  startDelaysMs: { "agent-a": 0, "agent-b": 1000 },
  expectedCulprits: ["agent-a"],
  acceptance: "npm test",
  extraTests: "test/s99.accept.test.ts",
};

describe("scenario files", () => {
  const all = loadScenarios();

  it("loads 6 conflicts and 2 controls with unique ids", () => {
    expect(all.filter((s) => s.conflict)).toHaveLength(6);
    expect(all.filter((s) => !s.conflict)).toHaveLength(2);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  });

  it("every scenario has a non-empty extra test file that imports from ../src", () => {
    for (const s of all) {
      const text = readExtraTests(s);
      expect(text, s.id).toMatch(/from "\.\.\/src\//);
      expect(text, s.id).toMatch(/\bit\(/);
    }
  });

  it("selects by id or prefix", () => {
    expect(selectScenarios(all, "s01,c01").map((s) => s.id.slice(0, 3))).toEqual(["s01", "c01"]);
    expect(selectScenarios(all, undefined)).toHaveLength(all.length);
    expect(() => selectScenarios(all, "s42")).toThrow(/unknown scenario/);
  });
});

describe("validateScenario", () => {
  it("accepts a well-formed scenario", () => {
    expect(validateScenario(good).id).toBe("s99-example");
  });

  const broken: [string, unknown][] = [
    ["one agent", { ...good, agents: [good.agents[0]] }],
    ["bad id", { ...good, id: "x1" }],
    ["delay for unknown agent", { ...good, startDelaysMs: { ...good.startDelaysMs, "agent-z": 0 } }],
    ["missing delay", { ...good, startDelaysMs: { "agent-a": 0 } }],
    ["culprit not an agent", { ...good, expectedCulprits: ["agent-z"] }],
    ["conflict without culprits", { ...good, expectedCulprits: [] }],
    ["control with culprits", { ...good, conflict: false }],
    ["extraTests outside test/", { ...good, extraTests: "src/x.test.ts" }],
    ["owns outside src/test", { ...good, agents: [{ ...good.agents[0], owns: ["package.json"] }, good.agents[1]] }],
    ["not an object", "nope"],
  ];
  for (const [name, raw] of broken) {
    it(`rejects ${name}`, () => {
      expect(() => validateScenario(raw)).toThrow(ScenarioValidationError);
    });
  }
});
