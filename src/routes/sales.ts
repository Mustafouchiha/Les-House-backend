import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { createSale, refundSale, serializeSale, SaleError } from "../services/sale.service.js";

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
