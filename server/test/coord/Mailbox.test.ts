import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@hive/shared";
import { BriefingQueue } from "../../src/coord/BriefingQueue.js";
import { Mailbox } from "../../src/coord/Mailbox.js";
import { eventSink } from "./fakes.js";

const A = "agent-andrii";
const B = "agent-boris";

function setup() {
  const sink = eventSink();
  const briefings = new BriefingQueue({ onEvent: sink.onEvent });
  const mailbox = new Mailbox({ briefings, onEvent: sink.onEvent });
  return { sink, briefings, mailbox };
}

const asMsg = (m: AgentMessage | { error: string }): AgentMessage => {
  if ("error" in m) throw new Error(`unexpected ${m.error}`);
  return m;
};

describe("Mailbox", () => {
  it("11c. delivers each message as a `message` briefing (requiresAck false) and emits message_sent once", () => {
    const { mailbox, briefings, sink } = setup();
    const m1 = asMsg(mailbox.ask(A, B, "calculateTotal", "Does it include tax?"));
    expect(m1).toMatchObject({ id: "msg_1", from: A, to: B, about: "calculateTotal", text: "Does it include tax?", exchange: 1 });
    expect(m1.inReplyTo).toBeUndefined();
    const toB = briefings.takeUndelivered(B);
    expect(toB).toHaveLength(1);
    expect(toB[0]).toMatchObject({ kind: "message", fromAgent: A, requiresAck: false, details: { messageId: "msg_1", symbol: "calculateTotal" } });
    expect(toB[0]?.summary).toContain("Does it include tax?");

    const m2 = asMsg(mailbox.reply(B, "msg_1", "No, never."));
    expect(m2).toMatchObject({ id: "msg_2", from: B, to: A, inReplyTo: "msg_1", exchange: 2, about: "calculateTotal" });
    expect(briefings.takeUndelivered(A)[0]).toMatchObject({ kind: "message", fromAgent: B, details: { messageId: "msg_2" } });
    expect(sink.events.filter((e) => e.type === "message_sent").length).toBe(2);
    expect(sink.ofType("message_sent").map((e) => e.message.id)).toEqual(["msg_1", "msg_2"]);
    expect(sink.events.map((e) => e.type)).toEqual(["briefing_sent", "message_sent", "briefing_sent", "message_sent"]);
  });

  it("14. 3 exchanges ok, the 4th is EXCHANGE_LIMIT and the thread goes to humans", () => {
    const { mailbox, briefings } = setup();
    const m1 = asMsg(mailbox.ask(A, B, "applyTax", "Which states?"));
    const m2 = asMsg(mailbox.reply(B, m1.id, "CA only."));
    const m3 = asMsg(mailbox.reply(A, m2.id, "Add NY?"));
    expect([m1.exchange, m2.exchange, m3.exchange]).toEqual([1, 2, 3]);
    expect(mailbox.forHumans()).toEqual([]);

    expect(mailbox.reply(B, m3.id, "Sure.")).toEqual({ error: "EXCHANGE_LIMIT" });
    // a repeated ask on the same topic between the same two agents is the same thread
    expect(mailbox.ask(A, B, "applyTax", "Still there?")).toEqual({ error: "EXCHANGE_LIMIT" });
    expect(mailbox.forHumans().map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(mailbox.thread("msg_2").map((m) => m.id)).toEqual(["msg_1", "msg_2", "msg_3"]);
    expect(briefings.all()).toHaveLength(3);

    // a human can still answer inside the escalated thread; the agent gets it as a briefing
    const h = asMsg(mailbox.reply("andrii", m3.id, "Yes, add NY at 8.875%."));
    expect(h).toMatchObject({ from: "andrii", to: A, inReplyTo: "msg_3", exchange: 3 });
    expect(briefings.takeUndelivered(A).at(-1)).toMatchObject({ kind: "message", fromHuman: "andrii" });

    // a different topic is a fresh thread
    expect(asMsg(mailbox.ask(A, B, "formatPrice", "Cents or dollars?")).exchange).toBe(1);
    expect(mailbox.reply(A, "msg_999", "x")).toEqual({ error: "NOT_FOUND" });
    expect(() => mailbox.ask(A, A, "x", "talking to myself")).toThrow(/yourself/);
    expect(() => mailbox.ask(A, B, "x", "")).toThrow(/required/);
    expect(mailbox.all().length).toBe(5);
  });
});
