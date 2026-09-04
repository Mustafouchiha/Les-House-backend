import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("OPERATOR"));

  app.get("/today", async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = await prisma.cashTransaction.findMany({
      where: { createdAt: { gte: start } },
      orderBy: { createdAt: "asc" },
    });
    const allTime = await prisma.cashTransaction.aggregate({ _sum: { amount: true } });

    const by = (method: string, dir: number) =>
      rows.filter((r) => r.method === method && r.direction === dir).reduce((a, r) => a + Number(r.amount), 0);

    // running balance is all-time signed sum
    const balance = await prisma.cashTransaction.findMany({ select: { direction: true, amount: true } });
    void allTime;

    return {
      balance: balance.reduce((a, r) => a + r.direction * Number(r.amount), 0),
      cashIn: by("CASH", 1),
      cardIn: by("CARD", 1),
      bankIn: by("BANK", 1),
      debtIn: rows.filter((r) => r.category === "debt_payment" && r.direction === 1).reduce((a, r) => a + Number(r.amount), 0),
      out: rows.filter((r) => r.direction === -1).reduce((a, r) => a + Number(r.amount), 0),
      rows: rows.map((r) => ({
        id: r.id,
        time: new Date(r.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        note: `${labelCategory(r.category)}${r.note ? " · " + r.note : ""}`,
        amount: r.direction * Number(r.amount),
      })),
    };
  });
};

function labelCategory(c: string): string {
  return (
    { sale: "Savdo", debt_payment: "Qarz to'lovi", expense: "Xarajat", supplier_payment: "Ta'minotchiga", refund: "Qaytarish", manual: "Qo'lda" }[
      c
    ] || c
  );
}

export default routes;
