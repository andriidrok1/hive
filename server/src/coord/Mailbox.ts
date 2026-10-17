import type { AgentId, AgentMessage, FeedEventBody, HumanId } from "@hive/shared";
import type { BriefingQueue } from "./BriefingQueue.js";
import { badArgs } from "./deps.js";

export const MAX_EXCHANGES = 3;

interface Thread {
  rootId: string;
  about: string;
  participants: Set<string>; // the two agents (or agent + human) in the thread
  messages: AgentMessage[];
  escalated: boolean; // hit the exchange limit; now a matter for humans
}

function isAgent(id: string): boolean {
  return id.startsWith("agent-");
}

/** Agent-to-agent questions with a per-thread exchange cap; over the cap the thread goes to humans. */
export class Mailbox {
  private threads = new Map<string, Thread>();
  private threadOfMessage = new Map<string, Thread>();
  private counter = 0;

  constructor(private readonly deps: { briefings: BriefingQueue; onEvent: (e: FeedEventBody) => void }) {}

  ask(from: AgentId | HumanId, to: AgentId, about: string, question: string): AgentMessage | { error: "EXCHANGE_LIMIT" } {
    if (!from || !to || typeof question !== "string" || !question.trim()) throw badArgs("from, to and question are required");
    if (from === to) throw badArgs("cannot ask yourself");
    about = about || "general";
    // A repeated ask on the same topic between the same two parties continues the thread.
    const existing = [...this.threads.values()].find((t) => t.about === about && t.participants.has(from) && t.participants.has(to));
    if (existing) {
      const last = existing.messages[existing.messages.length - 1];
      return this.send(existing, from, to, question, last?.id);
    }
    const thread: Thread = { rootId: "", about, participants: new Set([from, to]), messages: [], escalated: false };
    return this.send(thread, from, to, question);
  }

  reply(from: AgentId | HumanId, messageId: string, text: string): AgentMessage | { error: "NOT_FOUND" | "EXCHANGE_LIMIT" } {
    if (typeof text !== "string" || !text.trim()) throw badArgs("text is required");
    const thread = this.threadOfMessage.get(messageId);
    const original = thread?.messages.find((m) => m.id === messageId);
    if (!thread || !original) return { error: "NOT_FOUND" };
    // Reply goes to the other side of the message; a human replying addresses the message's author if it is an agent.
    let to: AgentId;
    if (from === original.from) to = original.to;
    else if (isAgent(original.from)) to = original.from;
    else to = original.to;
    if (to === from) return { error: "NOT_FOUND" };
    return this.send(thread, from, to, text, messageId);
  }

  private send(thread: Thread, from: string, to: AgentId, text: string, inReplyTo?: string): AgentMessage | { error: "EXCHANGE_LIMIT" } {
    const humanSpeaking = !isAgent(from);
    const exchange = thread.messages.length + 1;
    if (!humanSpeaking && exchange > MAX_EXCHANGES) {
      thread.escalated = true; // visible through forHumans(); humans may still reply in this thread
      return { error: "EXCHANGE_LIMIT" };
    }
    this.counter += 1;
    const message: AgentMessage = {
      id: `msg_${this.counter}`,
      from,
      to,
      about: thread.about,
      text,
      ...(inReplyTo ? { inReplyTo } : {}),
      exchange: Math.min(exchange, MAX_EXCHANGES),
      createdAt: Date.now(),
    };
    if (!thread.rootId) {
      thread.rootId = message.id;
      this.threads.set(thread.rootId, thread);
    }
    thread.messages.push(message);
    thread.participants.add(from);
    this.threadOfMessage.set(message.id, thread);

    this.deps.briefings.push({
      toAgent: to,
      kind: "message",
      ...(humanSpeaking ? { fromHuman: from } : { fromAgent: from }),
      summary: `${from} ${inReplyTo ? "replied" : "asks"} about ${thread.about}: ${text}${exchange >= MAX_EXCHANGES && !humanSpeaking ? " (last exchange in this thread; further questions go to humans)" : ""}`,
      details: { symbol: thread.about, messageId: message.id },
      requiresAck: false,
    });
    this.deps.onEvent({ type: "message_sent", message });
    return message;
  }

  /** Messages of every thread that hit the exchange limit, oldest first. */
  forHumans(): AgentMessage[] {
    const out: AgentMessage[] = [];
    for (const t of this.threads.values()) if (t.escalated) out.push(...t.messages);
    return out;
  }

  thread(messageId: string): AgentMessage[] {
    return [...(this.threadOfMessage.get(messageId)?.messages ?? [])];
  }

  all(): AgentMessage[] {
    return [...this.threads.values()].flatMap((t) => t.messages).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
}
