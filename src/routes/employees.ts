import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { normalizePhone } from "../services/auth.service.js";

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("ADMIN"));

  app.get("/", async () => {
    const items = await prisma.employee.findMany({
      orderBy: { createdAt: "desc" },
      include: { branch: true, department: true, position: true },
    });
    return {
      items: items.map((e) => ({
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        phone: e.phone,
        role: e.role,
        status: e.status,
        position: e.position?.name ?? null,
        department: e.department?.name ?? null,
        branchName: e.branch?.name ?? null,
        startedAt: e.startedAt,
      })),
    };
  });

  app.post("/", async (req) => {
    const body = z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().optional(),
        phone: z.string().min(7),
        role: z.enum(["ADMIN", "MANAGER", "OPERATOR", "WORKER"]).default("WORKER"),
        position: z.string().optional(),
        department: z.string().optional(),
        branch: z.string().optional(), // free-text; auto-creates the branch if new
        branchId: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const phone = normalizePhone(body.phone);

    const positionId = body.position
      ? (await prisma.position.upsert({ where: { name: body.position }, create: { name: body.position }, update: {} })).id
      : undefined;
    const departmentId = body.department
      ? (await prisma.department.upsert({ where: { name: body.department }, create: { name: body.department }, update: {} })).id
      : undefined;
    const branchId = body.branch
      ? (await prisma.branch.upsert({ where: { name: body.branch }, create: { name: body.branch }, update: {} })).id
      : body.branchId;

    const e = await prisma.employee.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        phone,
        role: body.role,
        status: "ACTIVE",
        positionId,
        departmentId,
        branchId,
        note: body.note,
        startedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: { userId: req.currentUser!.id, role: "ADMIN", action: "employee.create", entityType: "employee", entityId: e.id, newValue: { phone, role: body.role } },
    });
    return e;
  });

  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        role: z.enum(["ADMIN", "MANAGER", "OPERATOR", "WORKER"]).optional(),
        status: z.enum(["ACTIVE", "SUSPENDED", "BLOCKED"]).optional(),
      })
      .parse(req.body);
    const before = await prisma.employee.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: "not_found" });

    const e = await prisma.employee.update({ where: { id }, data: body });

    // propagate to a linked user account immediately (spec §27, §29)
    if (before.telegramUserId) {
      const user = await prisma.user.findUnique({ where: { telegramUserId: before.telegramUserId } });
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            role: e.status === "ACTIVE" ? e.role : "CUSTOMER",
            status:
              e.status === "BLOCKED" ? "BLOCKED" : e.status === "ACTIVE" ? "ACTIVE" : "SUSPENDED",
          },
        });
      }
    }
    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: "ADMIN",
        action: "employee.update",
        entityType: "employee",
        entityId: id,
        oldValue: { role: before.role, status: before.status },
        newValue: body,
      },
    });
    return e;
  });

  // Delete a staff member's roster entry and close their app account.
  // The linked User is hard-deleted only if it has no sale/audit history
  // (nothing would reference it); otherwise it is unlinked, dropped to
  // CUSTOMER and BLOCKED so historical sales/audit rows stay intact.
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const emp = await prisma.employee.findUnique({ where: { id } });
    if (!emp) return reply.code(404).send({ error: "not_found" });
    if (emp.phone === req.currentUser!.phoneNumber) {
      return reply.code(422).send({ error: "self_delete", message: "O'zingizni o'chira olmaysiz" });
    }

    const user = await prisma.user.findFirst({ where: { employeeId: id } });
    let userOutcome: "deleted" | "blocked" | "none" = "none";

    if (user) {
      const [saleCount, movementCount, auditCount, cashCount] = await Promise.all([
        prisma.sale.count({ where: { sellerId: user.id } }),
        prisma.stockMovement.count({ where: { userId: user.id } }),
        prisma.auditLog.count({ where: { userId: user.id } }),
        prisma.cashTransaction.count({ where: { userId: user.id } }),
      ]);
      if (saleCount + movementCount + auditCount + cashCount === 0) {
        await prisma.user.delete({ where: { id: user.id } });
        userOutcome = "deleted";
      } else {
        await prisma.user.update({
          where: { id: user.id },
          data: { employeeId: null, role: "CUSTOMER", status: "BLOCKED" },
        });
        userOutcome = "blocked";
      }
    }

    await prisma.employee.delete({ where: { id } });
    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: "ADMIN",
        action: "employee.delete",
        entityType: "employee",
        entityId: id,
        oldValue: { phone: emp.phone, role: emp.role, firstName: emp.firstName, lastName: emp.lastName },
        newValue: { userOutcome },
      },
    });
    return { ok: true, userOutcome };
  });
};

export default routes;
