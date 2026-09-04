import { Decimal } from "decimal.js";
import { prisma } from "../db.js";
import { D, roundTo, sum, paymentsBalance } from "../lib/money.js";
import type { CurrentUser } from "../auth/authPlugin.js";
import type { PaymentType, Prisma } from "@prisma/client";

export interface SaleItemInput {
  productId: string;
  quantity: number | string;
  unitPrice: number | string;
}
export interface SalePaymentInput {
  type: PaymentType;
  amount: number | string;
}
export interface CreateSaleInput {
  customerId?: string | null;
  discount?: number | string;
  roundingDiscount?: number | string;
  cuttingFee?: number | string;
  note?: string;
  allowBelowMin?: boolean;
  items: SaleItemInput[];
  payments: SalePaymentInput[];
}

export class SaleError extends Error {
  statusCode = 422;
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

/**
 * Commit a POS sale. Everything below runs inside one interactive transaction;
 * any thrown error rolls the whole thing back (spec §43).
 */
export async function createSale(user: CurrentUser, input: CreateSaleInput) {
  if (!input.items?.length) throw new SaleError("Savat bo'sh");
  if (!input.payments?.length) throw new SaleError("To'lov turi tanlanmagan");

  const isAdmin = user.role === "ADMIN";
  const allowBelowMin = !!input.allowBelowMin && isAdmin;

  return prisma.$transaction(
    async (tx) => {
      const productIds = [...new Set(input.items.map((i) => i.productId))];
      const products = await tx.product.findMany({ where: { id: { in: productIds } } });
      const pMap = new Map(products.map((p) => [p.id, p]));

      const discount = roundTo(input.discount ?? 0);
      const rounding = roundTo(input.roundingDiscount ?? 0);
      const cuttingFee = roundTo(input.cuttingFee ?? 0);

      let subtotal = D(0);
      let cogs = D(0);
      const itemRows: Prisma.SaleItemCreateManySaleInput[] = [];
      const movementRows: Prisma.StockMovementCreateManyInput[] = [];
      const batchUpdates: { id: string; left: number }[] = [];
      const productUpdates: { id: string; sold: number; stock: number }[] = [];

      for (const line of input.items) {
        const p = pMap.get(line.productId);
        if (!p) throw new SaleError(`Mahsulot topilmadi: ${line.productId}`);

        const qty = D(line.quantity);
        const price = roundTo(line.unitPrice);
        if (qty.lte(0)) throw new SaleError(`${p.name}: miqdor musbat bo'lishi kerak`);
        if (price.lte(0)) throw new SaleError(`${p.name}: narx musbat bo'lishi kerak`);

        if (D(p.minPrice).gt(0) && price.lt(p.minPrice) && !allowBelowMin) {
          throw new SaleError(
            `${p.name}: ${price} — minimal narx ${p.minPrice} dan past`,
            { productId: p.id, minPrice: p.minPrice }
          );
        }

        // stock check against batches (source of truth)
        const batches = await tx.inventoryBatch.findMany({
          where: { productId: p.id, quantityLeft: { gt: 0 } },
          orderBy: { receivedAt: "asc" }, // FIFO
        });
        const available = sum(batches.map((b) => b.quantityLeft));
        if (available.lt(qty)) {
          throw new SaleError(
            `${p.name}: omborda ${available}, so'ralgan ${qty}`,
            { productId: p.id, available: available.toNumber() }
          );
        }

        // consume FIFO, accumulate cost
        let need = qty;
        let lineCost = D(0);
        let firstBatchId: string | null = null;
        for (const b of batches) {
          if (need.lte(0)) break;
          const take = Decimal.min(need, D(b.quantityLeft));
          if (!firstBatchId) firstBatchId = b.id;
          lineCost = lineCost.plus(take.times(b.unitCost));
          const newLeft = D(b.quantityLeft).minus(take);
          batchUpdates.push({ id: b.id, left: newLeft.toNumber() });
          need = need.minus(take);
        }

        const lineTotal = roundTo(qty.times(price));
        const unitCost = qty.gt(0) ? lineCost.div(qty) : D(0);
        subtotal = subtotal.plus(lineTotal);
        cogs = cogs.plus(lineCost);

        itemRows.push({
          productId: p.id,
          name: p.name,
          unit: p.unit,
          quantity: qty.toNumber(),
          unitPrice: price.toNumber(),
          lineTotal: lineTotal.toNumber(),
          unitCost: roundTo(unitCost, 4).toNumber(),
          lineCost: roundTo(lineCost, 4).toNumber(),
          batchId: firstBatchId,
        });
        movementRows.push({
          productId: p.id,
          type: "SALE",
          quantity: qty.negated().toNumber(),
          refType: "sale",
          userId: user.id,
        });
        productUpdates.push({
          id: p.id,
          sold: qty.toNumber(),
          stock: qty.negated().toNumber(),
        });
      }

      const finalTotal = roundTo(subtotal.minus(discount).minus(rounding).plus(cuttingFee));
      if (finalTotal.lt(0)) throw new SaleError("Yakuniy summa manfiy bo'lib qoldi");

      // validate payments
      const payments = input.payments
        .map((p) => ({ type: p.type, amount: roundTo(p.amount) }))
        .filter((p) => p.amount.gt(0));
      if (!payments.length) throw new SaleError("To'lov summasi kiritilmagan");
      if (!paymentsBalance(payments, finalTotal)) {
        throw new SaleError(
          `To'lovlar yig'indisi ${sum(payments.map((p) => p.amount))}, jami ${finalTotal} — mos kelmadi`
        );
      }
      const debtAmount = sum(payments.filter((p) => p.type === "DEBT").map((p) => p.amount));
      if (debtAmount.gt(0) && !input.customerId) {
        throw new SaleError("Qarzli savdo uchun mijoz tanlanishi shart");
      }

      const gross = roundTo(subtotal.minus(discount).minus(rounding).minus(cogs));

      // ---- writes ----
      const sale = await tx.sale.create({
        data: {
          status: "COMPLETED",
          sellerId: user.id,
          sellerName: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
          customerId: input.customerId || null,
          subtotal: subtotal.toNumber(),
          discount: discount.toNumber(),
          roundingDiscount: rounding.toNumber(),
          cuttingFee: cuttingFee.toNumber(),
          finalTotal: finalTotal.toNumber(),
          cogs: roundTo(cogs, 4).toNumber(),
          grossProfit: gross.toNumber(),
          note: input.note || null,
          items: { createMany: { data: itemRows } },
          payments: {
            createMany: { data: payments.map((p) => ({ type: p.type, amount: p.amount.toNumber() })) },
          },
        },
        include: { items: true, payments: true, customer: true },
      });

      for (const b of batchUpdates) {
        await tx.inventoryBatch.update({ where: { id: b.id }, data: { quantityLeft: b.left } });
      }
      for (const u of productUpdates) {
        const updated = await tx.product.update({
          where: { id: u.id },
          data: {
            soldQty: { increment: u.sold },
            stockQty: { increment: u.stock },
          },
        });
        if (D(updated.stockQty).lt(0)) throw new SaleError(`${updated.name}: qoldiq manfiy`);
      }
      await tx.stockMovement.createMany({
        data: movementRows.map((m) => ({ ...m, refId: sale.id })),
      });

      // debt
      if (debtAmount.gt(0) && input.customerId) {
        await tx.customerDebt.create({
          data: {
            customerId: input.customerId,
            saleId: sale.id,
            principal: debtAmount.toNumber(),
            status: "UNPAID",
          },
        });
        await tx.customer.update({
          where: { id: input.customerId },
          data: {
            debtBalance: { increment: debtAmount.toNumber() },
            totalSpent: { increment: finalTotal.toNumber() },
          },
        });
      } else if (input.customerId) {
        await tx.customer.update({
          where: { id: input.customerId },
          data: { totalSpent: { increment: finalTotal.toNumber() } },
        });
      }

      // cash: only the non-debt portion is real money in the drawer (spec §28)
      const cashIn = sum(payments.filter((p) => p.type !== "DEBT").map((p) => p.amount));
      if (cashIn.gt(0)) {
        const primary = payments.find((p) => p.type !== "DEBT")!;
        await tx.cashTransaction.create({
          data: {
            branchId: user.branchId,
            direction: 1,
            amount: cashIn.toNumber(),
            method: primary.type,
            category: "sale",
            refType: "sale",
            refId: sale.id,
            userId: user.id,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          userName: sale.sellerName,
          role: user.role,
          action: "sale.create",
          entityType: "sale",
          entityId: sale.id,
          newValue: {
            number: sale.number,
            finalTotal: finalTotal.toNumber(),
            payments: payments.map((p) => ({ type: p.type, amount: p.amount.toNumber() })),
          },
        },
      });

      return serializeSale(sale, user.role);
    },
    { timeout: 15000 }
  );
}

/** Refund a sale: restock, reverse cash / debt, mark REFUNDED (spec §44). */
export async function refundSale(user: CurrentUser, saleId: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      include: { items: true, payments: true, debt: true },
    });
    if (!sale) throw new SaleError("Savdo topilmadi");
    if (sale.status !== "COMPLETED") throw new SaleError("Bu savdoni qaytarib bo'lmaydi");

