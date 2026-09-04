import { Decimal } from "decimal.js";
import { prisma } from "../db.js";
import { D, roundTo, sum } from "../lib/money.js";
import type { CurrentUser } from "../auth/authPlugin.js";
import type { Currency } from "@prisma/client";

export class InventoryError extends Error {
  statusCode = 422;
}

export interface EntryInput {
  productId: string;
  quantity: number | string;
  unitCost: number | string;
  currency?: Currency;
  usdRate?: number | string;
  extraCost?: number | string; // transport / unloading, spread across the batch
  supplierName?: string;
  supplierId?: string | null;
  note?: string;
  receivedAt?: string;
}

/** Kirim: add a batch, refresh the product's moving cost + aggregates (spec §8, §24). */
export async function stockEntry(user: CurrentUser, input: EntryInput) {
  const qty = D(input.quantity);
  if (qty.lte(0)) throw new InventoryError("Miqdor musbat bo'lishi kerak");

  const currency = input.currency ?? "UZS";
  let unitCostUZS = D(input.unitCost);
  if (unitCostUZS.lte(0)) throw new InventoryError("Tannarx musbat bo'lishi kerak");
  if (currency === "USD") {
    const rate = D(input.usdRate ?? 0);
    if (rate.lte(0)) throw new InventoryError("USD kursi kiritilishi kerak");
    unitCostUZS = unitCostUZS.times(rate);
  }
  const extraPerUnit = qty.gt(0) ? D(input.extraCost ?? 0).div(qty) : D(0);
  const landed = roundTo(unitCostUZS.plus(extraPerUnit), 4);

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) throw new InventoryError("Mahsulot topilmadi");

    const batch = await tx.inventoryBatch.create({
      data: {
        productId: product.id,
        supplierName: input.supplierName || null,
        supplierId: input.supplierId || null,
        quantity: qty.toNumber(),
        quantityLeft: qty.toNumber(),
        unitCost: landed.toNumber(),
        currency,
        usdRate: input.usdRate ? D(input.usdRate).toNumber() : null,
        extraCost: D(input.extraCost ?? 0).toNumber(),
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      },
    });

    // moving average cost over remaining stock
    const openBatches = await tx.inventoryBatch.findMany({
      where: { productId: product.id, quantityLeft: { gt: 0 } },
    });
    const totalLeft = sum(openBatches.map((b) => b.quantityLeft));
    const totalCost = openBatches.reduce<Decimal>(
      (a, b) => a.plus(D(b.quantityLeft).times(b.unitCost)),
      new Decimal(0)
    );
    const movingCost = totalLeft.gt(0) ? roundTo(totalCost.div(totalLeft), 4) : landed;

    await tx.product.update({
      where: { id: product.id },
      data: {
        cost: movingCost.toNumber(),
        receivedQty: { increment: qty.toNumber() },
        stockQty: { increment: qty.toNumber() },
      },
    });
    await tx.stockMovement.create({
      data: {
        productId: product.id,
        type: "IN",
        quantity: qty.toNumber(),
        reason: input.note || null,
        refType: "entry",
        refId: batch.id,
        userId: user.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        role: user.role,
        action: "inventory.entry",
        entityType: "product",
        entityId: product.id,
        newValue: { batchId: batch.id, quantity: qty.toNumber(), unitCost: landed.toNumber(), currency },
      },
    });
    return { batchId: batch.id, movingCost: movingCost.toNumber() };
  });
}

export interface ExitInput {
  productId: string;
  quantity: number | string;
  reason: string;
  note?: string;
}

/** Chiqim: remove stock FIFO for a non-sale reason (spec §25). */
export async function stockExit(user: CurrentUser, input: ExitInput) {
  const qty = D(input.quantity);
  if (qty.lte(0)) throw new InventoryError("Miqdor musbat bo'lishi kerak");

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) throw new InventoryError("Mahsulot topilmadi");

    const batches = await tx.inventoryBatch.findMany({
      where: { productId: product.id, quantityLeft: { gt: 0 } },
      orderBy: { receivedAt: "asc" },
    });
    const available = sum(batches.map((b) => b.quantityLeft));
    if (available.lt(qty)) throw new InventoryError(`Omborda ${available}, so'ralgan ${qty}`);

    let need = qty;
    for (const b of batches) {
      if (need.lte(0)) break;
      const take = Decimal.min(need, D(b.quantityLeft));
      await tx.inventoryBatch.update({
        where: { id: b.id },
        data: { quantityLeft: D(b.quantityLeft).minus(take).toNumber() },
      });
      need = need.minus(take);
    }

    const updated = await tx.product.update({
      where: { id: product.id },
      data: { writeOffQty: { increment: qty.toNumber() }, stockQty: { decrement: qty.toNumber() } },
    });
    if (D(updated.stockQty).lt(0)) throw new InventoryError("Qoldiq manfiy bo'lib qoldi");

    await tx.stockMovement.create({
      data: {
        productId: product.id,
        type: "OUT",
        quantity: qty.negated().toNumber(),
        reason: input.reason,
        refType: "exit",
        userId: user.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        role: user.role,
        action: "inventory.exit",
        entityType: "product",
        entityId: product.id,
        newValue: { quantity: qty.toNumber(), reason: input.reason },
      },
    });
    return { ok: true };
  });
}
