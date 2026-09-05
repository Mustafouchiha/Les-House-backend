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

/**
 * Whether a Telegram chat still exists and can be reached — used to tell a
 * genuinely deactivated/deleted account apart from "someone else's live
 * account" when a phone number's binding is contested. Errs toward "alive"
 * on anything ambiguous (no token, network hiccup, unrecognized error) so we
 * only ever auto-free a phone when Telegram itself is unambiguous about it.
 */
export async function isChatAlive(chatId: string | number): Promise<boolean> {
  if (!env.botToken) return true;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.botToken}/getChat?chat_id=${encodeURIComponent(String(chatId))}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { description?: string } | null;
      const desc = (body?.description || "").toLowerCase();
      if (desc.includes("deactivated") || desc.includes("chat not found") || desc.includes("user not found")) {
        return false;
      }
      return true; // ambiguous failure — don't punish the existing owner
    }
    // Telegram's getChat still returns ok:true for a deactivated account, but
    // scrubs the profile: first_name (mandatory for every real account) comes
    // back empty and username/active_usernames are absent. A live private
    // chat always has a non-empty first_name.
    const body = (await res.json().catch(() => null)) as { result?: { first_name?: string } } | null;
    if (body?.result && body.result.first_name === "") return false;
    return true;
  } catch {
    return true;
  }
}
