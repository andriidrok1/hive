import { calculateTotal } from "./checkout.js";
import { formatPrice } from "./format.js";
import type { Item, Promo } from "./types.js";

export interface OrderSummary {
  subtotal: number;
  discount: number;
  total: number;
  lines: string[];
}

/** Human-readable receipt: one line per item, then subtotal, discount (if any) and total. */
export function orderSummary(items: Item[], promo?: Promo): OrderSummary {
  const sub = calculateTotal(items);
  const total = calculateTotal(items, promo);
  const discount = sub - total;

  const lines = items.map((item) => `${item.sku} x${item.qty} ${formatPrice(item.priceCents * item.qty)}`);
  lines.push(`Subtotal ${formatPrice(sub)}`);
  if (discount > 0) lines.push(`Discount -${formatPrice(discount)}`);
  lines.push(`Total ${formatPrice(total)}`);

  return {
    subtotal: sub,
    discount,
    total,
    lines,
  };
}
