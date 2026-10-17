// Short human titles for agents ("Feature: …" on the card). The server only knows the task text,
// so titles live on the client: set when we start an agent, persisted so a reload keeps them.
const KEY = "hive.titles";
let titles: Record<string, string> = load();

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function setAgentTitle(agentId: string, title: string): void {
  titles = { ...titles, [agentId]: title };
  try {
    localStorage.setItem(KEY, JSON.stringify(titles));
  } catch {
    // private mode, keep in memory only
  }
}

export function getAgentTitle(agentId: string): string | undefined {
  return titles[agentId];
}

// Fallback when nobody gave a title: the first clause of the task, up to the first period or 70 chars.
export function firstClause(task: string, max = 70): string {
  const t = task.trim();
  const dot = t.search(/\.(\s|$)/);
  const clause = dot > 0 ? t.slice(0, dot) : t;
  return clause.length > max ? `${clause.slice(0, max - 1).trimEnd()}…` : clause;
}

export function agentTitle(agentId: string, task?: string): string | undefined {
  return getAgentTitle(agentId) ?? (task ? firstClause(task) : undefined);
}
