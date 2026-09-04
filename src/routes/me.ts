import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../db.js";
import { NAV_BY_ROLE } from "../lib/nav.js";
import { roleLabel } from "../services/auth.service.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (req) => {
    const u = await prisma.user.findUnique({
      where: { id: req.currentUser!.id },
      include: { employee: { include: { branch: true, department: true, position: true } } },
    });
    if (!u) return { error: "not_found" };
    return {
      id: u.id,
      telegramUserId: u.telegramUserId.toString(),
      phoneNumber: u.phoneNumber,
      firstName: u.firstName,
      lastName: u.lastName,
      username: u.username,
      photoUrl: u.photoUrl,
      role: u.role,
      roleLabel: roleLabel(u.role),
      status: u.status,
      appVersion: u.appVersion,
      branchId: u.employee?.branchId ?? null,
      branchName: u.employee?.branch?.name ?? null,
      department: u.employee?.department?.name ?? null,
      position: u.employee?.position?.name ?? null,
      nav: NAV_BY_ROLE[u.role],
    };
  });

  // customer's own purchase history (matched by phone)
  app.get("/purchases", async (req) => {
    const phone = req.currentUser!.phoneNumber;
    if (!phone) return { items: [] };
    const customer = await prisma.customer.findUnique({ where: { phone } });
    if (!customer) return { items: [] };
    const sales = await prisma.sale.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: "desc" },
      include: { items: true },
      take: 50,
    });
    return {
      items: sales.map((s) => ({
        id: s.id,
        number: s.number,
        createdAt: s.createdAt,
        finalTotal: Number(s.finalTotal),
        items: s.items.map((it) => ({
          name: it.name,
          unit: it.unit,
          quantity: Number(it.quantity),
          lineTotal: Number(it.lineTotal),
        })),
      })),
    };
  });
};

export default routes;
