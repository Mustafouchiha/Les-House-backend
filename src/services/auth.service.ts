import { prisma } from "../db.js";
import { env } from "../env.js";
import type { TelegramUser } from "../auth/telegramInitData.js";
import type { Role } from "@prisma/client";

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrator",
  MANAGER: "Ish boshqaruvchi",
  OPERATOR: "Operator",
  WORKER: "Sotuvchi",
  CUSTOMER: "Mijoz",
};

/** Upsert a User from a validated Telegram identity. */
export async function upsertTelegramUser(tg: TelegramUser, appVersion?: string) {
  const telegramUserId = BigInt(tg.id);
  const data = {
    firstName: tg.first_name ?? null,
    lastName: tg.last_name ?? null,
    username: tg.username ?? null,
    photoUrl: tg.photo_url ?? null,
    languageCode: tg.language_code ?? null,
    appVersion: appVersion ?? null,
    lastLoginAt: new Date(),
    lastActiveAt: new Date(),
  };
  const user = await prisma.user.upsert({
    where: { telegramUserId },
    create: { telegramUserId, ...data },
    update: data,
  });
  return user;
}

/**
 * Link a phone number to a user and derive the role from an admin-created,
 * ACTIVE employee record. Phone alone never grants a role.
 */
export async function linkPhoneAndResolveRole(userId: string, rawPhone: string) {
  const phone = normalizePhone(rawPhone);
  if (!/^\+998\d{9}$/.test(phone)) {
    throw Object.assign(new Error("Telefon raqami noto'g'ri"), { statusCode: 400 });
  }

  // phone must be unique across users
  const clash = await prisma.user.findFirst({
    where: { phoneNumber: phone, NOT: { id: userId } },
  });
  if (clash) {
    // Name which Telegram identity already holds it, so a person testing
    // with more than one Telegram account can tell which one to actually use
    // instead of getting a bare "already linked" dead end.
    const who = clash.username ? `@${clash.username}` : clash.firstName || "boshqa Telegram akkaunt";
    throw Object.assign(
      new Error(
        `Bu telefon raqami ${who} akkauntiga bog'langan. Agar bu siz bo'lsangiz, o'sha Telegram akkaunt orqali kiring.`
      ),
      { statusCode: 409 }
    );
  }

  const employee = await prisma.employee.findUnique({
    where: { phone },
    include: { branch: true, department: true, position: true },
  });

  let role: Role = "CUSTOMER";
  let status: "PENDING" | "ACTIVE" | "SUSPENDED" | "BLOCKED" = "ACTIVE";
  let employeeId: string | null = null;

  if (employee) {
    if (employee.status === "BLOCKED") {
      status = "BLOCKED";
    } else if (employee.status === "ACTIVE") {
      role = employee.role;
      status = "ACTIVE";
      employeeId = employee.id;
    } else {
      // SUSPENDED / PENDING employee → account waits for admin confirmation
      role = "CUSTOMER";
      status = "SUSPENDED";
      employeeId = employee.id;
    }
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      phoneNumber: phone,
      role,
      status,
      employeeId,
    },
  });

  // keep the employee row pointing back at the Telegram id
  if (employee && !employee.telegramUserId) {
    await prisma.employee
      .update({ where: { id: employee.id }, data: { telegramUserId: user.telegramUserId, username: user.username } })
      .catch(() => undefined);
  }

  return user;
}

export function normalizePhone(v: string): string {
  let s = String(v || "").replace(/[^\d+]/g, "");
  if (s.startsWith("998")) s = "+" + s;
  if (/^\d{9}$/.test(s)) s = "+998" + s;
  return s;
}

export function roleLabel(role: Role): string {
  return ROLE_LABEL[role];
}

export const authServiceMeta = { devMode: env.authDevMode && !env.botToken };
