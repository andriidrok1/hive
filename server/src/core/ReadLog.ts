import type { AgentId, Rev } from "@hive/shared";

export interface ReadRecord {
  path: string;
  rev: Rev;
  symbols: string[];
}

interface StoredRead extends ReadRecord {
  seq: number;
}

/** What each agent has read, so changes can be routed to the agents that saw the old version. */
export class ReadLog {
  private readonly byAgent = new Map<AgentId, Map<string, StoredRead>>();
  private seq = 0;

  record(agentId: AgentId, path: string, rev: Rev, symbols: string[]): void {
    const syms = [...new Set(symbols)].sort();
    const key = `${path}\u0000${syms.join("\u0001")}`;
    let reads = this.byAgent.get(agentId);
    if (!reads) {
      reads = new Map();
      this.byAgent.set(agentId, reads);
    }
    this.seq += 1;
    reads.set(key, { path, rev, symbols: syms, seq: this.seq });
  }

  /** Latest read per (path, symbol set), oldest first. */
  readsOf(agentId: AgentId): ReadRecord[] {
    const reads = this.byAgent.get(agentId);
    if (!reads) return [];
    return [...reads.values()]
      .sort((a, b) => a.seq - b.seq)
      .map(({ path, rev, symbols }) => ({ path, rev, symbols: [...symbols] }));
  }

  /** Each agent's latest read rev of `path` (and of `symbol` inside it, when given). */
  readersOf(path: string, symbol?: string): { agentId: AgentId; rev: Rev }[] {
    const out: { agentId: AgentId; rev: Rev }[] = [];
    for (const [agentId, reads] of this.byAgent) {
      let latest: StoredRead | undefined;
      for (const r of reads.values()) {
        if (r.path !== path) continue;
        if (symbol !== undefined && !r.symbols.includes(symbol)) continue;
        if (!latest || r.seq > latest.seq) latest = r;
      }
      if (latest) out.push({ agentId, rev: latest.rev });
    }
    return out;
  }

  clear(): void {
    this.byAgent.clear();
  }
}
