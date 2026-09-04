import { Decimal } from "decimal.js";

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

// Decimal.Value plus anything stringifiable (e.g. Prisma.Decimal, a separate copy).
export type Num = Decimal.Value | { toString(): string };

// Coerce via string so a Prisma.Decimal (a separate decimal.js copy) is accepted.
export const D = (v: Num | null | undefined): Decimal => {
  if (v == null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(typeof v === "object" ? (v as { toString(): string }).toString() : v);
};

export const toNum = (v: Num | null | undefined): number => D(v).toNumber();

// round to N decimal places (default 2 for UZS money)
export const roundTo = (v: Num, places = 2): Decimal =>
  D(v).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);

export const sum = (arr: Num[]): Decimal =>
  arr.reduce<Decimal>((a, b) => a.plus(D(b)), new Decimal(0));

export const isPositive = (v: Num): boolean => D(v).gt(0);
export const gte = (a: Num, b: Num): boolean => D(a).gte(D(b));
export const lt = (a: Num, b: Num): boolean => D(a).lt(D(b));

// payments must add up to the expected total within a 1 so'm tolerance
export function paymentsBalance(payments: { amount: Num }[], expected: Num, tol = 1): boolean {
  return sum(payments.map((p) => p.amount))
    .minus(D(expected))
    .abs()
    .lte(tol);
}
