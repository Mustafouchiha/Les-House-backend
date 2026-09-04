import { D, type Num } from "./money.js";
import { canSeeInternal } from "../auth/rbac.js";
import type { Product, Role, Unit } from "@prisma/client";

export type Availability = "IN_STOCK" | "LOW" | "OUT";

export function availability(stock: Num, minStock: Num): Availability {
  const s = D(stock);
  const m = D(minStock);
  if (s.lte(0)) return "OUT";
  if (m.gt(0)) {
    if (s.lt(m.times(0.1))) return "OUT";
    if (s.lt(m)) return "LOW";
  } else if (s.lt(1)) {
    return "LOW";
  }
  return "IN_STOCK";
}

const UNIT_LABEL: Record<Unit, string> = {
  M3: "m³",
  M2: "m²",
  METER: "metr",
  PIECE: "dona",
  KG: "kg",
  SET: "komplekt",
};

export function sizeLabel(p: Product): string | null {
  const parts = [p.dimX, p.dimY, p.dimZ, p.length]
    .filter((v) => v != null && D(v).gt(0))
    .map((v) => D(v!).toNumber());
  if (!parts.length) return null;
  return parts.join(" × ") + " mm";
}

export function productImages(p: Product): string[] {
  const raw = p.images;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 4);
}

/**
 * Serialize a product for the API. CUSTOMER / WORKER get the storefront view only
 * (spec §11, §14, §34); OPERATOR+ additionally get cost, margins and exact stock.
 */
export function serializeProduct(
  p: Product & { category?: { name: string } | null; type?: { name: string } | null },
  role: Role | undefined
) {
  const avail = availability(p.stockQty, p.minStock);
  const images = productImages(p);
  const base = {
    id: p.id,
    sku: p.sku,
    name: p.name,
    unit: p.unit,
    unitLabel: UNIT_LABEL[p.unit],
    categoryName: p.category?.name ?? null,
    typeName: p.type?.name ?? null,
    material: p.material,
    woodType: p.woodType,
    quality: p.quality,
    sizeLabel: sizeLabel(p),
    sellPrice: D(p.sellPrice).toNumber(),
    rating: p.rating != null ? D(p.rating).toNumber() : null,
    images,
    imageUrl: images[0] ?? p.imageUrl ?? null,
    availability: avail,
    isResidual: p.isResidual,
  };

  if (!canSeeInternal(role)) return base;

  return {
    ...base,
    cost: D(p.cost).toNumber(),
    startPrice: D(p.startPrice).toNumber(),
    minPrice: D(p.minPrice).toNumber(),
    stockLeft: D(p.stockQty).toNumber(),
    minStock: D(p.minStock).toNumber(),
    receivedQty: D(p.receivedQty).toNumber(),
    soldQty: D(p.soldQty).toNumber(),
    writeOffQty: D(p.writeOffQty).toNumber(),
    margin:
      D(p.sellPrice).gt(0)
        ? Math.round(D(p.sellPrice).minus(p.cost).div(p.sellPrice).times(100).toNumber())
        : 0,
  };
}
