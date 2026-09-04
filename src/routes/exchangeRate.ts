import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth/rbac.js";
import { getUsdRate, setManualRate } from "../lib/cbuRate.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const force = (req.query as { force?: string }).force === "1";
    return getUsdRate(force);
  });

  app.patch("/", { preHandler: requireRole("ADMIN") }, async (req) => {
    const { rate } = z.object({ rate: z.number().positive() }).parse(req.body);
    return setManualRate(rate, req.currentUser!.id);
  });
};

export default routes;
