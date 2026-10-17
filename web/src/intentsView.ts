import { useEffect, useRef, useState } from "react";
import type { Intent, IntentId, IntentStatus } from "@hive/shared";

// One rule for the editor labels, the file tree and the presence strip:
// per symbol show only approved / in_progress / conflict intents (plus verified ones still lingering),
// at most one per agent (the latest); earlier intents of that agent on the same symbol fold into "+N earlier".

export const ACTIVE_STATUSES: readonly IntentStatus[] = ["approved", "in_progress", "conflict"];
export const VERIFIED_LINGER_MS = 4000;

export interface VisibleIntent {
  intent: Intent;
  earlier: IntentId[]; // older intents of the same agent on the same symbol, oldest first
}

export function visibleIntents(intents: Intent[], file: string | null, lingering: ReadonlySet<IntentId> = new Set()): VisibleIntent[] {
  if (file === null) return [];
  const groups = new Map<string, Intent[]>();
  for (const i of intents) {
    if (i.target.file !== file) continue;
    const key = `${i.agentId}\u0000${i.target.symbol}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  const out: VisibleIntent[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const live = sorted.filter((i) => ACTIVE_STATUSES.includes(i.status) || (i.status === "verified" && lingering.has(i.id)));
    const shown = live[live.length - 1];
    if (!shown) continue;
    out.push({ intent: shown, earlier: sorted.filter((i) => i !== shown && i.createdAt <= shown.createdAt).map((i) => i.id) });
  }
  return out.sort((a, b) => a.intent.createdAt - b.intent.createdAt);
}

export function earlierMap(visible: VisibleIntent[]): Record<IntentId, IntentId[]> {
  const m: Record<IntentId, IntentId[]> = {};
  for (const v of visible) if (v.earlier.length) m[v.intent.id] = v.earlier;
  return m;
}

// Ids that flipped to verified less than VERIFIED_LINGER_MS ago; re-renders once when the window closes.
export function useLingeringVerified(intents: Intent[]): ReadonlySet<IntentId> {
  const [verifiedAt, setVerifiedAt] = useState<Record<IntentId, number>>({});
  const [, setTick] = useState(0);
  const seen = useRef<Record<IntentId, IntentStatus>>({});
  useEffect(() => {
    const flipped: IntentId[] = [];
    for (const i of intents) {
      if (i.status === "verified" && seen.current[i.id] !== undefined && seen.current[i.id] !== "verified") flipped.push(i.id);
      seen.current[i.id] = i.status;
    }
    if (flipped.length === 0) return;
    const t = Date.now();
    setVerifiedAt((v) => ({ ...v, ...Object.fromEntries(flipped.map((id) => [id, t])) }));
    const timer = setTimeout(() => setTick((n) => n + 1), VERIFIED_LINGER_MS + 50);
    return () => clearTimeout(timer);
  }, [intents]);
  const now = Date.now();
  return new Set(Object.entries(verifiedAt).filter(([, at]) => now - at < VERIFIED_LINGER_MS).map(([id]) => id));
}
