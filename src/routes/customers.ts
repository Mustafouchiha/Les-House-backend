import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { normalizePhone } from "../services/auth.service.js";
import { D, roundTo } from "../lib/money.js";

const PAY_LABEL: Record<string, string> = {
  CASH: "Naqd", CARD: "Karta", BANK: "Bank", DEBT: "Qarz",
};

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("WORKER"));

  app.get("/", async (req) => {
    const { search } = z.object({ search: z.string().optional() }).parse(req.query);
    const items = await prisma.customer.findMany({
      where: search
        ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }] }
        : {},
      orderBy: { name: "asc" },
      include: { _count: { select: { sales: true } } },
    });
    return {
      items: items.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        address: c.address,
        blocked: c.blocked,
        debt: D(c.debtBalance).toNumber(),
        totalSpent: D(c.totalSpent).toNumber(),
        salesCount: c._count.sales,
      })),
    };
  });

  app.get("/debtors", async () => {
    const items = await prisma.customer.findMany({
      where: { debtBalance: { gt: 0 } },
      orderBy: { debtBalance: "desc" },
      include: { debts: { where: { status: { not: "PAID" } } } },
    });
    const now = Date.now();
    const debtors = items.map((c) => {
      const overdue = c.debts.some((d) => d.dueDate && d.dueDate.getTime() < now);
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        debt: D(c.debtBalance).toNumber(),
        status: overdue ? "OVERDUE" : c.debts.some((d) => D(d.paid).gt(0)) ? "PARTIAL" : "UNPAID",
      };
    });
    return {
      debtors,
      total: debtors.reduce((a, d) => a + d.debt, 0),
      overdue: debtors.filter((d) => d.status === "OVERDUE").length,
    };
  });

  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await prisma.customer.findUnique({
      where: { id },
      include: {
        sales: { orderBy: { createdAt: "desc" }, take: 30, include: { payments: true, items: true } },
      },
    });
    if (!c) return reply.code(404).send({ error: "not_found" });
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      address: c.address,
      note: c.note,
      blocked: c.blocked,
      debt: D(c.debtBalance).toNumber(),
      totalSpent: D(c.totalSpent).toNumber(),
      salesCount: c.sales.length,
      sales: c.sales.map((s) => {
        const hasDebt = s.payments.some((p) => p.type === "DEBT");
        return {
          id: s.id,
          number: s.number,
          finalTotal: D(s.finalTotal).toNumber(),
          meta: `${new Date(s.createdAt).toLocaleDateString("ru-RU")} · ${s.items.length} pozitsiya`,
          hasDebt,
          payLabel: s.payments.length === 1 ? PAY_LABEL[s.payments[0]!.type] : "Aralash",
        };
      }),
    };
  });

  app.post("/", async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        phone: z.string().min(7),
        address: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const phone = normalizePhone(body.phone);
    const existing = await prisma.customer.findUnique({ where: { phone } });
    if (existing) return existing;
    return prisma.customer.create({ data: { ...body, phone } });
  });

  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).optional(),
        phone: z.string().min(7).optional(),
        address: z.string().optional().nullable(),
        note: z.string().optional().nullable(),
        blocked: z.boolean().optional(),
      })
      .parse(req.body);
    const before = await prisma.customer.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "not_found" });

    const data: Record<string, unknown> = { ...body };
    if (body.phone) data.phone = normalizePhone(body.phone);

    const c = await prisma.customer.update({ where: { id }, data });
    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: req.currentUser!.role,
        action: "customer.update",
        entityType: "customer",
        entityId: id,
        oldValue: { name: before.name, phone: before.phone, blocked: before.blocked },
        newValue: body,
      },
    });
    return c;
  });

  // Delete is hard only when the customer has no history to preserve;
  // otherwise "blocked" is the durable way to cut them off (see PATCH above).
  app.delete("/:id", { preHandler: requireRole("OPERATOR") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await prisma.customer.findUnique({ where: { id }, include: { _count: { select: { sales: true, debts: true } } } });
    if (!c) return reply.code(404).send({ error: "not_found" });
    if (c._count.sales > 0 || c._count.debts > 0) {
      return reply.code(422).send({
        error: "has_history",
        message: "Bu mijozning savdo/qarz tarixi bor — o'chirib bo'lmaydi. Buning o'rniga bloklang.",
      });
    }
    await prisma.customer.delete({ where: { id } });
    await prisma.auditLog.create({
      data: { userId: req.currentUser!.id, role: req.currentUser!.role, action: "customer.delete", entityType: "customer", entityId: id, oldValue: { name: c.name, phone: c.phone } },
    });
    return { ok: true };
  });

  // Turn a customer into a staff member without re-typing their phone (spec:
  // "mijozlarni operatorlikka qo'shish"). Reuses the same phone -> role wiring
  // as normal onboarding, so if they already have a Telegram account linked
  // it is upgraded immediately.
  app.post("/:id/promote", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { role, position, department, branch } = z
      .object({
        role: z.enum(["ADMIN", "MANAGER", "OPERATOR", "WORKER"]).default("OPERATOR"),
        position: z.string().optional(),
        department: z.string().optional(),
        branch: z.string().optional(),
      })
      .parse(req.body ?? {});
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return reply.code(404).send({ error: "not_found" });

    const existingEmployee = await prisma.employee.findUnique({ where: { phone: customer.phone } });
    if (existingEmployee) return reply.code(409).send({ error: "already_employee", message: "Bu raqam allaqachon xodim sifatida ro'yxatda" });

    const [nameParts, positionId, departmentId, branchId] = await Promise.all([
      Promise.resolve(customer.name.trim().split(/\s+/)),
      position ? prisma.position.upsert({ where: { name: position }, create: { name: position }, update: {} }).then((p) => p.id) : undefined,
      department ? prisma.department.upsert({ where: { name: department }, create: { name: department }, update: {} }).then((d) => d.id) : undefined,
      branch ? prisma.branch.upsert({ where: { name: branch }, create: { name: branch }, update: {} }).then((b) => b.id) : undefined,
    ]);

    const employee = await prisma.employee.create({
      data: {
        firstName: nameParts[0] || customer.name,
        lastName: nameParts.slice(1).join(" ") || null,
        phone: customer.phone,
        role,
        status: "ACTIVE",
        positionId,
        departmentId,
        branchId,
        note: `Mijozdan tayinlandi (${customer.id})`,
        startedAt: new Date(),
      },
    });

    // if this phone already has a Telegram account, upgrade it immediately
    const user = await prisma.user.findUnique({ where: { phoneNumber: customer.phone } });
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { role, status: "ACTIVE", employeeId: employee.id },
      });
      await prisma.employee.update({ where: { id: employee.id }, data: { telegramUserId: user.telegramUserId, username: user.username } });
    }

    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: "ADMIN",
        action: "customer.promote",
        entityType: "customer",
        entityId: id,
        newValue: { employeeId: employee.id, role },
      },
    });
    return { ok: true, employeeId: employee.id, linkedExistingAccount: !!user };
  });

  // partial debt repayment (spec §20)
  app.post("/:id/debt-payment", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { amount, type } = z
      .object({ amount: z.number().positive(), type: z.enum(["CASH", "CARD", "BANK"]).default("CASH") })
      .parse(req.body);

    return prisma.$transaction(async (tx) => {
      const c = await tx.customer.findUnique({ where: { id } });
      if (!c) return reply.code(404).send({ error: "not_found" });
      let remaining = roundTo(Math.min(amount, D(c.debtBalance).toNumber()));
      if (remaining.lte(0)) return reply.code(422).send({ error: "no_debt", message: "Qarz yo'q" });

      // apply oldest-first across open debts
      const debts = await tx.customerDebt.findMany({
        where: { customerId: id, status: { not: "PAID" } },
        orderBy: { createdAt: "asc" },
      });
      for (const d of debts) {
        if (remaining.lte(0)) break;
        const owe = D(d.principal).minus(d.paid);
        const pay = remaining.gt(owe) ? owe : remaining;
        const newPaid = D(d.paid).plus(pay);
        await tx.customerDebt.update({
          where: { id: d.id },
          data: {
            paid: newPaid.toNumber(),
            status: newPaid.gte(d.principal) ? "PAID" : "PARTIAL",
          },
        });
        remaining = remaining.minus(pay);
      }

      const paid = roundTo(D(Math.min(amount, D(c.debtBalance).toNumber())));
      await tx.customer.update({
        where: { id },
        data: { debtBalance: { decrement: paid.toNumber() } },
      });
      await tx.debtPayment.create({
        data: { customerId: id, amount: paid.toNumber(), type, takenBy: req.currentUser!.id },
      });
      await tx.cashTransaction.create({
        data: {
          direction: 1,
          amount: paid.toNumber(),
          method: type,
          category: "debt_payment",
          refType: "customer",
          refId: id,
          userId: req.currentUser!.id,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: req.currentUser!.id,
          role: req.currentUser!.role,
          action: "debt.payment",
          entityType: "customer",
          entityId: id,
          newValue: { amount: paid.toNumber() },
        },
      });
      return { ok: true, paid: paid.toNumber() };
    });
  });
};

export default routes;
