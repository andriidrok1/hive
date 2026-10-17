/** Formats whole cents as a dollar string: 1234 -> "$12.34". */
export function formatPrice(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${dollars}.${String(rest).padStart(2, "0")}`;
}
