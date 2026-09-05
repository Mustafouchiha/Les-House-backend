import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { validateInitData } from "../auth/telegramInitData.js";
import { upsertTelegramUser, linkPhoneAndResolveRole, normalizePhone } from "../services/auth.service.js";
import { sendTelegramMessage } from "../lib/telegramApi.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 45 * 1000;

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

  // ---- web (non-Telegram) login: phone -> code delivered via the bot -> JWT ----
  // Only works for a phone that already has a Telegram account on file (the
  // bot can only message chats that have started it), so it's a second
  // factor for an existing account, not a way to create one from scratch.
  app.post("/request-code", async (req, reply) => {
    const { phone } = z.object({ phone: z.string().min(7) }).parse(req.body);
    const norm = normalizePhone(phone);
    const user = await prisma.user.findUnique({ where: { phoneNumber: norm } });
    if (!user) {
      return reply.code(404).send({
        error: "not_registered",
        message:
          "Bu raqam hali ro'yxatdan o'tmagan. Avval Telegram botini ochib, ro'yxatdan o'ting.",
      });
    }

    const recent = await prisma.verificationCode.findFirst({
      where: { phone: norm },
      orderBy: { createdAt: "desc" },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return reply.code(429).send({ error: "rate_limited", message: "Biroz kuting va qayta urinib ko'ring" });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await prisma.verificationCode.create({
      data: { phone: norm, code, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    });
    try {
      await sendTelegramMessage(
        user.telegramUserId.toString(),
        `Taxta Bozor — kirish kodi: ${code}\nKod 5 daqiqa amal qiladi. Agar bu siz bo'lmasangiz, e'tiborsiz qoldiring.`
      );
    } catch (e) {
      return reply.code(502).send({ error: "send_failed", message: (e as Error).message });
    }
    return { ok: true, cooldownSeconds: RESEND_COOLDOWN_MS / 1000 };
  });

  app.post("/verify-code", async (req, reply) => {
    const { phone, code } = z
      .object({ phone: z.string().min(7), code: z.string().min(4).max(8) })
      .parse(req.body);
    const norm = normalizePhone(phone);
    const rec = await prisma.verificationCode.findFirst({
      where: { phone: norm, code, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!rec) return reply.code(400).send({ error: "bad_code", message: "Kod noto'g'ri yoki muddati o'tgan" });

    const user = await prisma.user.findUnique({ where: { phoneNumber: norm } });
    if (!user) return reply.code(404).send({ error: "not_found" });
    if (user.status === "BLOCKED") {
      return reply.code(403).send({ error: "blocked", message: "Accountingiz bloklangan" });
    }

    await prisma.verificationCode.update({ where: { id: rec.id }, data: { consumedAt: new Date() } });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: "30d" });
    return { token };
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
