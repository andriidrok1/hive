import { describe, expect, it } from "vitest";
import type { ToolArgs, ToolName } from "@hive/shared";
import { TOOL_SCHEMAS, TOOL_REQUIRED, systemPrompt } from "../src/index.js";

// Compile-time mirror of ToolArgs: a key is required iff it is not optional in ToolArgs.
// If contracts.ts changes, this object stops compiling, which is the point.
type RequiredKeys<T> = { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T];
type Expected = { [T in ToolName]: RequiredKeys<ToolArgs[T]>[] };
const expectedRequired: Expected = {
  list_files: [],
  read_file: ["path"],
  declare_intent: ["target", "action", "what", "input", "output"],
  edit_region: ["path", "oldText", "newText"],
  create_file: ["path", "content"],
  finish_intent: ["intentId"],
  run_command: ["cmd"],
  run_tests: [],
  ack_briefing: ["briefingId", "response"],
  ask_agent: ["to", "about", "question"],
  reply: ["messageId", "text"],
};

describe("TOOL_SCHEMAS", () => {
  it("has 11 function tools whose names match ToolName", () => {
    expect(TOOL_SCHEMAS).toHaveLength(11);
    const names = TOOL_SCHEMAS.map((t) => (t.type === "function" ? t.function.name : "?")).sort();
    expect(names).toEqual((Object.keys(expectedRequired) as ToolName[]).sort());
    expect(new Set(names).size).toBe(11);
  });

  it("required fields match ToolArgs and every required field has a property", () => {
    for (const t of TOOL_SCHEMAS) {
      if (t.type !== "function") throw new Error("non-function tool");
      const name = t.function.name as ToolName;
      const params = t.function.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
      expect(params.type).toBe("object");
      expect([...params.required].sort()).toEqual([...expectedRequired[name]].sort());
      expect([...TOOL_REQUIRED[name]].sort()).toEqual([...expectedRequired[name]].sort());
      for (const r of params.required) expect(params.properties).toHaveProperty(r);
      expect(t.function.description?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("declare_intent check description explains the isolated scope", () => {
    const t = TOOL_SCHEMAS.find((x) => x.type === "function" && x.function.name === "declare_intent") as unknown as { function: { parameters: { properties: { check: { description: string } } } } };
    const d = t.function.parameters.properties.check.description;
    expect(d).toContain("isolated test file");
    expect(d).toContain("only the exports of the target file");
    expect(d).toContain("no imports");
  });

  it("declare_intent target requires file and symbol", () => {
    const t = TOOL_SCHEMAS.find((x) => x.type === "function" && x.function.name === "declare_intent");
    const target = (t as unknown as { function: { parameters: { properties: { target: { required: string[] } } } } }).function.parameters.properties.target;
    expect(target.required.sort()).toEqual(["file", "symbol"]);
  });
});

describe("systemPrompt", () => {
  it("hive prompt names the agent and human, states the protocol, under 350 words", () => {
    const p = systemPrompt("hive", "agent-andrii", "andrii");
    expect(p).toContain("agent-andrii");
    expect(p).toContain("andrii");
    for (const w of ["read_file", "declare_intent", "edit_region", "finish_intent", "ack_briefing", "requiresAck", "OLD_TEXT_NOT_FOUND", "run_tests"]) expect(p).toContain(w);
    // check semantics: isolated file, inline fixtures, no imports or wrappers; invalid check -> re-declare, not code change
    expect(p).toContain("check runs in an isolated test file");
    expect(p).toContain("Only the exports of the target file are in scope");
    expect(p).toContain("Define any input data inline");
    expect(p).toContain("no imports, no describe/it wrappers");
    expect(p).toContain("fix the check by re-declaring");
    expect(p).toContain("Do not re-declare the same target repeatedly");
    expect(p).toContain("wait for Hive's approval briefing");
    expect(p.split(/\s+/).filter(Boolean).length).toBeLessThan(350);
  });

  it("naive and isolated prompts do not mention intents, acks or asking", () => {
    for (const mode of ["naive", "isolated"] as const) {
      const p = systemPrompt(mode, "agent-a", "a");
      expect(p.toLowerCase()).not.toMatch(/intent/);
      expect(p.toLowerCase()).not.toMatch(/ack_briefing|briefing/);
      expect(p).not.toMatch(/ask_agent/);
      expect(p).toContain("edit_region");
      expect(p).toContain("agent-a");
    }
  });
});
