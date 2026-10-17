import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Columns2, ExternalLink, QrCode, RefreshCw, X } from "lucide-react";
import { fetchPreview, fetchPreviewSite, type PreviewData } from "../api";
import { useQrSvg } from "../components/Qr";
import type { UiState } from "../state";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";

export const PREVIEW_DEBOUNCE_MS = 1500;

// Static samples for ?mock=1: the project before the agents, and after (Alex's receipt, Nika's formatting).
export const MOCK_PREVIEW_BEFORE: PreviewData = {
  ok: true,
  summary: { subtotal: 2400, discount: 240, total: 2160, lines: ["Latte x2 $9.00", "Croissant x3 $15.00", "Discount -$2.40", "Total $21.60"] },
  receipt: null,
  formatPercent: null,
  negative: null,
};
export const MOCK_PREVIEW_AFTER: PreviewData = {
  ...MOCK_PREVIEW_BEFORE,
  receipt: "Items: 5\nLatte x2 $9.00\nCroissant x3 $15.00\nDiscount -$2.40\nTotal $21.60",
  receiptWidth: 19,
  formatPercent: "10%",
  negative: "-$1.50",
};

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

export interface Snapshot {
  data: PreviewData;
  rev: number;
  at: number;
}

interface Props {
  state: UiState;
  mock: boolean;
  active: boolean; // the Preview view is on screen
  load?: () => Promise<PreviewData>; // injectable for tests
}

