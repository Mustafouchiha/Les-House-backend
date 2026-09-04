import { prisma } from "../db.js";
import { env } from "../env.js";
import { D } from "./money.js";

let lastFetch = 0;
const ONE_DAY = 24 * 60 * 60 * 1000;

/** Current USD/UZS rate. Tries CBU once/day, falls back to the last stored row,
 *  then to DEFAULT_USD_UZS (spec §5). */
export async function getUsdRate(force = false): Promise<{ rate: number; source: string; at: Date }> {
  const latest = await prisma.exchangeRate.findFirst({
    where: { pair: "USD/UZS" },
    orderBy: { createdAt: "desc" },
  });

  const stale = !latest || Date.now() - latest.createdAt.getTime() > ONE_DAY;
  if ((force || stale) && Date.now() - lastFetch > 60_000) {
    lastFetch = Date.now();
    try {
      const res = await fetch(env.cbuRateUrl, { signal: AbortSignal.timeout(5000) });
      const arr = (await res.json()) as Array<{ Ccy: string; Rate: string }>;
      const usd = arr.find((x) => x.Ccy === "USD");
      if (usd?.Rate) {
        const rate = D(usd.Rate.replace(",", ".")).toNumber();
        const row = await prisma.exchangeRate.create({
          data: { pair: "USD/UZS", rate, source: "cbu" },
        });
        return { rate, source: "cbu", at: row.createdAt };
      }
    } catch {
      /* offline — use fallback below */
    }
  }

  if (latest) return { rate: D(latest.rate).toNumber(), source: latest.source, at: latest.createdAt };
  return { rate: env.defaultUsdUzs, source: "default", at: new Date() };
}

export async function setManualRate(rate: number, by?: string) {
  const row = await prisma.exchangeRate.create({
    data: { pair: "USD/UZS", rate, source: `manual${by ? ":" + by : ""}` },
  });
  return { rate: D(row.rate).toNumber(), source: row.source, at: row.createdAt };
}
