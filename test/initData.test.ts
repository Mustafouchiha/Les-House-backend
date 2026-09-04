import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { validateInitData } from "../src/auth/telegramInitData.js";

const BOT_TOKEN = "123456:TEST-TOKEN-abcdef";

function sign(params: Record<string, string>, token = BOT_TOKEN): string {
  const dataCheckString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const usp = new URLSearchParams({ ...params, hash });
  return usp.toString();
}

const freshUser = () => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: "AAF",
  user: JSON.stringify({ id: 42, first_name: "Ali", username: "ali" }),
});

describe("validateInitData", () => {
  it("accepts a correctly signed payload", () => {
    const res = validateInitData(sign(freshUser()), BOT_TOKEN, 86400);
    expect(res.ok).toBe(true);
    expect(res.user?.id).toBe(42);
  });

  it("rejects a tampered payload", () => {
    const good = sign(freshUser());
    const tampered = good.replace(/first_name%22%3A%22Ali/, "first_name%22%3A%22Eve");
    const res = validateInitData(tampered, BOT_TOKEN, 86400);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_hash");
  });

  it("rejects a payload signed with a different token", () => {
    const res = validateInitData(sign(freshUser(), "999:OTHER"), BOT_TOKEN, 86400);
    expect(res.ok).toBe(false);
  });

  it("rejects a stale auth_date", () => {
    const stale = { ...freshUser(), auth_date: String(Math.floor(Date.now() / 1000) - 100000) };
    const res = validateInitData(sign(stale), BOT_TOKEN, 86400);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("rejects when no bot token is configured", () => {
    expect(validateInitData(sign(freshUser()), "", 0).ok).toBe(false);
  });
});