export function Preview({ state, mock, active, load }: Props) {
  const [after, setAfter] = useState<Snapshot | null>(null);
  const [before, setBefore] = useState<Snapshot | null>(null);
  const [compare, setCompare] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revRef = useRef(state.rev);
  revRef.current = state.rev;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const data = load ? await load() : mock ? (revRef.current > 0 ? MOCK_PREVIEW_AFTER : MOCK_PREVIEW_BEFORE) : await fetchPreview();
      const snap: Snapshot = { data, rev: revRef.current, at: Date.now() };
      setAfter(snap);
      setErr(null);
      // First successful fetch of a clean project (rev 0) is the "before" reference for this take.
      setBefore((b) => (snap.rev === 0 || b === null ? snap : b));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [load, mock]);

  // On open.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // 1.5 s after an edit or a test run (debounced), while on screen.
  const latest = state.events[0];
  const trigger = latest && (latest.type === "edit_applied" || latest.type === "test_run_finished") ? latest.id : 0;
  useEffect(() => {
    if (!active || trigger === 0) return;
    const t = setTimeout(() => void refresh(), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [active, trigger, refresh]);

  // A reset (rev back to 0) starts a new take: forget the old "before".
  const prevRev = useRef(state.rev);
  useEffect(() => {
    if (state.rev === 0 && prevRev.current > 0) setBefore(null);
    prevRev.current = state.rev;
  }, [state.rev]);

  const canCompare = before !== null && after !== null && before !== after;

  // Live site on a Freestyle VM: from /api/state, or asked once on open (local-only runs answer 404 → hidden).
  const [siteUrl, setSiteUrl] = useState<string | undefined>(state.previewSiteUrl);
  useEffect(() => {
    if (state.previewSiteUrl) setSiteUrl(state.previewSiteUrl);
  }, [state.previewSiteUrl]);
  useEffect(() => {
    if (!active || mock || load || siteUrl) return;
    let alive = true;
    fetchPreviewSite()
      .then((s) => alive && s && setSiteUrl(s.url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [active, mock, load, siteUrl]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4" data-testid="preview">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">Store preview</span>
        <span className="font-mono text-[11px] text-muted-foreground" data-testid="preview-caption">
          {after ? `updated @rev ${after.rev}` : busy ? "loading…" : "not loaded"}
        </span>
        {siteUrl && <LiveSite url={siteUrl} />}
        <div className="flex-1" />
        <Button variant={compare ? "default" : "outline"} size="sm" onClick={() => setCompare((c) => !c)} disabled={!canCompare} aria-pressed={compare} title={canCompare ? "Show the project before the agents next to the live result" : "Needs a before snapshot (first fetch at rev 0)"}>
          <Columns2 />
          Before / After
        </Button>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy} aria-label="Refresh preview">
          <RefreshCw className={cn(busy && "animate-spin")} />
        </Button>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      {!after && !err && <div className="text-xs text-muted-foreground">Loading the store preview…</div>}
      {after && (
        <div className={cn("grid gap-4", compare && canCompare ? "grid-cols-2" : "grid-cols-1 max-w-md")}>
          {compare && canCompare && before && <ReceiptCard data={before.data} title="Before" rev={before.rev} muted />}
          <ReceiptCard data={after.data} title={compare && canCompare ? "After" : undefined} rev={after.rev} />
        </div>
      )}
    </div>
  );
}

// "Open live site" + QR popover + caption; rendered only when a preview site URL exists.
function LiveSite({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const svg = useQrSvg(url, 180);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (pop.current && !pop.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="relative flex items-center gap-2" data-testid="live-site" ref={pop}>
      <Button size="sm" variant="outline" asChild>
        <a href={url} target="_blank" rel="noopener noreferrer" data-testid="open-live-site">
          <ExternalLink />
          Open live site
        </a>
      </Button>
      <Button size="icon" variant="outline" className="size-7" aria-label="QR code for the live site" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <QrCode />
      </Button>
      <span className="font-mono text-[11px] text-muted-foreground">Live on Freestyle VM · updates ~2 s after edits</span>
      {open && (
        <div className="absolute left-0 top-9 z-30 flex flex-col items-center gap-2 rounded-lg border border-border bg-popover p-3 shadow-lg" role="dialog" aria-label="live site QR">
          <div className="[&_svg]:size-[180px]" dangerouslySetInnerHTML={{ __html: svg }} />
          <span className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground">{url.replace(/^https?:\/\//, "")}</span>
        </div>
      )}
    </div>
  );
}

// Paper receipt: Alex's receipt() verbatim when present, else the summary lines.
export function ReceiptCard({ data, title, rev, muted = false }: { data: PreviewData; title?: string; rev?: number; muted?: boolean }) {
  const lines = typeof data.receipt === "string" ? data.receipt.split("\n") : (data.summary?.lines ?? []);
  const hasReceipt = typeof data.receipt === "string";
  const hasPercent = data.formatPercent !== undefined && data.formatPercent !== null;
  const hasNegative = data.negative !== undefined && data.negative !== null;
  return (
    <div className={cn("flex flex-col gap-3", muted && "opacity-75")} data-testid={`receipt-${title ? title.toLowerCase() : "live"}`}>
      {title && (
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {title}
          {rev !== undefined && <span className="font-mono text-[11px]">@rev {rev}</span>}
        </div>
      )}
      <div className="rounded-sm border border-zinc-300/20 bg-[#f6f1e7] px-5 py-4 text-[#1b1b1b] shadow-[0_8px_24px_rgba(0,0,0,0.35)]" style={{ fontFamily: "var(--font-mono)" }}>
        <div className="text-center text-[13px] font-semibold tracking-wide">HIVE COFFEE</div>
        <div className="text-center text-[11px] text-[#5a5a5a]">Order #1042</div>
        <div className="my-2 border-t border-dashed border-[#1b1b1b]/30" />
        {data.error && <div className="text-xs text-red-700">{data.error}</div>}
        {data.summaryError && !hasReceipt && <div className="text-xs text-red-700">{data.summaryError}</div>}
        {data.receiptError && <div className="text-xs text-red-700">{data.receiptError}</div>}
        <pre className="m-0 whitespace-pre text-[12.5px] leading-[1.6]" data-testid="receipt-lines">
          {lines.length ? lines.map((l, i) => <Line key={i} text={l} />) : "(no lines)"}
        </pre>
        <div className="my-2 border-t border-dashed border-[#1b1b1b]/30" />
        <div className="text-center text-[10px] text-[#5a5a5a]">{hasReceipt ? `receipt() · width ${data.receiptWidth ?? lines.reduce((m, l) => Math.max(m, l.length), 0)}` : "orderSummary()"}</div>
      </div>
      {data.summary && (
        <div className="grid grid-cols-3 gap-2">
          <Chip label="Subtotal" value={money(data.summary.subtotal)} />
          <Chip label="Discount" value={money(-Math.abs(data.summary.discount))} />
          <Chip label="Total" value={money(data.summary.total)} strong />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="capabilities">
        <span className="text-muted-foreground">Capabilities</span>
        <Cap ok={hasReceipt} label="receipt()" />
        <Cap ok={hasPercent} label="formatPercent()" value={hasPercent ? String(data.formatPercent) : undefined} />
        <Cap ok={hasNegative} label="negative prices" value={hasNegative ? String(data.negative) : undefined} />
      </div>
    </div>
  );
}

function Chip({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-md border border-border bg-background py-2">
      <span className={cn("font-mono text-[13px]", strong ? "font-semibold text-foreground" : "text-foreground/90")}>{value}</span>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

function Cap({ ok, label, value }: { ok: boolean; label: string; value?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono", ok ? "text-emerald-400" : "text-zinc-500")}>
      {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      {label}
      {value && <span className="text-foreground/80">{value}</span>}
    </span>
  );
}

// Unrounded cents ("$5.64.6999"), "$-2.-50" and "10%%" are the project's live bugs: paint them red so before/after reads at a glance.
const BAD = /\$-?\d+\.\d+\.\d+|\$-\d+\.-?\d+|\d+%%|NaN|undefined/g;
function Line({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BAD)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <span key={at} className="rounded-sm bg-red-200 px-0.5 font-semibold text-red-800 underline decoration-wavy decoration-red-600" data-testid="broken-value">
        {m[0]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.length ? parts : text}
      {"\n"}
    </>
  );
}
