import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireRole } from "../auth/rbac.js";
import { roleLabel } from "../services/auth.service.js";
import type { Role } from "@prisma/client";

// Everyone who has ever opened the Mini App is a `User` row (role CUSTOMER by
// default). This is the admin's window on those people: see them, block them,
// hand them a staff role, or close the account. Distinct from /api/customers,
// which is the sales-side customer ledger.
const routes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", requireRole("ADMIN"));

  app.get("/", async (req) => {
    const { search } = z.object({ search: z.string().optional() }).parse(req.query);
    const s = search?.trim();
    const items = await prisma.user.findMany({
      where: s
        ? {
            OR: [
              { firstName: { contains: s, mode: "insensitive" } },
              { lastName: { contains: s, mode: "insensitive" } },
              { username: { contains: s, mode: "insensitive" } },
              { phoneNumber: { contains: s } },
            ],
          }
        : {},
      orderBy: { lastActiveAt: "desc" },
      include: { employee: { include: { position: true, branch: true } } },
    });
    return {
      items: items.map((u) => ({
        id: u.id,
        telegramUserId: u.telegramUserId.toString(),
        name: [u.firstName, u.lastName].filter(Boolean).join(" ") || "Ismsiz",
        username: u.username,
        phone: u.phoneNumber,
        photoUrl: u.photoUrl,
        role: u.role,
        roleLabel: roleLabel(u.role),
        status: u.status,
        isStaff: !!u.employeeId,
        position: u.employee?.position?.name ?? null,
        branchName: u.employee?.branch?.name ?? null,
        lastActiveAt: u.lastActiveAt,
        createdAt: u.createdAt,
        self: u.id === req.currentUser!.id,
      })),
    };
  });

  // Set status and/or role. Choosing a staff role auto-creates (or re-links) an
  // Employee row from the user's own name+phone, so the admin never re-types it;
  // choosing "Mijoz" (CUSTOMER) suspends that staff link.
  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        role: z.enum(["ADMIN", "MANAGER", "OPERATOR", "WORKER", "CUSTOMER"]).optional(),
        status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "BLOCKED"]).optional(),
      })
      .parse(req.body ?? {});

    const u = await prisma.user.findUnique({ where: { id }, include: { employee: true } });
    if (!u) return reply.code(404).send({ error: "not_found" });
    if (u.id === req.currentUser!.id && (body.role || body.status)) {
      return reply.code(422).send({ error: "self", message: "O'zingizni o'zgartira olmaysiz" });
    }

    const data: { role?: Role; status?: typeof body.status; employeeId?: string | null } = {};
    if (body.status) data.status = body.status;

    if (body.role && body.role !== u.role) {
      data.role = body.role;
      if (body.role === "CUSTOMER") {
        if (u.employeeId) {
          await prisma.employee
            .update({ where: { id: u.employeeId }, data: { status: "SUSPENDED", telegramUserId: null } })
            .catch(() => undefined);
        }
        data.employeeId = null;
        if (!body.status) data.status = "ACTIVE";
      } else {
        // staff role: need a phone to key the Employee row
        if (!u.phoneNumber) {
          return reply.code(422).send({
            error: "no_phone",
            message: "Bu foydalanuvchi hali telefon raqamini ulanmagan — rol berib bo'lmaydi.",
          });
        }
        const parts = (u.firstName || u.username || "Xodim").trim().split(/\s+/);
        const employee = await prisma.employee.upsert({
          where: { phone: u.phoneNumber },
          create: {
            firstName: parts[0] || "Xodim",
            lastName: parts.slice(1).join(" ") || u.lastName || null,
            phone: u.phoneNumber,
            role: body.role,
            status: "ACTIVE",
            telegramUserId: u.telegramUserId,
            username: u.username,
            startedAt: new Date(),
            note: `Mini App foydalanuvchisidan tayinlandi`,
          },
          update: { role: body.role, status: "ACTIVE", telegramUserId: u.telegramUserId, username: u.username },
        });
        data.employeeId = employee.id;
        if (!body.status) data.status = "ACTIVE";
      }
    }

    const updated = await prisma.user.update({ where: { id }, data });
    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: "ADMIN",
        action: "user.update",
        entityType: "user",
        entityId: id,
        oldValue: { role: u.role, status: u.status },
        newValue: { role: updated.role, status: updated.status },
      },
    });
    return { ok: true, role: updated.role, status: updated.status };
  });

  // Close an account. Hard-delete only when nothing references it; otherwise the
  // account is unlinked, dropped to CUSTOMER and BLOCKED so history stays intact.
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.currentUser!.id) {
      return reply.code(422).send({ error: "self_delete", message: "O'zingizni o'chira olmaysiz" });
    }
    const u = await prisma.user.findUnique({ where: { id } });
    if (!u) return reply.code(404).send({ error: "not_found" });

    const [saleCount, movementCount, auditCount, cashCount] = await Promise.all([
      prisma.sale.count({ where: { sellerId: id } }),
      prisma.stockMovement.count({ where: { userId: id } }),
      prisma.auditLog.count({ where: { userId: id } }),
      prisma.cashTransaction.count({ where: { userId: id } }),
    ]);

    let outcome: "deleted" | "blocked";
    if (saleCount + movementCount + auditCount + cashCount === 0) {
      if (u.employeeId) {
        await prisma.employee
          .update({ where: { id: u.employeeId }, data: { telegramUserId: null } })
          .catch(() => undefined);
      }
      await prisma.user.delete({ where: { id } });
      outcome = "deleted";
    } else {
      await prisma.user.update({
        where: { id },
        data: { role: "CUSTOMER", status: "BLOCKED", employeeId: null },
      });
      outcome = "blocked";
    }

    await prisma.auditLog.create({
      data: {
        userId: req.currentUser!.id,
        role: "ADMIN",
        action: "user.delete",
        entityType: "user",
        entityId: id,
        oldValue: { phone: u.phoneNumber, role: u.role, name: u.firstName },
        newValue: { outcome },
      },
    });
    return { ok: true, outcome };
  });
};

export default routes;
