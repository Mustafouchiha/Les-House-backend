import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => {
    const items = await prisma.branch.findMany({ orderBy: { name: "asc" } });
    return { items };
  });

  app.post("/", { preHandler: requireRole("ADMIN") }, async (req) => {
    const body = z
      .object({ name: z.string().min(1), city: z.string().optional(), address: z.string().optional() })
      .parse(req.body);
    return prisma.branch.upsert({
      where: { name: body.name },
      create: body,
      update: { city: body.city, address: body.address },
    });
  });
};

export default routes;
