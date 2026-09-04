import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { validateInitData } from "../auth/telegramInitData.js";
import { upsertTelegramUser, linkPhoneAndResolveRole } from "../services/auth.service.js";

const devUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  language_code: z.string().optional(),
  phone: z.string().optional(), // dev convenience: auto-link this phone on first login
});

const bodySchema = z.object({
  initData: z.string().optional(),
  devUser: devUserSchema.optional(),
  appVersion: z.string().optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.post("/telegram", async (req, reply) => {
    const body = bodySchema.parse(req.body);

    let tgUser;
    if (body.initData) {
      const result = validateInitData(body.initData, env.botToken, env.telegramAuthTtl);
      if (!result.ok || !result.user) {
        return reply.code(401).send({ error: "bad_init_data", message: `initData rad etildi (${result.reason})` });
      }
      tgUser = result.user;
    } else if (env.authDevMode && !env.botToken && body.devUser) {
      tgUser = body.devUser;
    } else {
      return reply.code(400).send({ error: "no_init_data", message: "initData yuborilmadi" });
    }

    let user = await upsertTelegramUser(tgUser, body.appVersion);

    // dev convenience: if the mock user carries a phone and none is linked yet,
    // link it now so the role picker "just works" without the phone screen.
    const devPhone = !body.initData ? body.devUser?.phone : undefined;
    if (devPhone && !user.phoneNumber && env.authDevMode && !env.botToken) {
      try {
        user = await linkPhoneAndResolveRole(user.id, devPhone);
      } catch {
        /* fall through to the phone screen */
      }
    }

    const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "30d" });
    return { token };
  });

  app.post("/phone", { preHandler: [app.authenticate] }, async (req) => {
    const { phone } = z.object({ phone: z.string().min(7) }).parse(req.body);
    const user = await linkPhoneAndResolveRole(req.currentUser!.id, phone);
    // re-issue token so the role claim is fresh (authz still reads DB)
    const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "30d" });
    return { token, role: user.role, status: user.status };
  });

  // dev helper: which phones map to which seeded role
  app.get("/dev-info", async () => {
    if (!(env.authDevMode && !env.botToken)) return { devMode: false };
    const employees = await prisma.employee.findMany({
      select: { firstName: true, lastName: true, phone: true, role: true, status: true },
    });
    return { devMode: true, employees };
  });
};

export default routes;
