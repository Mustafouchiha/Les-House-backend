/**
 * Integration test for the POS sale transaction. Runs only when TEST_DATABASE_URL
 * (or DATABASE_URL) points at a disposable Postgres with the schema applied:
 *
 *   createdb taxta_test
 *   DATABASE_URL=postgres://.../taxta_test npx prisma migrate deploy
 *   TEST_DATABASE_URL=postgres://.../taxta_test npm test
 *
 * Without a database it is skipped (not failed) so `npm test` is green offline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const run = DB ? describe : describe.skip;

run("createSale (integration)", () => {
  let prisma: import("@prisma/client").PrismaClient;
  let createSale: typeof import("../src/services/sale.service.js").createSale;
  let SaleError: typeof import("../src/services/sale.service.js").SaleError;
  let productId = "";
  let customerId = "";
  const seller = {
    id: "", telegramUserId: "1", role: "WORKER" as const, status: "ACTIVE" as const,
    phoneNumber: null, branchId: null, firstName: "Test", lastName: "Seller",
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
    ({ createSale, SaleError } = await import("../src/services/sale.service.js"));

    const u = await prisma.user.upsert({
      where: { telegramUserId: BigInt(999999) },
      create: { telegramUserId: BigInt(999999), role: "WORKER", status: "ACTIVE", firstName: "Test" },
      update: {},
    });
    seller.id = u.id;

    const p = await prisma.product.create({
      data: {
        sku: "TEST-" + Date.now(), name: "Test taxta", unit: "M3",
        cost: 0, sellPrice: 1000, startPrice: 1000, minPrice: 900, stockQty: 0,
      },
    });
    productId = p.id;
    // two batches, FIFO: 4 @ 600, then 10 @ 800
    await prisma.inventoryBatch.create({ data: { productId, quantity: 4, quantityLeft: 4, unitCost: 600, receivedAt: new Date(Date.now() - 2000) } });
    await prisma.inventoryBatch.create({ data: { productId, quantity: 10, quantityLeft: 10, unitCost: 800, receivedAt: new Date() } });
    await prisma.product.update({ where: { id: productId }, data: { stockQty: 14, receivedQty: 14 } });

    const c = await prisma.customer.create({ data: { name: "Test mijoz", phone: "+99890" + Date.now().toString().slice(-7) } });
    customerId = c.id;
  });

  afterAll(async () => {
    await prisma.saleItem.deleteMany({ where: { productId } });
    await prisma.stockMovement.deleteMany({ where: { productId } });
    await prisma.inventoryBatch.deleteMany({ where: { productId } });
    await prisma.$disconnect();
  });

  it("decrements stock, consumes batches FIFO and computes COGS", async () => {
    const sale = await createSale(seller, {
      items: [{ productId, quantity: 6, unitPrice: 1000 }],
      payments: [{ type: "CASH", amount: 6000 }],
    });
    expect(sale.finalTotal).toBe(6000);
    // COGS = 4*600 + 2*800 = 4000
    const full = await prisma.sale.findUnique({ where: { id: sale.id } });
    expect(Number(full!.cogs)).toBe(4000);
    expect(Number(full!.grossProfit)).toBe(2000);

    const p = await prisma.product.findUnique({ where: { id: productId } });
    expect(Number(p!.stockQty)).toBe(8);

    const batches = await prisma.inventoryBatch.findMany({ where: { productId }, orderBy: { receivedAt: "asc" } });
    expect(Number(batches[0]!.quantityLeft)).toBe(0);
    expect(Number(batches[1]!.quantityLeft)).toBe(8);
  });

  it("rejects overselling and rolls back", async () => {
    const before = await prisma.product.findUnique({ where: { id: productId } });
    await expect(
      createSale(seller, {
        items: [{ productId, quantity: 999, unitPrice: 1000 }],
        payments: [{ type: "CASH", amount: 999000 }],
      })
    ).rejects.toBeInstanceOf(SaleError);
    const after = await prisma.product.findUnique({ where: { id: productId } });
    expect(Number(after!.stockQty)).toBe(Number(before!.stockQty));
  });

  it("rejects below-min price for non-admin", async () => {
    await expect(
      createSale(seller, {
        items: [{ productId, quantity: 1, unitPrice: 500 }],
        payments: [{ type: "CASH", amount: 500 }],
      })
    ).rejects.toThrow(/minimal narx/i);
  });

  it("rejects a payment total mismatch", async () => {
    await expect(
      createSale(seller, {
        items: [{ productId, quantity: 1, unitPrice: 1000 }],
        payments: [{ type: "CASH", amount: 900 }],
      })
    ).rejects.toThrow(/mos kelmadi/i);
  });

  it("creates a debt row for a DEBT payment and needs a customer", async () => {
    await expect(
      createSale(seller, {
        items: [{ productId, quantity: 1, unitPrice: 1000 }],
        payments: [{ type: "DEBT", amount: 1000 }],
      })
    ).rejects.toThrow(/mijoz/i);

    const sale = await createSale(seller, {
      customerId,
      items: [{ productId, quantity: 1, unitPrice: 1000 }],
      payments: [{ type: "DEBT", amount: 1000 }],
    });
    const debt = await prisma.customerDebt.findFirst({ where: { saleId: sale.id } });
    expect(debt).toBeTruthy();
    const c = await prisma.customer.findUnique({ where: { id: customerId } });
    expect(Number(c!.debtBalance)).toBe(1000);
  });
});
