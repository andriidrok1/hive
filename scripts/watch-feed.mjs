// Human-readable live log of the Hive feed, for watching a demo run.
// Usage: node scripts/watch-feed.mjs [http://localhost:4317] [outfile]
// Writes one line per event to stdout and to .hive/feed.log (default), full briefing text included.
import { WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.argv[2] ?? "http://localhost:4317";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[3] ?? path.join(root, ".hive", "feed.log");
fs.mkdirSync(path.dirname(out), { recursive: true });
const log = fs.createWriteStream(out, { flags: "a" });

const t0 = Date.now();
const line = (s) => {
  const t = new Date().toISOString().slice(11, 19);
  const rel = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  const msg = `${t} ${rel}s  ${s}`;
  console.log(msg);
  log.write(msg + "\n");
};

const short = (s, n = 160) => (s ?? "").replace(/\s+/g, " ").slice(0, n);
const indent = (s) => (s ?? "").split("\n").map((l) => "            | " + l).join("\n");

function fmt(e) {
  switch (e.type) {
    case "agent_status":
      return `[${e.agentId}] status=${e.status}${e.step != null ? ` step=${e.step}` : ""}${e.task ? ` task="${short(e.task, 80)}"` : ""}`;
    case "file_read":
      return `[${e.agentId}] READ ${e.path} @rev${e.rev}`;
    case "intent_declared": {
      const i = e.intent;
      const c = e.conflicts?.length ? ` CONFLICTS=${e.conflicts.map((x) => `${x.kind}:${x.intentId}`).join(",")}` : "";
      const d = e.dependents?.length ? ` dependents=${e.dependents.join(",")}` : "";
      return `[${i.agentId}] DECLARE ${i.id} ${i.action} ${i.target.file}#${i.target.symbol} status=${i.status}${c}${d}\n` +
        indent(`what:   ${i.what}\noutput: ${i.output}${i.check ? `\ncheck:  ${i.check}` : ""}`);
    }
    case "intent_status":
      return `INTENT ${e.intentId} -> ${e.status}`;
    case "edit_applied":
      return `[${e.agentId}] EDIT ${e.path} @rev${e.rev} +${e.added} -${e.removed}${e.intentId ? ` (${e.intentId})` : ""}`;
    case "briefing_sent": {
      const b = e.briefing;
      const from = b.fromAgent ?? b.fromHuman ?? "hive";
      return `BRIEFING ${b.id} ${b.kind} ${from} -> ${b.toAgent}${b.requiresAck ? " [ack required]" : ""}\n` +
        indent(b.summary) + (b.details?.failingTests?.length ? "\n" + indent("failing: " + b.details.failingTests.map((f) => f.name).join(", ")) : "");
    }
    case "briefing_acked":
      return `[${e.agentId}] ACK ${e.briefingId} = ${e.ack.response}${e.ack.note ? ` (${short(e.ack.note, 120)})` : ""}`;
    case "message_sent": {
      const m = e.message;
      return `MSG ${m.id} ${m.from} -> ${m.to} about ${m.about} (exchange ${m.exchange})\n` + indent(m.text);
    }
    case "test_run_started":
      return `TESTS start run=${e.runId} rev=${e.rev} reason=${e.reason}`;
    case "test_run_finished": {
      const r = e.result;
      return `TESTS ${r.ok ? "GREEN" : "RED"} run=${e.runId} passed=${r.passed} failed=${r.failed} ${r.durationMs}ms` +
        (r.failures?.length ? "\n" + indent(r.failures.map((f) => `${f.name}: ${short(f.message, 140)}`).join("\n")) : "");
    }
    case "culprit_search_started":
      return `CULPRIT search=${e.searchId} suspects=${e.suspects.join(",")}`;
    case "culprit_variant_result":
      return `CULPRIT   variant ${e.variant.label} -> ${e.variant.ok ? "green" : "red"}${e.variant.applyError ? ` (apply error: ${short(e.variant.applyError, 80)})` : ""}`;
    case "culprit_found":
      return `CULPRIT RESULT kind=${e.report.kind} culprits=${e.report.culprits.join(",")} ${e.report.durationMs}ms`;
    case "human_action":
      return `HUMAN ${e.humanId} ${e.action}${e.target ? ` ${e.target}` : ""}`;
    case "llm_call":
      return `llm ${e.purpose} ${e.model} ${e.ms}ms in=${e.tokensIn} out=${e.tokensOut}`;
    default:
      return `${e.type} ${JSON.stringify(e).slice(0, 200)}`;
  }
}

let seen = 0;
async function state() {
  try {
    const r = await fetch(`${base}/api/state`);
    const s = await r.json();
    line(`STATE mode=${s.mode} rev=${s.rev} files=${s.files.length} agents=${s.agents.map((a) => `${a.agentId}:${a.status}`).join(",") || "-"} intents=${s.intents.length}`);
  } catch (err) {
    line(`STATE unavailable: ${err.message}`);
  }
}

function connect() {
  const url = base.replace(/^http/, "ws") + "/ws/feed";
  const ws = new WebSocket(url);
  ws.on("open", () => { line(`connected ${url}`); void state(); });
  ws.on("message", (data) => {
    let e;
    try { e = JSON.parse(data.toString()); } catch { return; }
    seen++;
    line(`#${String(e.id).padStart(4)} ${fmt(e)}`);
  });
  ws.on("close", () => { line("disconnected, retrying in 2s"); setTimeout(connect, 2000); });
  ws.on("error", (err) => { line(`ws error: ${err.message}`); });
}

line(`watching ${base}, log -> ${out}`);
connect();
setInterval(() => { if (seen) line(`-- ${seen} events so far --`); }, 60000);
