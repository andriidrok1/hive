// Structural interfaces for the pieces of core (brief 01) that coord depends on.
// Coord never imports server/src/core directly, so this package typechecks before
// the core module is merged. The real ReadLog satisfies ReadLogLike structurally.

import type { AgentId, Rev } from "@hive/shared";

export interface ReadLogLike {
  record(agentId: AgentId, path: string, rev: Rev, symbols: string[]): void;
  readsOf(agentId: AgentId): { path: string; rev: Rev; symbols: string[] }[];
  readersOf(path: string, symbol?: string): { agentId: AgentId; rev: Rev }[];
}

export interface StoreChange {
  path: string;
  rev: Rev;
  actor: string;
  intentId?: string;
  before: string;
  after: string;
}

export function badArgs(message: string): Error & { code: "BAD_ARGS" } {
  return Object.assign(new Error(message), { code: "BAD_ARGS" as const });
}
