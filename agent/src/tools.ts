import type OpenAI from "openai";
import type { ToolName } from "@hive/shared";

// JSON schema per ToolArgs in shared/src/contracts.ts. Required lists mirror the
// non-optional fields of each ToolArgs entry; test 1 checks them against TOOL_REQUIRED.

type Schema = Record<string, unknown>;

function tool(name: ToolName, description: string, properties: Record<string, Schema>, required: string[]): OpenAI.Chat.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

const str = (description: string): Schema => ({ type: "string", description });
const int = (description: string): Schema => ({ type: "integer", description });

export const TOOL_REQUIRED: Record<ToolName, string[]> = {
  list_files: [],
  read_file: ["path"],
  declare_intent: ["target", "action", "what", "input", "output"],
  edit_region: ["path", "oldText", "newText"],
  create_file: ["path", "content"],
  finish_intent: ["intentId"],
  run_command: ["cmd"],
  run_tests: [],
  ack_briefing: ["briefingId", "response"],
  ask_agent: ["to", "about", "question"],
  reply: ["messageId", "text"],
};

export const TOOL_SCHEMAS: OpenAI.Chat.ChatCompletionTool[] = [
  tool("list_files", "List every file in the shared project with the rev of its last edit.", {}, TOOL_REQUIRED.list_files),
  tool(
    "read_file",
    "Read the latest content of a file (optionally a 1-based inclusive line range). Always read right before editing: other agents and humans edit the same files live.",
    {
      path: str("POSIX path relative to the project root, e.g. src/checkout.ts"),
      startLine: int("First line to return, 1-based inclusive"),
      endLine: int("Last line to return, 1-based inclusive"),
    },
    TOOL_REQUIRED.read_file,
  ),
  tool(
    "declare_intent",
    "Declare what you are about to change before editing. Hive checks it against other agents' intents and briefs dependents. Returns the intent id and status approved | conflict.",
    {
      target: {
        type: "object",
        description: "The symbol you will change or add",
        properties: { file: str("File path"), symbol: str("Top-level symbol name, e.g. calculateTotal") },
        required: ["file", "symbol"],
        additionalProperties: false,
      },
      action: { type: "string", enum: ["modify", "add", "delete"], description: "What happens to the symbol" },
      what: str("What you are doing, 5..200 chars"),
      input: str("Inputs/params of the symbol after the change"),
      output: str("Promised output/behavior after the change: what it returns, units, edge cases. 10..300 chars"),
      check: str("Optional vitest check proving the output. It runs in an isolated test file where only the exports of the target file are in scope (imported for you): define any input data inline, e.g. const items = [{ sku: \"a\", priceCents: 1500, qty: 1 }]; expect(calculateTotal(items)).toBe(1609). 1-3 lines, no imports, no describe/it wrappers."),
    },
    TOOL_REQUIRED.declare_intent,
  ),
  tool(
    "edit_region",
    "Replace exactly one occurrence of oldText with newText in the latest version of the file. Use a small unique oldText. On OLD_TEXT_NOT_FOUND, error.current holds the fresh file content: re-anchor and retry.",
    {
      intentId: str("The approved intent this edit belongs to (required in hive mode)"),
      path: str("File path"),
      oldText: str("Exact text to replace; must occur exactly once"),
      newText: str("Replacement text"),
    },
    TOOL_REQUIRED.edit_region,
  ),
  tool(
    "create_file",
    "Create a new file with the given content.",
    {
      intentId: str("The approved intent this file belongs to (required in hive mode)"),
      path: str("File path"),
      content: str("Full file content"),
    },
    TOOL_REQUIRED.create_file,
  ),
  tool(
    "finish_intent",
    "Call when the function is done. Closes the change set and triggers the test run. If you decided NOT to change a declared target, call it anyway to release the target for other agents (no edits = cancelled).",
    { intentId: str("Intent id") },
    TOOL_REQUIRED.finish_intent,
  ),
  tool(
    "run_command",
    "Run a shell command on a snapshot of the current project files (e.g. npx tsc --noEmit).",
    { cmd: str("Command line"), timeoutSec: int("Timeout in seconds") },
    TOOL_REQUIRED.run_command,
  ),
  tool(
    "run_tests",
    "Run the project's vitest suite on a snapshot of the current files. Omit filter to run everything; a filter that matches no tests is reported as a failure.",
    { filter: str("Optional vitest test-name regex (vitest -t), NOT a file path. Omit it to run everything; a filter that matches no tests is reported as a failure.") },
    TOOL_REQUIRED.run_tests,
  ),
  tool(
    "ack_briefing",
    "Acknowledge a briefing. Required before your next edit for every briefing with requiresAck: true.",
    {
      briefingId: str("Briefing id, e.g. br_7"),
      response: { type: "string", enum: ["adapted", "not_relevant", "ask"], description: "adapted = you changed plan or code; not_relevant = explain why in note; ask = you need more information" },
      note: str("Short explanation"),
    },
    TOOL_REQUIRED.ack_briefing,
  ),
  tool(
    "ask_agent",
    "Ask another agent a question about a symbol or intent. Max 3 exchanges per thread; the 4th goes to the humans.",
    { to: str("Agent id, e.g. agent-masha"), about: str("Symbol name or intent id"), question: str("Your question") },
    TOOL_REQUIRED.ask_agent,
  ),
  tool(
    "reply",
    "Reply to a message another agent sent you (delivered as a briefing of kind message).",
    { messageId: str("Message id from the briefing details"), text: str("Your reply") },
    TOOL_REQUIRED.reply,
  ),
];

export const TOOL_NAMES: ToolName[] = Object.keys(TOOL_REQUIRED) as ToolName[];

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_REQUIRED, name);
}
