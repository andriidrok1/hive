import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PreviewData } from "../api";
import { initialUiState, type UiState } from "../state";
import { mockInitialState } from "../mock";
import { Preview, ReceiptCard } from "./Preview";
import { TooltipProvider } from "../components/ui/tooltip";

const summaryOnly: PreviewData = {
  ok: true,
  summary: { subtotal: 2400, discount: 240, total: 2160, lines: ["Latte x2 $9.00", "Croissant x3 $15.00", "Discount -$2.40", "Total $21.60"] },
  receipt: null,
  formatPercent: null,
  negative: null,
};
const withReceipt: PreviewData = {
  ...summaryOnly,
  receipt: "Items: 5\nLatte x2 $9.00\nCroissant x3 $15.00\nDiscount -$2.40\nTotal $21.60",
  receiptWidth: 19,
  formatPercent: "10%",
  negative: "-$1.50",
};

function stateAt(rev: number): UiState {
  return { ...initialUiState(mockInitialState()), rev };
}

describe("Preview", () => {
  it("renders the summary lines and stat chips from the fetched JSON", async () => {
    const load = vi.fn(async () => summaryOnly);
    render(
      <TooltipProvider>
        <Preview state={stateAt(0)} mock={false} active load={load} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("receipt-lines").textContent).toContain("Croissant x3 $15.00"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByText("HIVE COFFEE")).toBeTruthy();
    expect(screen.getByText("$24.00")).toBeTruthy();
    expect(screen.getByText("-$2.40")).toBeTruthy();
    expect(screen.getByText("$21.60")).toBeTruthy();
    expect(screen.getByTestId("preview-caption").textContent).toBe("updated @rev 0");
    expect(screen.getByLabelText("capabilities").textContent).toContain("receipt()");
  });

  it("shows Open live site + caption only when the state carries previewSiteUrl", async () => {
    const load = vi.fn(async () => summaryOnly);
    const withSite: UiState = { ...stateAt(0), previewSiteUrl: "https://hive-demo.style.dev" };
    const { unmount } = render(
      <TooltipProvider>
        <Preview state={withSite} mock={false} active load={load} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    const link = screen.getByTestId("open-live-site") as HTMLAnchorElement;
    expect(link.textContent).toContain("Open live site");
    expect(link.href).toBe("https://hive-demo.style.dev/");
    expect(link.target).toBe("_blank");
    expect(screen.getByText("Live on Freestyle VM · updates ~2 s after edits")).toBeTruthy();
    expect(screen.getByLabelText("QR code for the live site")).toBeTruthy();
    unmount();

    render(
      <TooltipProvider>
        <Preview state={stateAt(0)} mock={false} active load={load} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("live-site")).toBeNull();
    expect(screen.queryByText(/Live on Freestyle VM/)).toBeNull();
  });

  it("prefers receipt() verbatim when present and shows the capability values", () => {
    render(<ReceiptCard data={withReceipt} />);
    const lines = screen.getByTestId("receipt-lines").textContent ?? "";
    expect(lines.startsWith("Items: 5\n")).toBe(true);
    expect(lines).toContain("Total $21.60");
    expect(screen.getByText("10%")).toBeTruthy();
    expect(screen.getByText("-$1.50")).toBeTruthy();
    expect(screen.getByText(/receipt\(\) · width 19/)).toBeTruthy();
  });

  it("Before / After shows the rev-0 snapshot next to the live result", async () => {
    let data = summaryOnly;
    const load = vi.fn(async () => data);
    const { rerender } = render(
      <TooltipProvider>
        <Preview state={stateAt(0)} mock={false} active load={load} />
      </TooltipProvider>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    // Agents edited the project: a later fetch returns the receipt.
    data = withReceipt;
    rerender(
      <TooltipProvider>
        <Preview state={stateAt(5)} mock={false} active load={load} />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Refresh preview"));
    });
    await waitFor(() => expect(screen.getByTestId("preview-caption").textContent).toBe("updated @rev 5"));
    fireEvent.click(screen.getByRole("button", { name: /Before \/ After/ }));
    const before = screen.getByTestId("receipt-before");
    const after = screen.getByTestId("receipt-after");
    expect(before.textContent).toContain("@rev 0");
    expect(before.textContent).not.toContain("Items: 5");
    expect(after.textContent).toContain("@rev 5");
    expect(after.textContent).toContain("Items: 5");
  });
});
