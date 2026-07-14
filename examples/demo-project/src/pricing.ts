export function applyDiscount(
  subtotal: number,
  discountPercent: number,
): number {
  return subtotal - subtotal * (discountPercent / 100);
}
