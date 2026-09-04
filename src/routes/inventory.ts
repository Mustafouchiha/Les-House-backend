import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { availability } from "../lib/serialize.js";
import { D } from "../lib/money.js";
import { stockEntry, stockExit, InventoryError } from "../services/inventory.service.js";

const UNIT_LABEL: Record<string, string> = {
  M3: "m³", M2: "m²", METER: "metr", PIECE: "dona", KG: "kg", SET: "komplekt",
};
const TYPE_LABEL: Record<string, string> = {
  IN: "Kirim", OUT: "Chiqim", SALE: "Savdo", REFUND: "Qaytarish", CUT: "Kesish", ADJUST: "Tuzatish",
};

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("OPERATOR"));

  app.get("/", async () => {
    const products = await prisma.product.findMany({
      where: { active: true },
      include: { category: true, batches: { where: { quantityLeft: { gt: 0 } } } },
      orderBy: { name: "asc" },
    });
    return {
      items: products.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        categoryName: p.category?.name ?? null,
        received: D(p.receivedQty).toNumber(),
        sold: D(p.soldQty).toNumber(),
        writeOff: D(p.writeOffQty).toNumber(),
        stockLeft: D(p.stockQty).toNumber(),
        cost: D(p.cost).toNumber(),
        sellPrice: D(p.sellPrice).toNumber(),
        stockValue: D(p.stockQty).times(p.cost).toNumber(),
        availability: availability(p.stockQty, p.minStock),
        batches: p.batches.map((b) => ({
          id: b.id,
          quantityLeft: D(b.quantityLeft).toNumber(),
          unitCost: D(b.unitCost).toNumber(),
          supplierName: b.supplierName,
          receivedAt: b.receivedAt,
        })),
      })),
    };
  });

  app.get("/movements", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().max(100).default(20) }).parse(req.query);
    const moves = await prisma.stockMovement.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { product: true },
    });
    return {
      items: moves.map((m) => {
        const unit = UNIT_LABEL[m.product.unit] || "";
        const q = D(m.quantity);
        return {
          id: m.id,
          productName: m.product.name,
          type: m.type === "SALE" || m.type === "OUT" ? "OUT" : "IN",
          typeLabel: TYPE_LABEL[m.type],
          deltaLabel: (q.gte(0) ? "+" : "") + q.toNumber().toString().replace(".", ",") + " " + unit,
          meta: `${new Date(m.createdAt).toLocaleString("ru-RU")}${m.reason ? " · " + m.reason : ""}`,
          createdAt: m.createdAt,
        };
      }),
    };
  });

  app.post("/entry", async (req, reply) => {
    const body = z
      .object({
        productId: z.string(),
        quantity: z.number().positive(),
        unitCost: z.number().positive(),
        currency: z.enum(["UZS", "USD"]).optional(),
        usdRate: z.number().positive().optional(),
        extraCost: z.number().nonnegative().optional(),
        supplierName: z.string().optional(),
        note: z.string().optional(),
        receivedAt: z.string().optional(),
      })
      .parse(req.body);
    try {
      return await stockEntry(req.currentUser!, body);
    } catch (e) {
      if (e instanceof InventoryError) return reply.code(422).send({ error: "inventory", message: e.message });
      throw e;
    }
  });

  app.post("/exit", async (req, reply) => {
    const body = z
      .object({
        productId: z.string(),
        quantity: z.number().positive(),
        reason: z.string().min(1),
        note: z.string().optional(),
      })
      .parse(req.body);
    try {
      return await stockExit(req.currentUser!, body);
    } catch (e) {
      if (e instanceof InventoryError) return reply.code(422).send({ error: "inventory", message: e.message });
      throw e;
    }
  });
};

export default routes;
