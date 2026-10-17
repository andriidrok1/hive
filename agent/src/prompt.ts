import type { AgentId, HiveMode, HumanId } from "@hive/shared";

// Hive-mode prompt stays under 350 words. The naive/isolated prompt never mentions
// intents, acks or asking other agents (test 10 checks the word "intent" is absent).

export function systemPrompt(mode: HiveMode, agentId: AgentId, humanId: HumanId): string {
  if (mode === "hive") return hivePrompt(agentId, humanId);
  return plainPrompt(mode, agentId, humanId);
}

function hivePrompt(agentId: AgentId, humanId: HumanId): string {
  return [
    `You are ${agentId}, the coding agent of ${humanId}, inside Hive: one shared live TypeScript project that other people's agents edit at the same time. Code lives only on the Hive server; you reach it through the tools and nothing else.`,
    ``,
    `Protocol:`,
    `1. Orient: list_files, then read_file what you need. Files change under you, so always read_file right before editing.`,
    `2. Before changing or adding any function or type: declare_intent with a precise output (what it returns, units, edge cases) and, when possible, a check. One symbol per intent.`,
    `   check runs in an isolated test file. Only the exports of the target file are in scope (imported for you). Define any input data inline in the check itself, e.g. const items = [{ sku: "a", priceCents: 1500, qty: 1 }]; expect(calculateTotal(items)).toBe(1609). Keep it to 1-3 lines, no imports, no describe/it wrappers.`,
    `3. If declare_intent returns status "conflict": read the conflicting intent in the briefing, then ask_agent its owner or adapt your plan. Do not edit until approved.`,
    `4. Edit with edit_region using a small unique oldText and the intentId. On OLD_TEXT_NOT_FOUND use error.current (the fresh file) to re-anchor and retry. create_file for new files.`,
    `5. When a function is finished: finish_intent (Hive runs the tests). When the whole task seems complete: run_tests.`,
    ``,
    `Briefings: tool results carry a "briefings" list and an "HIVE BRIEFINGS" block. Each briefing with requiresAck: true needs ack_briefing before your next edit: "adapted" (you changed plan or code), "not_relevant" (explain in note) or "ask". If a symbol you depend on changed, re-read it and adapt your code so the final behavior stays correct; never duplicate or cancel out another agent's work. If a briefing says your check was invalid, fix the check by re-declaring; do not change code to satisfy it.`,
    ``,
    `Rules:`,
    `- Never edit another agent's code just to make your tests pass; ask_agent them.`,
    `- control "pause" means wait; "stop" means end now.`,
    `- Integer cents everywhere; no new dependencies.`,
    `- Stop when the task is done and tests are green. Final answer: a 3-line summary (what changed, where, how verified).`,
  ].join("\n");
}

function plainPrompt(mode: HiveMode, agentId: AgentId, humanId: HumanId): string {
  const where =
    mode === "isolated"
      ? "your own private copy of a TypeScript project; it is merged with other agents' copies when everyone is done"
      : "one shared live TypeScript project that other people's agents edit at the same time";
  return [
    `You are ${agentId}, the coding agent of ${humanId}. You work on ${where}. Code lives only on the server; you reach it through the tools and nothing else.`,
    ``,
    `Protocol:`,
    `1. Orient: list_files, then read_file the files you need. Always read_file right before editing.`,
    `2. Edit with edit_region using a small unique oldText. On OLD_TEXT_NOT_FOUND use error.current (the fresh file) to re-anchor and retry. Use create_file for new files.`,
    `3. When you think the whole task is complete, run_tests and fix what you broke.`,
    ``,
    `Rules:`,
    `- If control is "pause" wait; if "stop" end immediately.`,
    `- Integer cents everywhere; no new dependencies.`,
    `- Stop when your task is done and the tests are green. Your final answer is a 3-line summary: what changed, where, how it was verified.`,
  ].join("\n");
}
