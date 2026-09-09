// Plain-text rendering of a sale receipt, for delivery to a customer's
// Telegram chat via the bot. Kept text-only on purpose: no fonts, no file
// upload, and Uzbek text renders exactly as typed.

type Item = { name: string; unit: string; quantity: number; unitPrice: number; lineTotal: number };
type Payment = { type: string; amount: number };

export type ReceiptSale = {
  receiptNo?: number;
  number: number;
  createdAt: string | Date;
  sellerName?: string | null;
  customerName?: string | null;
  subtotal: number;
  discount: number;
  roundingDiscount: number;
  finalTotal: number;
  items: Item[];
  payments: Payment[];
};

const UNIT: Record<string, string> = {
  M3: "m3", M2: "m2", METER: "metr", PIECE: "dona", KG: "kg", SET: "kompl",
};
const PAY: Record<string, string> = {
  CASH: "Naqd", CARD: "Karta", BANK: "Bank", DEBT: "Qarz", MIXED: "Aralash",
};

// group thousands with a plain space so it renders identically everywhere
const money = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const qtyStr = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

export function renderReceiptText(s: ReceiptSale): string {
  const d = new Date(s.createdAt);
  const stamp = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  const L: string[] = [];
  L.push("TAXTA BOZOR");
  L.push(`Chek No ${s.receiptNo ?? s.number} | ${stamp}`);
  if (s.sellerName) L.push(`Sotuvchi: ${s.sellerName}`);
  if (s.customerName) L.push(`Mijoz: ${s.customerName}`);
  L.push("--------------------------------");
  for (const it of s.items) {
    L.push(it.name);
    L.push(`  ${qtyStr(it.quantity)} ${UNIT[it.unit] ?? it.unit} x ${money(it.unitPrice)} = ${money(it.lineTotal)}`);
  }
  L.push("--------------------------------");
  L.push(`Oraliq: ${money(s.subtotal)}`);
  if (s.discount > 0) L.push(`Chegirma: -${money(s.discount)}`);
  if (s.roundingDiscount > 0) L.push(`Yaxlitlash: -${money(s.roundingDiscount)}`);
  L.push(`JAMI: ${money(s.finalTotal)} so'm`);
  L.push("");
  for (const p of s.payments) L.push(`${PAY[p.type] ?? p.type}: ${money(p.amount)}`);
  L.push("");
  L.push("Xaridingiz uchun rahmat!");
  return L.join("\n");
}
