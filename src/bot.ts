import { env } from "./env.js";
import { upsertTelegramUser, linkPhoneAndResolveRole } from "./services/auth.service.js";

/**
 * Minimal Telegram bot: /start just greets and opens the Mini App. Phone
 * collection happens INSIDE the Mini App (Telegram.WebApp.requestContact —
 * see frontend/src/pages/Login.jsx), not via a bot-level reply keyboard, so
 * nothing extra pops up in the chat itself.
 * Runs only when BOT_TOKEN is set; otherwise it is a no-op so the API can boot
 * without a bot (spec: "Bot yo'q — men ko'rsatma yozaman").
 *
 * BotFather setup (see README):
 *   1. /newbot → get BOT_TOKEN
 *   2. /setdomain or Bot Settings → Configure Mini App → set MINI_APP_URL
 *   3. /setmenubutton → "📱 Mini App" → MINI_APP_URL   (or Main Mini App)
 */
export async function startBot(): Promise<void> {
  if (!env.botToken) {
    console.log("[bot] disabled (no BOT_TOKEN)");
    return;
  }
  const { Bot, InlineKeyboard } = await import("grammy");
  const bot = new Bot(env.botToken);

  bot.command("start", async (ctx) => {
    const kb = new InlineKeyboard().webApp("📱 Mini Appni ochish", env.miniAppUrl);
    await ctx.reply("Taxta Bozor", { reply_markup: kb });
  });

  bot.command("app", async (ctx) => {
    const kb = new InlineKeyboard().webApp("📱 Mini App", env.miniAppUrl);
    await ctx.reply("Mini App:", { reply_markup: kb });
  });

  // Fallback: if someone shares a contact unprompted (attachment menu), link
  // it — no keyboard is ever shown to ask for this, per the above.
  bot.on("message:contact", async (ctx) => {
    const contact = ctx.message.contact;
    if (!ctx.from || !contact) return;
    if (contact.user_id && contact.user_id !== ctx.from.id) return;
    try {
      const user = await upsertTelegramUser({
        id: ctx.from.id,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
        username: ctx.from.username,
        language_code: ctx.from.language_code,
      });
      await linkPhoneAndResolveRole(user.id, contact.phone_number);
      await ctx.reply("✅ Telefon raqamingiz tasdiqlandi.");
    } catch (e) {
      await ctx.reply(`Xatolik: ${(e as Error).message}`);
    }
  });

  bot.catch((err) => console.error("[bot] error", err));

  await bot.api.setMyCommands([
    { command: "start", description: "Boshlash" },
    { command: "app", description: "Mini Appni ochish" },
  ]);

  bot.start({ onStart: () => console.log("[bot] polling started") });
}

// allow `npm run bot` to run it standalone
const entry = process.argv[1] ?? "";
if (entry.endsWith("bot.ts") || entry.endsWith("bot.js")) {
  startBot().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
