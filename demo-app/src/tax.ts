/** Sales tax rate per US state code. */
export const TAX_RATES: Record<string, number> = {
  CA: 0.0725,
  NY: 0.04,
  TX: 0.0625,
  OR: 0,
};

/** Total including tax for the given state, rounded to whole cents. */
export function applyTax(totalCents: number, state: string): number {
  const rate = TAX_RATES[state];
  if (rate === undefined) throw new Error(`Unknown state: ${state}`);
  return Math.round(totalCents * (1 + rate));
}
