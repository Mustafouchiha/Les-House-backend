import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@prisma/client";

export const ROLE_RANK: Record<Role, number> = {
  CUSTOMER: 0,
  WORKER: 1,
  OPERATOR: 2,
  MANAGER: 3,
  ADMIN: 4,
};

export function atLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Route guard: `preHandler: requireRole("OPERATOR")` (min rank) */
export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const role = req.currentUser?.role;
    if (!role || !atLeast(role, min)) {
      return reply.code(403).send({ error: "forbidden", message: "Ruxsat etilmagan" });
    }
  };
}

/** Route guard: exact set membership */
export function requireAnyRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const role = req.currentUser?.role;
    if (!role || !roles.includes(role)) {
      return reply.code(403).send({ error: "forbidden", message: "Ruxsat etilmagan" });
    }
  };
}

// What a role may see about a product's internal economics.
export function canSeeInternal(role: Role | undefined): boolean {
  return !!role && atLeast(role, "OPERATOR");
}

// Sellers (WORKER) see sale totals but not company profit/cost.
export function canSeeProfit(role: Role | undefined): boolean {
  return !!role && atLeast(role, "MANAGER");
}
