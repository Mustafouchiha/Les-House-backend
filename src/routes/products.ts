import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { serializeProduct } from "../lib/serialize.js";
import { requireRole } from "../auth/rbac.js";
import { D } from "../lib/money.js";

const upsertSchema = z.object({
  sku: z.string().min(1).optional(),
  name: z.string().min(1),
  categoryId: z.string().optional().nullable(),
  typeId: z.string().optional().nullable(),
  material: z.string().optional().nullable(),
  woodType: z.string().optional().nullable(),
  quality: z.string().optional().nullable(),
  unit: z.enum(["M3", "M2", "METER", "PIECE", "KG", "SET"]).optional(),
  dimX: z.number().optional().nullable(),
  dimY: z.number().optional().nullable(),
  dimZ: z.number().optional().nullable(),
  length: z.number().optional().nullable(),
  cost: z.number().nonnegative().optional(),
  startPrice: z.number().nonnegative().optional(),
  minPrice: z.number().nonnegative().optional(),
  sellPrice: z.number().nonnegative().optional(),
  minStock: z.number().nonnegative().optional(),
  rating: z.number().min(0).max(5).optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  images: z.array(z.string().min(1)).max(4, "Ko'pi bilan 4 ta rasm").optional(),
  note: z.string().optional().nullable(),
});

const PRICE_FIELDS = ["sellPrice", "minPrice", "startPrice", "cost"] as const;

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const q = z
      .object({ search: z.string().optional(), category: z.string().optional() })
      .parse(req.query);
    const items = await prisma.product.findMany({
      where: {
        active: true,
        ...(q.category ? { category: { name: q.category } } : {}),
        ...(q.search
          ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { sku: { contains: q.search, mode: "insensitive" } }] }
          : {}),
      },
      include: { category: true, type: true },
      orderBy: { name: "asc" },
    });
    return { items: items.map((p) => serializeProduct(p, req.currentUser!.role)) };
  });

  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = await prisma.product.findUnique({ where: { id }, include: { category: true, type: true } });
    if (!p) return reply.code(404).send({ error: "not_found" });
    return serializeProduct(p, req.currentUser!.role);
  });

  app.post("/", { preHandler: requireRole("OPERATOR") }, async (req) => {
    const body = upsertSchema.parse(req.body);
    const sku = body.sku || "P-" + Date.now().toString(36).toUpperCase();
    const p = await prisma.product.create({
      data: { ...body, sku, stockQty: 0 },
      include: { category: true, type: true },
    });
    await prisma.auditLog.create({
      data: { userId: req.currentUser!.id, role: req.currentUser!.role, action: "product.create", entityType: "product", entityId: p.id, newValue: { name: p.name } },
    });
    return serializeProduct(p, req.currentUser!.role);
  });

  app.patch("/:id", { preHandler: requireRole("OPERATOR") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = upsertSchema.partial().parse(req.body);
    const before = await prisma.product.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "not_found" });

    const isAdmin = req.currentUser!.role === "ADMIN";
    // record price-history rows; flag large moves for admin approval (spec §6, §29)
    for (const f of PRICE_FIELDS) {
      const next = (body as Record<string, number | undefined>)[f];
      if (next == null) continue;
      const old = D((before as Record<string, unknown>)[f] as number);
      if (D(next).eq(old)) continue;
      const bigMove = old.gt(0) && D(next).minus(old).abs().div(old).gt(0.2);
      await prisma.priceHistory.create({
        data: {
          productId: id,
          field: f,
          oldValue: old.toNumber(),
          newValue: next,
          changedBy: req.currentUser!.id,
          needsApproval: bigMove && !isAdmin,
          approved: !(bigMove && !isAdmin),
        },
      });
    }

    const p = await prisma.product.update({ where: { id }, data: body, include: { category: true, type: true } });
    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: req.currentUser!.role,
        action: "product.update",
        entityType: "product",
        entityId: id,
        oldValue: { sellPrice: Number(before.sellPrice), minPrice: Number(before.minPrice) },
        newValue: body,
      },
    });
    return serializeProduct(p, req.currentUser!.role);
  });
};

export default routes;
