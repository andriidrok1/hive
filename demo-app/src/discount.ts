import type { Promo } from "./types.js";

/**
 * Subtotal after the promo. "percent" takes value% off, "fixed" takes value cents off.
 * Never goes below 0. Percent promos may produce fractional cents; callers decide how to round.
 */
export function applyDiscount(subtotalCents: number, promo?: Promo): number {
  if (!promo) return subtotalCents;
  const discount = promo.kind === "percent" ? (subtotalCents * promo.value) / 100 : promo.value;
  return Math.max(0, subtotalCents - discount);
}
