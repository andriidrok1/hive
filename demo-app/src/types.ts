/** One line of a cart. Prices are integer cents. */
export interface Item {
  sku: string;
  priceCents: number;
  qty: number;
}

/** A promo code. `value` is a percentage (0..100) for "percent" and cents for "fixed". */
export interface Promo {
  code: string;
  kind: "percent" | "fixed";
  value: number;
}