    for (const it of sale.items) {
      if (it.batchId) {
        await tx.inventoryBatch.update({
          where: { id: it.batchId },
          data: { quantityLeft: { increment: it.quantity } },
        });
      }
      await tx.product.update({
        where: { id: it.productId },
        data: { soldQty: { decrement: it.quantity }, stockQty: { increment: it.quantity } },
      });
      await tx.stockMovement.create({
        data: {
          productId: it.productId,
          type: "REFUND",
          quantity: it.quantity,
          reason,
          refType: "refund",
          refId: sale.id,
          userId: user.id,
        },
      });
    }

    const cashIn = sum(sale.payments.filter((p) => p.type !== "DEBT").map((p) => p.amount));
    if (cashIn.gt(0)) {
      await tx.cashTransaction.create({
        data: {
          direction: -1,
          amount: cashIn.toNumber(),
          method: "CASH",
          category: "refund",
          refType: "sale",
          refId: sale.id,
          userId: user.id,
        },
      });
    }
    if (sale.debt && sale.customerId) {
      const outstanding = D(sale.debt.principal).minus(sale.debt.paid);
      await tx.customer.update({
        where: { id: sale.customerId },
        data: { debtBalance: { decrement: outstanding.toNumber() } },
      });
      await tx.customerDebt.update({ where: { id: sale.debt.id }, data: { status: "PAID" } });
    }

