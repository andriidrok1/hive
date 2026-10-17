import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmitter } from "../../src/emit.js";
import { loadProjectDir } from "../../src/hive.js";
import { makeHive, register, type TestHive } from "./helpers.js";

let t: TestHive;
afterEach(async () => {
  await t?.close();
});

describe("createHive wiring", () => {
  it("18. an edit reaches History.recordEdit, CallGraph.update and ChangeWatcher.onEdit exactly once", async () => {
    t = await makeHive({ mode: "naive" });
    register(t, "agent-andrii");
    const d = t.hive.ctx.deps;
    const recordEdit = vi.spyOn(d.history, "recordEdit");
    const update = vi.spyOn(d.graph, "update");
    const onEdit = vi.spyOn(d.watcher, "onEdit");

    const res = await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(res.ok).toBe(true);
    expect(recordEdit).toHaveBeenCalledTimes(1);
    expect(recordEdit.mock.calls[0]?.[0]).toMatchObject({ path: "src/format.ts", rev: 1, before: expect.stringContaining("toFixed(2)"), after: expect.stringContaining("toFixed(3)") });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]?.["src/format.ts"]).toContain("toFixed(3)");
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0]?.[0]).toMatchObject({ path: "src/format.ts", actor: "agent-andrii", rev: 1 });
    expect(d.graph.symbolAt("src/format.ts", 1)?.name).toBe("formatPrice");
    expect(d.graph.callersOf("calculateTotal").map((c) => c.file)).toContain("src/tax.ts");
  });

  it("a green baseline snapshot exists at rev 0 and edit_applied is emitted once per edit", async () => {
    t = await makeHive({ mode: "naive" });
    register(t, "agent-andrii");
    expect(t.hive.ctx.deps.history.lastGreen()).toMatchObject({ rev: 0, green: true });
    await t.tool("agent-andrii", "edit_region", { path: "src/format.ts", oldText: "toFixed(2)", newText: "toFixed(3)" });
    expect(t.events("edit_applied")).toHaveLength(1);
    expect(t.events("edit_applied")[0]).toMatchObject({ agentId: "agent-andrii", path: "src/format.ts", rev: 1 });
  });

  it("emitter: monotonic ids, last 200 kept, subscribers notified, clear keeps counting", () => {
    const em = createEmitter();
    const seen: number[] = [];
    const off = em.subscribe((e) => seen.push(e.id));
    for (let i = 0; i < 250; i++) em.emit({ type: "human_action", humanId: "h", action: `a${i}` });
    expect(em.recent()).toHaveLength(200);
    expect(em.recent()[0]?.id).toBe(51);
    expect(em.recent()[199]?.id).toBe(250);
    expect(seen).toHaveLength(250);
    off();
    em.clear();
    const next = em.emit({ type: "human_action", humanId: "h", action: "after" });
    expect(next.id).toBe(251);
    expect(em.recent()).toHaveLength(1);
    expect(seen).toHaveLength(250);
  });

  it("loadProjectDir picks src/**, test/**, package.json, tsconfig.json and skips node_modules", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-proj-"));
    try {
      mkdirSync(join(dir, "src", "deep"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      writeFileSync(join(dir, "README.md"), "# no");
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;");
      writeFileSync(join(dir, "src", "deep", "b.ts"), "export const b = 2;");
      writeFileSync(join(dir, "test", "a.test.ts"), "it('x', () => {});");
      writeFileSync(join(dir, "node_modules", "x", "index.js"), "no");
      writeFileSync(join(dir, "dist", "a.js"), "no");
      const files = loadProjectDir(dir);
      expect(Object.keys(files).sort()).toEqual(["package.json", "src/a.ts", "src/deep/b.ts", "test/a.test.ts", "tsconfig.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
