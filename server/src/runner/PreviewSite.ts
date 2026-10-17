// A public receipt page for the live project: ONE long-lived Freestyle VM created from the base
// snapshot, a tiny Node HTTP server in it that renders the demo app's orderSummary as a paper receipt,
// and a *.style.dev domain routed to it. `sync(files)` writes changed files; the page re-imports the
// project on every request, so edits by agents show up without a restart. Enabled by HIVE_PREVIEW_SITE=1.
import { Freestyle, type Vm } from "freestyle";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROJECT_DIR } from "./FreestyleRunner.js";
import { findRepoRoot } from "./util.js";

export const PREVIEW_STATE_FILE = ".hive/preview-site.json";
export const PREVIEW_PORT = 3000;

export interface PreviewSiteOptions {
  apiKey: string;
  baseSnapshotId: string;
  projectDir?: string;
  /** Full domain, e.g. "hive-receipt.style.dev". Default: "hive-receipt-<4 hex>.style.dev", kept in .hive/preview-site.json. */
  domain?: string;
  debounceMs?: number;
  log?: (msg: string) => void;
}

export interface PreviewSiteState {
  vmId: string;
  domain: string;
  ruleId?: string;
  createdAt: string;
  baseSnapshotId: string;
}

export interface PreviewSiteTimings {
  vmCreateMs?: number;
  filesWriteMs?: number;
  serverStartMs?: number;
  domainMs?: number;
  totalMs?: number;
  lastSyncMs?: number;
  lastSyncFiles?: number;
}

