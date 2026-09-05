import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { env } from "./env.js";
import { prisma } from "./db.js";
import authPlugin from "./auth/authPlugin.js";

import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import productRoutes from "./routes/products.js";
import categoryRoutes from "./routes/categories.js";
import customerRoutes from "./routes/customers.js";
import inventoryRoutes from "./routes/inventory.js";
import saleRoutes from "./routes/sales.js";
import exchangeRateRoutes from "./routes/exchangeRate.js";
import employeeRoutes from "./routes/employees.js";
import reportRoutes from "./routes/reports.js";
import cashRoutes from "./routes/cash.js";
import branchRoutes from "./routes/branches.js";
import { startBot } from "./bot.js";

export async function buildServer() {
  const app = Fastify({
    logger: env.isProd ? true : { transport: { target: "pino-pretty" } },
    // product images are uploaded as base64 data URLs (up to 4 per product)
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.corsOrigin.includes("*") ? true : env.corsOrigin,
    credentials: true,
  });
  await app.register(authPlugin);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation", message: "Ma'lumot noto'g'ri", details: err.flatten() });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err.name || "error", message: err.message });
  });

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));
  app.get("/api/health", async () => ({ ok: true, ts: Date.now() }));

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(meRoutes, { prefix: "/api/me" });
  await app.register(productRoutes, { prefix: "/api/products" });
  await app.register(categoryRoutes, { prefix: "/api/categories" });
  await app.register(customerRoutes, { prefix: "/api/customers" });
  await app.register(inventoryRoutes, { prefix: "/api/inventory" });
  await app.register(saleRoutes, { prefix: "/api/sales" });
  await app.register(exchangeRateRoutes, { prefix: "/api/exchange-rate" });
  await app.register(employeeRoutes, { prefix: "/api/employees" });
  await app.register(reportRoutes, { prefix: "/api/reports" });
  await app.register(cashRoutes, { prefix: "/api/cash" });
  await app.register(branchRoutes, { prefix: "/api/branches" });

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await prisma.$connect();
    await app.listen({ port: env.port, host: "0.0.0.0" });
    app.log.info(`Taxta Bozor API on :${env.port} (devAuth=${env.authDevMode && !env.botToken})`);
    if (!process.env.SKIP_BOT_POLLING) startBot().catch((e) => app.log.warn(`bot: ${e.message}`));
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }
}

// run only when executed directly (not when imported by tests)
const entry = process.argv[1] ?? "";
if (entry.endsWith("server.ts") || entry.endsWith("server.js")) {
  main();
}
