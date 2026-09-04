import crypto from "node:crypto";

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

export interface InitDataResult {
  ok: boolean;
  reason?: string;
  user?: TelegramUser;
  authDate?: number;
}

/**
 * Validate a Telegram Mini App initData string.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret_key = HMAC_SHA256(bot_token, "WebAppData")
 * hash       = HMAC_SHA256(data_check_string, secret_key)
 */
export function validateInitData(initData: string, botToken: string, ttlSeconds = 86400): InitDataResult {
  if (!initData) return { ok: false, reason: "empty" };
  if (!botToken) return { ok: false, reason: "no_bot_token" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no_hash" };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // constant-time compare
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_hash" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (ttlSeconds > 0) {
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > ttlSeconds) return { ok: false, reason: "expired" };
  }

  let user: TelegramUser | undefined;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      return { ok: false, reason: "bad_user_json" };
    }
  }
  if (!user?.id) return { ok: false, reason: "no_user" };

  return { ok: true, user, authDate };
}
