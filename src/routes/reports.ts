import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { D } from "../lib/money.js";

const UNIT_LABEL: Record<string, string> = {
  M3: "m³", M2: "m²", METER: "metr", PIECE: "dona", KG: "kg", SET: "komplekt",
};

function since(period: string): Date {
  const d = new Date();
  const map: Record<string, number> = { today: 0, "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
  if (period === "today") {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  d.setDate(d.getDate() - (map[period] ?? 30));
  return d;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("OPERATOR"));

  app.get("/dashboard", async (req) => {
    const startToday = since("today");
    const full = req.currentUser!.role === "MANAGER" || req.currentUser!.role === "ADMIN";

    const [todaySales, cashRows, customers, products] = await Promise.all([
      prisma.sale.findMany({
        where: { createdAt: { gte: startToday }, status: "COMPLETED" },
        select: { finalTotal: true, grossProfit: true },
      }),
      prisma.cashTransaction.findMany({ where: { createdAt: { gte: startToday } } }),
      prisma.customer.findMany({ where: { debtBalance: { gt: 0 } }, select: { debtBalance: true } }),
      prisma.product.findMany({ where: { active: true } }),
    ]);

    const revenue = todaySales.reduce((a, s) => a + Number(s.finalTotal), 0);
    const netProfit = todaySales.reduce((a, s) => a + Number(s.grossProfit), 0);
    const cashBalance = cashRows.reduce((a, r) => a + r.direction * Number(r.amount), 0);
    const customerDebt = customers.reduce((a, c) => a + Number(c.debtBalance), 0);
    const inventoryValue = products.reduce((a, p) => a + D(p.stockQty).times(p.cost).toNumber(), 0);
    const lowStock = products
      .filter((p) => D(p.minStock).gt(0) && D(p.stockQty).lt(p.minStock))
      .slice(0, 8)
      .map((p) => ({
        id: p.id,
        name: p.name,
        stockLabel: `${Number(p.stockQty).toString().replace(".", ",")} ${UNIT_LABEL[p.unit]}`,
      }));

    let topProducts: unknown[] = [];
    if (full) {
      const items = await prisma.saleItem.groupBy({
        by: ["productId", "name", "unit"],
        where: { sale: { createdAt: { gte: since("30d") }, status: "COMPLETED" } },
        _sum: { quantity: true, lineTotal: true, lineCost: true },
      });
      topProducts = items
        .map((r) => {
          const revenue = Number(r._sum.lineTotal ?? 0);
          const cogs = Number(r._sum.lineCost ?? 0);
          const profit = revenue - cogs;
          return {
            id: r.productId,
            name: r.name,
            qtyLabel: `${Number(r._sum.quantity ?? 0).toString().replace(".", ",")} ${UNIT_LABEL[r.unit]}`,
            profit,
            marginPct: revenue > 0 ? Math.round((profit / revenue) * 100) : 0,
          };
        })
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 8);
    }

    return {
      today: { revenue, count: todaySales.length, netProfit: full ? netProfit : undefined },
      cashBalance,
      customerDebt,
      debtorCount: customers.length,
      inventoryValue: full ? inventoryValue : undefined,
      lowStock,
      topProducts,
    };
  });

  app.get("/products", async (req) => {
    const { period } = z
      .object({ period: z.enum(["today", "7d", "30d", "90d", "365d"]).default("30d") })
      .parse(req.query);
    const rows = await prisma.saleItem.groupBy({
      by: ["productId", "name", "unit"],
      where: { sale: { createdAt: { gte: since(period) }, status: "COMPLETED" } },
      _sum: { quantity: true, lineTotal: true, lineCost: true },
    });
    const mapped = rows
      .map((r) => {
        const revenue = Number(r._sum.lineTotal ?? 0);
        const cogs = Number(r._sum.lineCost ?? 0);
        const profit = revenue - cogs;
        return {
          id: r.productId,
          name: r.name,
          qtyLabel: `${Number(r._sum.quantity ?? 0).toString().replace(".", ",")} ${UNIT_LABEL[r.unit]}`,
          revenue,
          cogs,
          profit,
          marginPct: revenue > 0 ? Math.round((profit / revenue) * 100) : 0,
        };
      })
      .sort((a, b) => b.revenue - a.revenue);

    const total = mapped.reduce(
      (a, r) => ({ revenue: a.revenue + r.revenue, cogs: a.cogs + r.cogs, profit: a.profit + r.profit }),
      { revenue: 0, cogs: 0, profit: 0 }
    );
    return {
      rows: mapped,
      kpis: {
        ...total,
        marginPct: total.revenue > 0 ? Math.round((total.profit / total.revenue) * 100) : 0,
      },
    };
  });
};

export default routes;