    const updated = await tx.sale.update({
      where: { id: sale.id },
      data: { status: "REFUNDED", note: [sale.note, reason].filter(Boolean).join(" · ") || null },
      include: { items: true, payments: true, customer: true },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        role: user.role,
        action: "sale.refund",
        entityType: "sale",
        entityId: sale.id,
        newValue: { reason: reason ?? null },
      },
    });
    return serializeSale(updated, user.role);
  }, { timeout: 15000 });
}

type SaleWithRels = Prisma.SaleGetPayload<{
  include: { items: true; payments: true; customer: true };
}>;

export function serializeSale(sale: SaleWithRels, role: string) {
  const showProfit = role === "MANAGER" || role === "ADMIN";
  const hasDebt = sale.payments.some((p) => p.type === "DEBT");
  const payType =
    sale.payments.length === 1 ? sale.payments[0]!.type : "MIXED";
  return {
    id: sale.id,
    number: sale.number,
    receiptNo: sale.number,
    status: sale.status,
    createdAt: sale.createdAt,
    sellerName: sale.sellerName,
    customerId: sale.customerId,
    customerName: sale.customer?.name ?? null,
    subtotal: Number(sale.subtotal),
    discount: Number(sale.discount),
    roundingDiscount: Number(sale.roundingDiscount),
    cuttingFee: Number(sale.cuttingFee),
    finalTotal: Number(sale.finalTotal),
    payType,
    hasDebt,
    note: sale.note,
    items: sale.items.map((it) => ({
      name: it.name,
      unit: it.unit,
      quantity: Number(it.quantity),
      unitPrice: Number(it.unitPrice),
      lineTotal: Number(it.lineTotal),
      ...(showProfit
        ? { unitCost: Number(it.unitCost), lineCost: Number(it.lineCost) }
        : {}),
    })),
    payments: sale.payments.map((p) => ({ type: p.type, amount: Number(p.amount) })),
    ...(showProfit
      ? { cogs: Number(sale.cogs), grossProfit: Number(sale.grossProfit) }
      : {}),
  };
}
