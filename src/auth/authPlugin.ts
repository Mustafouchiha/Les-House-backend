import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db.js";
import { env } from "../env.js";
import type { Role, AccountStatus } from "@prisma/client";

export interface CurrentUser {
  id: string;
  telegramUserId: string;
  role: Role;
  status: AccountStatus;
  phoneNumber: string | null;
  branchId: string | null;
  firstName: string | null;
  lastName: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authOptional: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(fastifyJwt, { secret: env.jwtSecret });

  async function load(req: FastifyRequest): Promise<CurrentUser | undefined> {
    let sub: string | undefined;
    try {
      const payload = await req.jwtVerify<{ sub: string }>();
      sub = payload.sub;
    } catch {
      return undefined;
    }
    if (!sub) return undefined;
    // Always read role/status fresh from the DB — never trust the token claim.
    const u = await prisma.user.findUnique({ where: { id: sub } });
    if (!u) return undefined;
    prisma.user
      .update({ where: { id: u.id }, data: { lastActiveAt: new Date() } })
      .catch(() => undefined);
    return {
      id: u.id,
      telegramUserId: u.telegramUserId.toString(),
      role: u.role,
      status: u.status,
      phoneNumber: u.phoneNumber,
      branchId: null,
      firstName: u.firstName,
      lastName: u.lastName,
    };
  }

  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await load(req);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Avtorizatsiya talab qilinadi" });
    if (user.status === "BLOCKED") {
      return reply.code(403).send({
        error: "blocked",
        message: "Accountingiz vaqtincha bloklangan. Administrator bilan bog'laning.",
      });
    }
    req.currentUser = user;
  });

  app.decorate("authOptional", async (req: FastifyRequest) => {
    req.currentUser = await load(req);
  });
};

export default fp(plugin, { name: "auth" });
