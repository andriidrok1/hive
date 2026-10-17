// Manual E2E: HIVE_PREVIEW_SITE=1 npx tsx server/test/runner/manual/preview-site.mts [edit|restore]
// Creates (or reuses) the preview VM, syncs demo-app (optionally with a visible edit) and fetches the page.
import { config as loadDotenv } from "dotenv";
import { join } from "node:path";
import { makePreviewSite } from "../../../src/runner/PreviewSite.js";
import { readProjectFiles } from "../../../src/runner/prepare.js";
import { findRepoRoot } from "../../../src/runner/util.js";

const repoRoot = findRepoRoot();
loadDotenv({ path: join(repoRoot, ".env"), quiet: true });
process.env.HIVE_PREVIEW_SITE = "1";
const mode = process.argv[2] ?? "restore";
const site = makePreviewSite(process.env)!;
const files = await readProjectFiles(join(repoRoot, "demo-app"));
if (mode === "edit") files["src/format.ts"] = files["src/format.ts"]!.replace('"$"', '"USD "');
const t0 = Date.now();
const url = await site.getUrl();
console.log(`url ${url} (${Date.now() - t0}ms)`, JSON.stringify(site.timings));
site.sync(files);
await site.flushNow();
const t = Date.now();
const res = await fetch(`${url}/api/preview.json`);
const j = (await res.json()) as { summary?: { lines?: string[]; total?: number }; error?: string };
console.log(`${mode}: HTTP ${res.status} in ${Date.now() - t}ms; total ${j.summary?.total}; lines ${JSON.stringify(j.summary?.lines)}; error ${j.error ?? "none"}`);
console.log("state", JSON.stringify(await site.getState()));
