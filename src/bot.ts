import { env } from "./env.js";
import { prisma } from "./db.js";
import { upsertTelegramUser, linkPhoneAndResolveRole } from "./services/auth.service.js";

/**
 * Minimal Telegram bot: /start greets the user, opens the Mini App, and asks
 * for the phone number ONLY if this Telegram account has none on file yet —
 * once linked, the request-contact keyboard is not shown again.
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
  const { Bot, InlineKeyboard, Keyboard } = await import("grammy");
  const bot = new Bot(env.botToken);

  async function hasPhoneOnFile(telegramId: number): Promise<boolean> {
    const u = await prisma.user.findUnique({ where: { telegramUserId: BigInt(telegramId) } });
    return !!u?.phoneNumber;
  }

  bot.command("start", async (ctx) => {
    const kb = new InlineKeyboard().webApp("📱 Mini Appni ochish", env.miniAppUrl);
    await ctx.reply(
      [
        "Taxta Bozor — yog'och va qurilish materiallari savdo tizimi.",
        "",
        "Mini App orqali: katalog, narxlar, savat va kalkulyator.",
        "Xodimlar uchun: savdo, ombor, kassa, qarzlar va hisobotlar.",
        "",
        "Boshlash uchun quyidagi tugmani bosing:",
      ].join("\n"),
      { reply_markup: kb }
    );

    // Ask for the phone only while this account has none linked yet.
    if (ctx.from && !(await hasPhoneOnFile(ctx.from.id))) {
      const contactKb = new Keyboard().requestContact("📞 Raqamni ulashish").resized().oneTime();
      await ctx.reply("Davom etish uchun telefon raqamingizni ulashing:", { reply_markup: contactKb });
    }
  });

  bot.command("app", async (ctx) => {
    const kb = new InlineKeyboard().webApp("📱 Mini App", env.miniAppUrl);
    await ctx.reply("Mini App:", { reply_markup: kb });
  });

  bot.on("message:contact", async (ctx) => {
    const contact = ctx.message.contact;
    if (!ctx.from || !contact) return;
    if (contact.user_id && contact.user_id !== ctx.from.id) {
      await ctx.reply("Iltimos, faqat o'zingizning kontaktingizni ulashing.", {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    try {
      const user = await upsertTelegramUser({
        id: ctx.from.id,
        first_name: ctx.from.first_name,
        last_name: ctx.from.last_name,
        username: ctx.from.username,
        language_code: ctx.from.language_code,
      });
      await linkPhoneAndResolveRole(user.id, contact.phone_number);
      await ctx.reply("✅ Telefon raqamingiz tasdiqlandi. Endi Mini App'ni ochishingiz mumkin.", {
        reply_markup: { remove_keyboard: true },
      });
    } catch (e) {
      await ctx.reply(`Xatolik: ${(e as Error).message}`, { reply_markup: { remove_keyboard: true } });
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
