// Smallest changed span between two versions of a text, as offsets into `next`.
export function changedRange(prev: string, next: string): { from: number; to: number } | null {
  if (prev === next) return null;
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  return { from: p, to: Math.max(p, next.length - s) };
}

// 1-based line numbers in `next` that the change touches (at least one line).
export function changedLines(prev: string, next: string): number[] {
  const r = changedRange(prev, next);
  if (!r) return [];
  const start = next.slice(0, r.from).split("\n").length;
  // A change that ends with a newline belongs to the line before it, not the one after.
  const endIdx = r.to > r.from && next[r.to - 1] === "\n" ? r.to - 1 : r.to;
  const end = Math.max(start, next.slice(0, endIdx).split("\n").length);
  const out: number[] = [];
  for (let ln = start; ln <= end; ln++) out.push(ln);
  return out;
}

export const FLASH_MS = 1500;
