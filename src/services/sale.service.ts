import { Decimal } from "decimal.js";
import { prisma } from "../db.js";
import { D, roundTo, sum, paymentsBalance } from "../lib/money.js";
import type { CurrentUser } from "../auth/authPlugin.js";
import type { PaymentType, Prisma } from "@prisma/client";

export interface SaleCutInput {
  cutLengthM: number | string;
  markupPct?: number | string;
}
export interface SaleItemInput {
  productId: string;
  quantity: number | string;
  unitPrice: number | string;
  // when present: cut one piece to `cutLengthM`; the remainder becomes a new
  // residual product (unit PIECE, +10% price). Remainder must be >= 1 m.
  cut?: SaleCutInput | null;
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
      // residual pieces to spin off as their own products after the sale is written
      const residuals: {
        source: (typeof products)[number];
        remLengthMm: number;
        sellPrice: number;
        minPrice: number;
        unitCost: number;
      }[] = [];

      for (const line of input.items) {
        const p = pMap.get(line.productId);
        if (!p) throw new SaleError(`Mahsulot topilmadi: ${line.productId}`);

        // ---- cut-to-length: price the piece, keep the remainder as a new SKU ----
        let cutInfo: { cutM: Decimal; totalM: Decimal; remM: Decimal } | null = null;
        if (line.cut) {
          const totalM = D(p.length).div(1000);
          if (totalM.lte(0)) {
            throw new SaleError(`${p.name}: uzunlik kiritilmagan — kesib bo'lmaydi`, { productId: p.id });
          }
          const cutM = D(line.cut.cutLengthM);
          if (cutM.lte(0) || cutM.gte(totalM)) {
            throw new SaleError(
              `${p.name}: kesish uzunligi 0 dan katta va ${totalM} m dan kichik bo'lishi kerak`,
              { productId: p.id, totalM: totalM.toNumber() }
            );
          }
          const remM = totalM.minus(cutM);
          if (remM.lt(1)) {
            throw new SaleError(
              `${p.name}: kesishdan keyin ${remM} m qoladi — kamida 1 m qolishi shart`,
              { productId: p.id, remM: remM.toNumber() }
            );
          }
          cutInfo = { cutM, totalM, remM };
        }

        const qty = cutInfo ? D(1) : D(line.quantity);
        let price: Decimal;
        if (cutInfo) {
          // authoritative price: (cutM / totalM) * sellPrice * (1 + markup)
          const markup = Decimal.max(0, Decimal.min(100, D(line.cut!.markupPct ?? 0))).div(100);
          const perM = D(p.sellPrice).div(cutInfo.totalM);
          price = roundTo(cutInfo.cutM.times(perM).times(markup.plus(1)));
        } else {
          price = roundTo(line.unitPrice);
        }
        if (qty.lte(0)) throw new SaleError(`${p.name}: miqdor musbat bo'lishi kerak`);
        if (price.lte(0)) throw new SaleError(`${p.name}: narx musbat bo'lishi kerak`);

        if (!cutInfo && D(p.minPrice).gt(0) && price.lt(p.minPrice) && !allowBelowMin) {
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

        // a whole piece is consumed for a cut, but only the sold length's share
        // of its cost belongs to this sale — the rest rides with the remainder
        let saleLineCost = lineCost;
        if (cutInfo) {
          saleLineCost = lineCost.times(cutInfo.cutM).div(cutInfo.totalM);
          const remCost = lineCost.minus(saleLineCost);
          const perM = D(p.sellPrice).div(cutInfo.totalM);
          residuals.push({
            source: p,
            remLengthMm: cutInfo.remM.times(1000).toNumber(),
            sellPrice: roundTo(cutInfo.remM.times(perM).times(1.1)).toNumber(),
            minPrice: roundTo(cutInfo.remM.times(perM)).toNumber(),
            unitCost: roundTo(remCost, 4).toNumber(),
          });
        }

        const lineTotal = roundTo(qty.times(price));
        const unitCost = qty.gt(0) ? saleLineCost.div(qty) : D(0);
        subtotal = subtotal.plus(lineTotal);
        cogs = cogs.plus(saleLineCost);

        itemRows.push({
          productId: p.id,
          name: cutInfo ? `${p.name} — ${cutInfo.cutM}m kesilgan` : p.name,
          unit: p.unit,
          quantity: qty.toNumber(),
          unitPrice: price.toNumber(),
          lineTotal: lineTotal.toNumber(),
          unitCost: roundTo(unitCost, 4).toNumber(),
          lineCost: roundTo(saleLineCost, 4).toNumber(),
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

      // spin the cut remainders off as their own residual products (unit PIECE)
      for (const r of residuals) {
        const s = r.source;
        const sku = "R-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
        const rp = await tx.product.create({
          data: {
            sku,
            name: `${s.name} — ${D(r.remLengthMm).div(1000)}m qoldiq`,
            categoryId: s.categoryId,
            typeId: s.typeId,
            branchId: s.branchId,
            material: s.material,
            woodType: s.woodType,
            quality: s.quality,
            unit: "PIECE",
            dimX: s.dimX,
            dimY: s.dimY,
            length: r.remLengthMm,
            cost: r.unitCost,
            sellPrice: r.sellPrice,
            startPrice: r.sellPrice,
            minPrice: r.minPrice,
            receivedQty: 1,
            stockQty: 1,
            isResidual: true,
            note: `Kesishdan qoldi — savdo #${sale.number}`,
          },
        });
        await tx.inventoryBatch.create({
          data: {
            productId: rp.id,
            quantity: 1,
            quantityLeft: 1,
            unitCost: r.unitCost,
            currency: "UZS",
            receivedAt: new Date(),
          },
        });
        await tx.stockMovement.create({
          data: {
            productId: rp.id,
            type: "CUT",
            quantity: 1,
            reason: `Kesishdan qoldi (savdo #${sale.number})`,
            refType: "cut",
            refId: sale.id,
            userId: user.id,
          },
        });
      }

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
    customerPhone: sale.customer?.phone ?? null,
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