export class PreviewSite {
  readonly timings: PreviewSiteTimings = {};
  private readonly client: Freestyle;
  private readonly projectDir: string;
  private readonly debounceMs: number;
  private readonly log: (msg: string) => void;
  private state: PreviewSiteState | undefined;
  private vm: Vm | undefined;
  private ensuring: Promise<PreviewSiteState> | undefined;
  private written = new Map<string, string>(); // path -> sha1 of what the VM holds
  private pending: Record<string, string> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly opts: PreviewSiteOptions) {
    this.client = new Freestyle({ apiKey: opts.apiKey });
    this.projectDir = opts.projectDir ?? DEFAULT_PROJECT_DIR;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.log = opts.log ?? ((m) => console.log(`[preview-site] ${m}`));
  }

  /** The public URL (creates the VM and domain on first call). */
  async getUrl(): Promise<string> {
    const st = await this.ensure();
    return `https://${st.domain}`;
  }

  async getState(): Promise<PreviewSiteState> {
    return this.ensure();
  }

  /** Queue the project files for the VM; writes happen after 2s of quiet, only for changed files. */
  sync(files: Record<string, string>): void {
    this.pending = { ...(this.pending ?? {}), ...files };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.syncing = this.syncing.then(() => this.flush()).catch((err) => this.log(`sync failed: ${err instanceof Error ? err.message : String(err)}`));
    }, this.debounceMs);
  }

  /** Write pending files now (used by tests and the route). */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.syncing = this.syncing.then(() => this.flush()).catch((err) => this.log(`sync failed: ${err instanceof Error ? err.message : String(err)}`));
    await this.syncing;
  }

  private async flush(): Promise<void> {
    const files = this.pending;
    this.pending = undefined;
    if (!files) return;
    await this.ensure();
    const vm = this.vm!;
    const started = Date.now();
    const changed = Object.entries(files).filter(([p, c]) => this.written.get(p) !== sha1(c) && !p.includes("..") && !p.startsWith("/"));
    if (changed.length === 0) return;
    const dirs = [...new Set(changed.filter(([p]) => p.includes("/")).map(([p]) => p.slice(0, p.lastIndexOf("/"))))];
    if (dirs.length > 0) await vm.exec({ command: dirs.map((d) => `mkdir -p ${q(`${this.projectDir}/${d}`)}`).join(" && "), timeoutMs: 20_000 });
    await Promise.all(changed.map(([p, c]) => vm.fs.writeFile(`${this.projectDir}/${p}`, c)));
    for (const [p, c] of changed) this.written.set(p, sha1(c));
    this.timings.lastSyncMs = Date.now() - started;
    this.timings.lastSyncFiles = changed.length;
    this.log(`synced ${changed.length} file(s) in ${this.timings.lastSyncMs}ms`);
  }

  private ensure(): Promise<PreviewSiteState> {
    this.ensuring ??= this.doEnsure().catch((err) => {
      this.ensuring = undefined;
      throw err;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<PreviewSiteState> {
    const total = Date.now();
    const repoRoot = findRepoRoot();
    const stateFile = join(repoRoot, PREVIEW_STATE_FILE);
    if (existsSync(stateFile)) {
      const saved = JSON.parse(await readFile(stateFile, "utf8")) as PreviewSiteState;
      try {
        const data = await this.client.vms.get(saved.vmId);
        this.vm = this.client.vms.ref(saved.vmId);
        if (data.state === "paused" || data.state === "stopped") await this.vm.start();
        this.state = saved;
        this.written.clear(); // unknown VM contents after a restart: rewrite everything once
        await this.writePreviewFiles(this.vm);
        await this.startServer(this.vm);
        this.log(`reusing preview VM ${saved.vmId} at https://${saved.domain}`);
        return saved;
      } catch (err) {
        this.log(`saved preview VM ${saved.vmId} unusable (${err instanceof Error ? err.message : String(err)}); creating a new one`);
      }
    }

    let t = Date.now();
    const { vm, vmId } = await this.client.vms.create({
      snapshotId: this.opts.baseSnapshotId,
      // Public ingress arrives through the platform's mapped domain, which no firewall rule can block;
      // the VM itself needs no outbound network.
      firewall: { rules: [] },
      idleTimeoutSeconds: -1,
      displayName: "hive-preview-site",
      metadata: { hive: "preview-site" },
    });
    this.vm = vm;
    this.timings.vmCreateMs = Date.now() - t;
    this.log(`preview VM ${vmId} created in ${this.timings.vmCreateMs}ms`);

    t = Date.now();
    await this.writePreviewFiles(vm);
    this.timings.filesWriteMs = Date.now() - t;

    t = Date.now();
    await this.startServer(vm);
    this.timings.serverStartMs = Date.now() - t;

    t = Date.now();
    const domain = this.opts.domain ?? `hive-receipt-${vmId.slice(-4)}.style.dev`;
    const rule = await this.client.tls.rules.create({ action: "allow", domain, source: { public: true }, destination: { vmId, port: PREVIEW_PORT } });
    this.timings.domainMs = Date.now() - t;
    this.timings.totalMs = Date.now() - total;

    const state: PreviewSiteState = { vmId, domain, ruleId: rule.id, createdAt: new Date().toISOString(), baseSnapshotId: this.opts.baseSnapshotId };
    await mkdir(join(repoRoot, ".hive"), { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    this.state = state;
    this.log(`preview site live at https://${domain} (vm ${vmId}; files ${this.timings.filesWriteMs}ms, server ${this.timings.serverStartMs}ms, domain ${this.timings.domainMs}ms, total ${this.timings.totalMs}ms)`);
    return state;
  }

  private async writePreviewFiles(vm: Vm): Promise<void> {
    await vm.exec({ command: `mkdir -p ${q(this.projectDir)}`, timeoutMs: 20_000 });
    await Promise.all([
      vm.fs.writeFile(`${this.projectDir}/hive-loader.mjs`, LOADER_MJS),
      vm.fs.writeFile(`${this.projectDir}/preview.mts`, PREVIEW_MTS),
      vm.fs.writeFile(`${this.projectDir}/preview-server.mjs`, PREVIEW_SERVER_MJS),
    ]);
  }

  /** Start the preview server if it is not already listening. */
  private async startServer(vm: Vm): Promise<void> {
    const check = `cd ${q(this.projectDir)} && (curl -sf -o /dev/null http://127.0.0.1:${PREVIEW_PORT}/health && echo up) || (nohup node preview-server.mjs > /tmp/preview-site.log 2>&1 & sleep 1; curl -sf -o /dev/null http://127.0.0.1:${PREVIEW_PORT}/health && echo started || (echo failed; tail -20 /tmp/preview-site.log))`;
    const res = await vm.exec({ command: check, timeoutMs: 30_000 });
    const out = (res.stdout ?? "").trim();
    if (!/up|started/.test(out)) throw new Error(`preview server did not start: ${out} ${res.stderr ?? ""}`);
  }
}

/** The one-line wiring for hive.ts: `GET /api/preview-site` → `{ url, vmId }` and a sync of the current files. */
export function previewSiteRoute(site: PreviewSite, getFiles: () => Record<string, string>) {
  return async (): Promise<{ url: string; vmId: string; domain: string }> => {
    const st = await site.getState();
    site.sync(getFiles());
    return { url: `https://${st.domain}`, vmId: st.vmId, domain: st.domain };
  };
}

/** `HIVE_PREVIEW_SITE=1` + FREESTYLE_API_KEY + a base snapshot → a PreviewSite, else undefined. */
export function makePreviewSite(env: NodeJS.ProcessEnv = process.env, log?: (msg: string) => void): PreviewSite | undefined {
  if (env.HIVE_PREVIEW_SITE !== "1") return undefined;
  const apiKey = env.FREESTYLE_API_KEY;
  if (!apiKey) throw new Error("HIVE_PREVIEW_SITE=1 but FREESTYLE_API_KEY is not set");
  let baseSnapshotId = env.HIVE_BASE_SNAPSHOT;
  let projectDir: string | undefined;
  const file = join(findRepoRoot(), ".hive", "base-snapshot.json");
  if (existsSync(file)) {
    const rec = JSON.parse(readFileSync(file, "utf8")) as { snapshotId: string; projectDir?: string };
    baseSnapshotId ??= rec.snapshotId;
    projectDir = rec.projectDir;
  }
  if (!baseSnapshotId) throw new Error("HIVE_PREVIEW_SITE=1 but no base snapshot (run runner:prepare)");
  return new PreviewSite({ apiKey, baseSnapshotId, projectDir, domain: env.HIVE_PREVIEW_DOMAIN, log });
}

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------- files written into the VM ----------

/** Lets Node run the TS sources directly: `./x.js` specifiers resolve to `./x.ts` (NodeNext style). */
const LOADER_MJS = `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (/^\\.{1,2}\\//.test(specifier) && specifier.endsWith(".js")) {
        return next(specifier.slice(0, -3) + ".ts", context);
      }
      throw err;
    }
  },
});
`;

/** Prints the receipt data as JSON. Re-run per request so the latest files are used. */
const PREVIEW_MTS = `import { readdirSync } from "node:fs";
const items = [
  { sku: "flat-white", priceCents: 500, qty: 2 },
  { sku: "croissant", priceCents: 450, qty: 1 },
  { sku: "beans-250g", priceCents: 1550, qty: 1 },
];
const promo = { code: "TEN", kind: "percent", value: 10 };
const out: Record<string, unknown> = { items, promo, generatedAt: new Date().toISOString() };
const capabilities: Record<string, string[]> = {};
for (const f of readdirSync("./src").filter((n) => n.endsWith(".ts") && !n.endsWith(".d.ts")).sort()) {
  try {
    const mod = (await import("./src/" + f)) as Record<string, unknown>;
    capabilities[f.replace(/\\.ts$/, "")] = Object.keys(mod).filter((k) => typeof mod[k] === "function");
  } catch (err) {
    capabilities[f.replace(/\\.ts$/, "")] = ["ERROR: " + (err instanceof Error ? err.message.split("\\n")[0] : String(err))];
  }
}
out.capabilities = capabilities;
try {
  const order = (await import("./src/order.js")) as { orderSummary: (i: unknown, p?: unknown) => unknown };
  out.summary = order.orderSummary(items, promo);
} catch (err) {
  out.error = err instanceof Error ? err.message.split("\\n")[0] : String(err);
}
try {
  const tax = (await import("./src/tax.js")) as { applyTax?: (c: number, s: string) => number };
  const s = out.summary as { total?: number } | undefined;
  if (tax.applyTax && s && typeof s.total === "number") out.taxedTotalCA = tax.applyTax(s.total, "CA");
} catch {}
console.log(JSON.stringify(out));
`;

/** HTTP server on 3000: "/" = receipt HTML, "/api/preview.json" = raw JSON, "/health". */
const PREVIEW_SERVER_MJS = `import { createServer } from "node:http";
import { execFile } from "node:child_process";

function run() {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--no-warnings", "--import", "./hive-loader.mjs", "preview.mts"], { cwd: process.cwd(), timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ error: String(stderr || err.message).split("\\n").filter(Boolean).slice(-3).join(" | ") });
      try { resolve(JSON.parse(String(stdout).trim().split("\\n").pop())); } catch { resolve({ error: String(stderr || stdout).slice(0, 500) }); }
    });
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = (c) => (typeof c === "number" ? "$" + (c / 100).toFixed(2) : "—");
function html(d) {
  const s = d.summary || {};
  const items = (d.items || []).map((i) => "<tr><td>" + esc(i.sku) + " ×" + i.qty + "</td><td class=r>" + money(i.priceCents * i.qty) + "</td></tr>").join("");
  const caps = Object.entries(d.capabilities || {}).map(([m, fns]) => "<div><b>" + esc(m) + "</b> " + fns.map(esc).join(", ") + "</div>").join("");
  const err = d.error ? '<div class=err>⚠ ' + esc(d.error) + "</div>" : "";
  const lines = (s.lines || []).map((l) => "<div>" + esc(l) + "</div>").join("");
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>Hive Coffee receipt</title><style>' +
    "body{margin:0;background:#2b2b2b;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#222;display:flex;justify-content:center;padding:32px 16px}" +
    ".paper{background:#fdfdf8;width:min(380px,100%);padding:28px 24px 40px;box-shadow:0 12px 40px rgba(0,0,0,.5);position:relative}" +
    ".paper:after{content:'';position:absolute;left:0;right:0;bottom:-10px;height:12px;background:radial-gradient(circle,transparent 6px,#fdfdf8 7px) 0 -6px/16px 16px repeat-x}" +
    "h1{font-size:16px;letter-spacing:.12em;text-align:center;margin:0 0 4px}.sub{text-align:center;font-size:11px;color:#666;margin-bottom:16px}" +
    "table{width:100%;border-collapse:collapse;font-size:13px}td{padding:3px 0}.r{text-align:right}.tot td{border-top:1px dashed #999;padding-top:8px;font-weight:bold}" +
    ".lines{margin:14px 0;padding:10px 0;border-top:1px dashed #999;border-bottom:1px dashed #999;font-size:12px;white-space:pre}" +
    ".caps{font-size:10px;color:#555;margin-top:16px;line-height:1.5}.err{background:#fde8e8;color:#9b1c1c;padding:8px;font-size:12px;margin:12px 0}" +
    ".foot{text-align:center;font-size:10px;color:#888;margin-top:18px}</style></head><body><div class=paper>" +
    "<h1>HIVE COFFEE · Order #1042</h1><div class=sub>" + esc(d.generatedAt || "") + " · promo " + esc((d.promo || {}).code || "") + "</div>" +
    err + "<table>" + items +
    '<tr class=tot><td>Subtotal</td><td class=r>' + money(s.subtotal) + "</td></tr>" +
    "<tr><td>Discount</td><td class=r>-" + money(s.discount) + "</td></tr>" +
    "<tr class=tot><td>Total</td><td class=r>" + money(s.total) + "</td></tr>" +
    (typeof d.taxedTotalCA === "number" ? "<tr><td>Total incl. CA tax</td><td class=r>" + money(d.taxedTotalCA) + "</td></tr>" : "") +
    "</table><div class=lines>" + (lines || "<i>orderSummary unavailable</i>") + "</div>" +
    "<div class=caps><b>capabilities</b>" + caps + "</div><div class=foot>live from the Hive project · refreshes every 3s</div></div></body></html>";
}
createServer(async (req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  const data = await run();
  if (req.url && req.url.startsWith("/api/preview.json")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(data)); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html(data));
}).listen(${PREVIEW_PORT}, "0.0.0.0", () => console.log("preview server on ${PREVIEW_PORT}"));
`;
