import { describe, it, expect } from "vitest";
import { atLeast, canSeeInternal, canSeeProfit } from "../src/auth/rbac.js";
import { serializeProduct, availability } from "../src/lib/serialize.js";
import type { Product } from "@prisma/client";

const baseProduct = {
  id: "p1",
  sku: "TX-1",
  name: "Taxta 25×150",
  categoryId: null,
  typeId: null,
  branchId: null,
  material: "Sasna",
  woodType: null,
  quality: "1-sort",
  unit: "M3",
  dimX: 25,
  dimY: 150,
  dimZ: null,
  length: 3000,
  cost: 2_600_000,
  startPrice: 3_200_000,
  minPrice: 2_900_000,
  sellPrice: 3_200_000,
  receivedQty: 20,
  soldQty: 2,
  writeOffQty: 0,
  stockQty: 18,
  minStock: 12,
  rating: 4.6,
  imageUrl: null,
  isResidual: false,
  active: true,
  note: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Product;

describe("role ranking", () => {
  it("orders roles", () => {
    expect(atLeast("ADMIN", "OPERATOR")).toBe(true);
    expect(atLeast("WORKER", "OPERATOR")).toBe(false);
    expect(canSeeInternal("OPERATOR")).toBe(true);
    expect(canSeeInternal("WORKER")).toBe(false);
    expect(canSeeProfit("MANAGER")).toBe(true);
    expect(canSeeProfit("OPERATOR")).toBe(false);
  });
});

describe("serializeProduct visibility (spec §11, §34)", () => {
  it("hides cost / minPrice / exact stock from a customer", () => {
    const s = serializeProduct(baseProduct, "CUSTOMER") as Record<string, unknown>;
    expect(s.sellPrice).toBe(3_200_000);
    expect(s.cost).toBeUndefined();
    expect(s.minPrice).toBeUndefined();
    expect(s.stockLeft).toBeUndefined();
    expect(s.availability).toBe("IN_STOCK");
  });

  it("exposes internals to an operator", () => {
    const s = serializeProduct(baseProduct, "OPERATOR") as Record<string, unknown>;
    expect(s.cost).toBe(2_600_000);
    expect(s.minPrice).toBe(2_900_000);
    expect(s.stockLeft).toBe(18);
    expect(s.margin).toBe(19); // (3.2m - 2.6m) / 3.2m ≈ 19%
  });
});

describe("availability buckets", () => {
  it("classifies stock", () => {
    expect(availability(0, 10)).toBe("OUT");
    expect(availability(0.5, 10)).toBe("OUT"); // < 10% of min
    expect(availability(5, 10)).toBe("LOW");
    expect(availability(20, 10)).toBe("IN_STOCK");
  });
});
