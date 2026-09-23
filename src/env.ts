function bool(v: string | undefined, def = false): boolean {
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

export const env = {
  port: Number(process.env.PORT || 8080),
  corsOrigin: (process.env.CORS_ORIGIN || "https://les-house.vercel.app,*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || "dev-insecure-secret",
  authDevMode: bool(process.env.AUTH_DEV_MODE, false),
  telegramAuthTtl: Number(process.env.TELEGRAM_AUTH_TTL || 86400),
  botToken: process.env.BOT_TOKEN || "",
  miniAppUrl: process.env.MINI_APP_URL || "https://les-house.vercel.app",
  adminSeedPhone: process.env.ADMIN_SEED_PHONE || "+998901234567",
  cbuRateUrl: process.env.CBU_RATE_URL || "https://cbu.uz/uz/arkhiv-kursov-valyut/json/",
  defaultUsdUzs: Number(process.env.DEFAULT_USD_UZS || 12800),
  isProd: process.env.NODE_ENV === "production",
};

if (env.isProd && env.authDevMode && !env.botToken) {
  // Loud warning: dev auth in prod without a bot token is an open door.
  console.warn("[env] WARNING: AUTH_DEV_MODE is enabled in production with no BOT_TOKEN.");
}
