import { env } from "../env.js";

/** Send a plain text message to a Telegram chat via the Bot API (no grammy
 *  instance required — used for one-off sends like login codes). */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<void> {
  if (!env.botToken) throw new Error("BOT_TOKEN sozlanmagan");
  const res = await fetch(`https://api.telegram.org/bot${env.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API xatosi (${res.status}): ${body.slice(0, 200)}`);
  }
}
