import { env } from "./env.js";

/**
 * Minimal Telegram bot: /start greets the user and opens the Mini App.
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
  });

  bot.command("app", async (ctx) => {
    const kb = new InlineKeyboard().webApp("📱 Mini App", env.miniAppUrl);
    await ctx.reply("Mini App:", { reply_markup: kb });
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
