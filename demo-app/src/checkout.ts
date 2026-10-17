import { applyDiscount } from "./discount.js";
import type { Item, Promo } from "./types.js";

/** Sum of price × qty over all lines, in cents. */
export function subtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
}

/** Subtotal minus the promo discount, in cents. Tax is not included. */
export function calculateTotal(items: Item[], promo?: Promo): number {
  return applyDiscount(subtotal(items), promo);
}
