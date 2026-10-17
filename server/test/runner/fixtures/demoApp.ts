// Minimal local copy of the demo app (brief 07) used as a runner fixture.
// Kept as a TS module rather than real files so the server's own vitest run
// does not collect the fixture test files.

export const DEMO_APP_FILES: Record<string, string> = {
  "package.json": `{
  "name": "@hive/demo-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc -p . --noEmit"
  },
  "devDependencies": {
    "vitest": "^5.0.5",
    "typescript": "~5.9.3"
  }
}
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
`,
  "src/types.ts": `export interface Item {
  sku: string;
  priceCents: number;
  qty: number;
}

export interface Promo {
  code: string;
  kind: "percent" | "fixed";
  value: number;
}
`,
  "src/discount.ts": `import type { Promo } from "./types.js";

export function applyDiscount(subtotalCents: number, promo?: Promo): number {
  if (!promo) return subtotalCents;
  const discount =
    promo.kind === "percent" ? Math.round((subtotalCents * promo.value) / 100) : promo.value;
  return Math.max(0, subtotalCents - discount);
}
`,
  "src/checkout.ts": `import { applyDiscount } from "./discount.js";
import type { Item, Promo } from "./types.js";

export function subtotal(items: Item[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item.priceCents * item.qty;
  }
  return sum;
}

export function calculateTotal(items: Item[], promo?: Promo): number {
  return applyDiscount(subtotal(items), promo);
}
`,
  "src/tax.ts": `export const TAX_RATES = {
  CA: 0.0725,
  NY: 0.04,
  TX: 0.0625,
  OR: 0,
} as const;

export type State = keyof typeof TAX_RATES;

export function applyTax(totalCents: number, state: State): number {
  return Math.round(totalCents * (1 + TAX_RATES[state]));
}
`,
  "src/format.ts": `export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
`,
  "src/order.ts": `import { calculateTotal, subtotal } from "./checkout.js";
import { formatPrice } from "./format.js";
import type { Item, Promo } from "./types.js";

export interface OrderSummary {
  subtotal: number;
  discount: number;
  total: number;
  lines: string[];
}

export function orderSummary(items: Item[], promo?: Promo): OrderSummary {
  const sub = subtotal(items);
  const total = calculateTotal(items, promo);
  const discount = sub - total;
  const lines = [
    "Subtotal: " + formatPrice(sub),
    "Discount: " + formatPrice(discount),
    "Total: " + formatPrice(total),
  ];
  return { subtotal: sub, discount, total, lines };
}
`,
  "test/checkout.test.ts": `import { describe, expect, it } from "vitest";
import { calculateTotal, subtotal } from "../src/checkout.js";

const items = [
  { sku: "a", priceCents: 2500, qty: 2 },
  { sku: "b", priceCents: 5000, qty: 1 },
];

describe("subtotal", () => {
  it("sums price times qty", () => {
    expect(subtotal(items)).toBe(10000);
  });

  it("is 0 for no items", () => {
    expect(subtotal([])).toBe(0);
  });
});

describe("calculateTotal", () => {
  it("equals subtotal without promo", () => {
    expect(calculateTotal(items)).toBe(10000);
  });

  it("applies a percent promo", () => {
    expect(calculateTotal(items, { code: "TEN", kind: "percent", value: 10 })).toBe(9000);
  });

  it("applies a fixed promo", () => {
    expect(calculateTotal(items, { code: "OFF5", kind: "fixed", value: 500 })).toBe(9500);
  });
});
`,
  "test/discount.test.ts": `import { describe, expect, it } from "vitest";
import { applyDiscount } from "../src/discount.js";

describe("applyDiscount", () => {
  it("returns subtotal without promo", () => {
    expect(applyDiscount(1000)).toBe(1000);
  });

  it("percent promo rounds to cents", () => {
    expect(applyDiscount(999, { code: "P", kind: "percent", value: 15 })).toBe(849);
  });

  it("fixed promo subtracts cents", () => {
    expect(applyDiscount(1000, { code: "F", kind: "fixed", value: 300 })).toBe(700);
  });

  it("never goes below zero", () => {
    expect(applyDiscount(100, { code: "F", kind: "fixed", value: 300 })).toBe(0);
  });
});
`,
  "test/tax.test.ts": `import { describe, expect, it } from "vitest";
import { TAX_RATES, applyTax } from "../src/tax.js";

describe("applyTax", () => {
  it("adds CA tax", () => {
    expect(applyTax(10000, "CA")).toBe(10725);
  });

  it("rounds to the nearest cent", () => {
    expect(applyTax(999, "NY")).toBe(1039);
  });

  it("OR has no tax", () => {
    expect(TAX_RATES.OR).toBe(0);
    expect(applyTax(1234, "OR")).toBe(1234);
  });
});
`,
  "test/format.test.ts": `import { describe, expect, it } from "vitest";
import { formatPrice } from "../src/format.js";

describe("formatPrice", () => {
  it("formats cents as dollars", () => {
    expect(formatPrice(1234)).toBe("$12.34");
  });

  it("pads cents", () => {
    expect(formatPrice(5)).toBe("$0.05");
  });
});
`,
  "test/order.test.ts": `import { describe, expect, it } from "vitest";
import { calculateTotal } from "../src/checkout.js";
import { formatPrice } from "../src/format.js";
import { orderSummary } from "../src/order.js";

const items = [
  { sku: "a", priceCents: 2500, qty: 2 },
  { sku: "b", priceCents: 5000, qty: 1 },
];

describe("orderSummary", () => {
  it("reports subtotal and total consistent with calculateTotal", () => {
    const s = orderSummary(items);
    expect(s.subtotal).toBe(10000);
    expect(s.total).toBe(calculateTotal(items));
    expect(s.discount).toBe(s.subtotal - s.total);
  });

  it("renders three lines", () => {
    const s = orderSummary(items, { code: "TEN", kind: "percent", value: 10 });
    expect(s.lines).toHaveLength(3);
    expect(s.lines[0]).toBe("Subtotal: $100.00");
    expect(s.lines[s.lines.length - 1]).toBe("Total: " + formatPrice(s.total));
  });
});
`,
};

export function demoAppFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...DEMO_APP_FILES, ...overrides };
}
