import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatBox } from "./ChatBox";
import { ANDRII_SAMPLE_TASK } from "../demoPresets";
import { setMockSink } from "../api";

describe("ChatBox", () => {
  const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
  beforeEach(() => {
    setMockSink(null);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts agent-<you> with the text as task when your agent is not running", async () => {
    render(<ChatBox agents={[]} target={null} onTarget={() => undefined} humanId="andrii" />);
    const box = screen.getByLabelText("instruction") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Give your agent a task…");
    fireEvent.change(box, { target: { value: "Add state tax to checkout" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents");
    expect(JSON.parse(String(init.body))).toEqual({ agentId: "agent-andrii", humanId: "andrii", task: "Add state tax to checkout" });
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("Sample task fills the textarea with the preset text and focuses it, without sending", () => {
    render(<ChatBox agents={[]} target={null} onTarget={() => undefined} humanId="andrii" />);
    const box = screen.getByLabelText("instruction") as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: /Sample task/ }));
    expect(box.value).toBe(ANDRII_SAMPLE_TASK);
    expect(box.value).toContain('"Discount -$5.64.6999"');
    expect(document.activeElement).toBe(box);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides Sample task while your own agent is running", () => {
    const agents = [{ agentId: "agent-andrii", humanId: "andrii", status: "thinking" as const, control: "run" as const }];
    render(<ChatBox agents={agents} target="agent-andrii" onTarget={() => undefined} humanId="andrii" />);
    expect(screen.queryByRole("button", { name: /Sample task/ })).toBeNull();
  });

  it("sends a note (urgent when toggled) to the selected agent when your agent is running", async () => {
    const agents = [
      { agentId: "agent-andrii", humanId: "andrii", status: "thinking" as const, control: "run" as const },
      { agentId: "agent-masha", humanId: "masha", status: "tool" as const, control: "run" as const },
    ];
    render(<ChatBox agents={agents} target="agent-masha" onTarget={() => undefined} humanId="andrii" />);
    const box = screen.getByLabelText("instruction") as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Tell masha what to do…");
    fireEvent.change(box, { target: { value: "Put tax in applyTax" } });
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    let [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agents/agent-masha/note");
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", text: "Put tax in applyTax", urgent: false });

    fireEvent.click(screen.getByText("Urgent"));
    fireEvent.change(box, { target: { value: "Stop now" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ humanId: "andrii", text: "Stop now", urgent: true });
  });
});
