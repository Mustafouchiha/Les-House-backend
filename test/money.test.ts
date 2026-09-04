import { describe, it, expect } from "vitest";
import { D, roundTo, sum, paymentsBalance } from "../src/lib/money.js";

describe("money helpers", () => {
  it("rounds half-up to 2 places", () => {
    expect(roundTo("100.005").toNumber()).toBe(100.01);
    expect(roundTo(3350.4).toNumber()).toBe(3350.4);
  });

  it("sums decimals without float drift", () => {
    expect(sum(["0.1", "0.2", "0.3"]).toNumber()).toBe(0.6);
  });

  it("validates split payments within tolerance", () => {
    const total = D("2000000");
    expect(paymentsBalance([{ amount: "1000000" }, { amount: "500000" }, { amount: "500000" }], total)).toBe(true);
    expect(paymentsBalance([{ amount: "1000000" }, { amount: "500000" }], total)).toBe(false);
    expect(paymentsBalance([{ amount: "1999999.5" }], total)).toBe(true); // 0.5 within 1 so'm tol
  });
});
