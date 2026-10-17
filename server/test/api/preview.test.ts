import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createHive, loadProjectDir, type Hive } from "../../src/hive.js";
import { fakeModules } from "../../src/api/fakes.js";
import { noopLLM } from "../../src/coord/index.js";
import { LocalRunner } from "../../src/runner/index.js";
import { neverEndingRun } from "./helpers.js";

const demoApp = resolve(import.meta.dirname, "../../../demo-app");

let hive: Hive;
afterEach(async () => {
  await hive?.close();
});

describe("GET /api/preview", () => {
  it("runs the live demo project through preview.mts with the LocalRunner and caches per rev", async () => {
    const files = loadProjectDir(demoApp);
    expect(files["src/order.ts"]).toBeDefined();
    const runner = new LocalRunner({ templateDir: demoApp });
    const calls: string[] = [];
    const origRun = runner.runCommand.bind(runner);
    runner.runCommand = (f, cmd, t) => {
      calls.push(cmd);
      return origRun(f, cmd, t);
    };
    hive = createHive({ mode: "naive", initialFiles: files, runner, llm: noopLLM(), modules: fakeModules(), runAgent: neverEndingRun });
    await hive.built.ready;
    const app = hive.built.app;

    const res = await app.inject({ method: "GET", url: "/api/preview" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(3);
    // 2*1899 + 1250 + 599 = 5647 cents, minus 10% (564.7, the base project does not round); no tax
    expect(body.summary.subtotal).toBe(5647);
    expect(body.summary.discount).toBeCloseTo(564.7, 3);
    expect(body.summary.total).toBeCloseTo(5082.3, 3);
    expect(body.summary.total).toBe(body.summary.subtotal - body.summary.discount);
    expect(body.receipt).toBeNull();
    expect(typeof body.negative).toBe("string"); // the base formatPrice has no negative handling (one of the scenarios adds it)
    expect(calls).toEqual(["npx tsx preview.mts"]);

    // same rev -> cached, no second run; nothing on the feed
    const again = await app.inject({ method: "GET", url: "/api/preview" });
    expect(again.json()).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(hive.ctx.deps.emitter.recent()).toEqual([]);

    // an edit bumps the rev -> recomputed
    hive.agents.register("agent-andrii", "andrii");
    const edit = await hive.built.tools.call("agent-andrii", "edit_region", {
      path: "src/format.ts",
      oldText: "  const dollars = Math.floor(cents / 100);",
      newText: '  if (cents < 0) return "-" + formatPrice(-cents);\n  const dollars = Math.floor(cents / 100);',
    });
    expect(edit.ok).toBe(true);
    const after = (await app.inject({ method: "GET", url: "/api/preview" })).json();
    expect(after.negative).toBe("-$1.50");
    expect(calls).toHaveLength(2);
  }, 60_000);
});
