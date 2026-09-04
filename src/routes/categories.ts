import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => {
    const [categories, types] = await Promise.all([
      prisma.productCategory.findMany({ orderBy: { name: "asc" } }),
      prisma.productType.findMany({ orderBy: { name: "asc" } }),
    ]);
    return { categories, types };
  });

  app.post("/", { preHandler: requireRole("OPERATOR") }, async (req) => {
    const { name, kind } = z
      .object({ name: z.string().min(1), kind: z.enum(["category", "type"]).default("category") })
      .parse(req.body);
    if (kind === "type") return prisma.productType.create({ data: { name } });
    return prisma.productCategory.create({ data: { name } });
  });
};

export default routes;
