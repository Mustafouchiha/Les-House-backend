import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { createSale, refundSale, serializeSale, SaleError } from "../services/sale.service.js";
import { normalizePhone } from "../services/auth.service.js";
import { sendTelegramMessage } from "../lib/telegramApi.js";
import { renderReceiptText } from "../lib/receiptText.js";

const createSchema = z.object({
  customerId: z.string().nullable().optional(),
  discount: z.number().nonnegative().optional(),
  roundingDiscount: z.number().nonnegative().optional(),
  cuttingFee: z.number().nonnegative().optional(),
  note: z.string().optional(),
  allowBelowMin: z.boolean().optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().positive(),
      })
    )
    .min(1),
  payments: z
    .array(
      z.object({
        type: z.enum(["CASH", "CARD", "BANK", "DEBT"]),
        amount: z.number().positive(),
      })
    )
    .min(1),
});

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("WORKER"));

  app.get("/", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().max(200).default(50) }).parse(req.query);
    const sales = await prisma.sale.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { items: true, payments: true, customer: true },
    });
    return { items: sales.map((s) => serializeSale(s, req.currentUser!.role)) };
  });

  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await prisma.sale.findUnique({
      where: { id },
      include: { items: true, payments: true, customer: true },
    });
    if (!s) return reply.code(404).send({ error: "not_found" });
    return serializeSale(s, req.currentUser!.role);
  });

  app.get("/:id/receipt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = await prisma.sale.findUnique({
      where: { id },
      include: { items: true, payments: true, customer: true },
    });
    if (!s) return reply.code(404).send({ error: "not_found" });
    return { shop: "TAXTA BOZOR", ...serializeSale(s, req.currentUser!.role) };
  });

  app.post("/", async (req, reply) => {
    const body = createSchema.parse(req.body);
    try {
      return await createSale(req.currentUser!, body);
    } catch (e) {
      if (e instanceof SaleError) {
        return reply.code(422).send({ error: "sale_rejected", message: e.message, details: e.details });
      }
      throw e;
    }
  });

  // Send the receipt to a phone number's Telegram account (via the bot) and
  // save that person as a customer. If the phone has no Telegram account the
  // customer is still saved but nothing is delivered.
  app.post("/:id/send-receipt", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { phone, customerName } = z
      .object({ phone: z.string().min(7), customerName: z.string().optional() })
      .parse(req.body);

    const sale = await prisma.sale.findUnique({
      where: { id },
      include: { items: true, payments: true, customer: true },
    });
    if (!sale) return reply.code(404).send({ error: "not_found" });

    const norm = normalizePhone(phone);
    if (!/^\+998\d{9}$/.test(norm)) {
      return reply.code(400).send({ error: "bad_phone", message: "Telefon raqami noto'g'ri" });
    }

    // upsert the customer, and attach to this sale if it had none. Use the
    // sale's own customer name only when the receipt goes to that same phone.
    const sameAsSaleCustomer = sale.customer?.phone === norm;
    const name = (customerName || (sameAsSaleCustomer ? sale.customer?.name : "") || "Mijoz").trim();
    const customer = await prisma.customer.upsert({
      where: { phone: norm },
      create: { name, phone: norm },
      update: customerName ? { name: customerName.trim() } : {},
    });
    if (!sale.customerId) {
      await prisma.sale.update({ where: { id }, data: { customerId: customer.id } });
    }

    const user = await prisma.user.findUnique({ where: { phoneNumber: norm } });
    if (!user) {
      return reply.send({
        ok: true,
        delivered: false,
        customerId: customer.id,
        message: "Mijoz saqlandi. Bu raqam Telegram botga ulanmagan — chek yuborilmadi.",
      });
    }

    // customer-facing view: role "WORKER" keeps cost/profit out
    const text = renderReceiptText(serializeSale(sale, "WORKER"));
    try {
      await sendTelegramMessage(user.telegramUserId.toString(), text);
    } catch (e) {
      return reply.code(502).send({
        error: "send_failed",
        message: `Mijoz saqlandi, lekin chek yuborilmadi: ${(e as Error).message}`,
      });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: req.currentUser!.role,
        action: "sale.send_receipt",
        entityType: "sale",
        entityId: id,
        newValue: { phone: norm, customerId: customer.id },
      },
    });
    return { ok: true, delivered: true, customerId: customer.id, message: `Chek ${norm} raqamiga yuborildi` };
  });

  app.post("/:id/refund", { preHandler: requireRole("OPERATOR") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    try {
      return await refundSale(req.currentUser!, id, reason);
    } catch (e) {
      if (e instanceof SaleError) return reply.code(422).send({ error: "refund_rejected", message: e.message });
      throw e;
    }
  });
};

export default routes;
