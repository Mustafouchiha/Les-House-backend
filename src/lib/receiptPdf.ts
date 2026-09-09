import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ReceiptSale } from "./receiptText.js";

const UNIT: Record<string, string> = {
  M3: "m3", M2: "m2", METER: "metr", PIECE: "dona", KG: "kg", SET: "kompl",
};
const PAY: Record<string, string> = {
  CASH: "Naqd", CARD: "Karta", BANK: "Bank", DEBT: "Qarz", MIXED: "Aralash",
};
const money = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const qtyStr = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

// pdf-lib's StandardFonts use WinAnsi; keep the text to Latin-1 + basic punctuation
const ascii = (s: string) =>
  s.replace(/[‘’]/g, "'").replace(/[–—]/g, "-")
    .split("").filter((ch) => ch.charCodeAt(0) <= 0xff).join("");

/** A slim 72mm-wide receipt PDF, height grows with the line count. */
export async function renderReceiptPdf(s: ReceiptSale): Promise<Uint8Array> {
  const W = 204; // ~72mm
  const M = 16;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  type Row = { t: string; f?: "n" | "b"; s?: number; c?: boolean; gap?: number };
  const rows: Row[] = [];
  rows.push({ t: "TAXTA BOZOR", f: "b", s: 13, c: true });
  const d = new Date(s.createdAt);
  const stamp = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  rows.push({ t: `Chek No ${s.receiptNo ?? s.number}`, s: 8, c: true });
  rows.push({ t: stamp, s: 8, c: true, gap: 4 });
  if (s.sellerName) rows.push({ t: `Sotuvchi: ${s.sellerName}`, s: 8 });
  if (s.customerName) rows.push({ t: `Mijoz: ${s.customerName}`, s: 8 });
  rows.push({ t: "-".repeat(46), s: 8 });
  for (const it of s.items) {
    rows.push({ t: it.name, s: 8.5 });
    rows.push({ t: `  ${qtyStr(it.quantity)} ${UNIT[it.unit] ?? it.unit} x ${money(it.unitPrice)} = ${money(it.lineTotal)}`, s: 8 });
  }
  rows.push({ t: "-".repeat(46), s: 8 });
  rows.push({ t: `Oraliq: ${money(s.subtotal)}`, s: 8.5 });
  if (s.discount > 0) rows.push({ t: `Chegirma: -${money(s.discount)}`, s: 8.5 });
  if (s.roundingDiscount > 0) rows.push({ t: `Yaxlitlash: -${money(s.roundingDiscount)}`, s: 8.5 });
  rows.push({ t: `JAMI: ${money(s.finalTotal)} so'm`, f: "b", s: 11, gap: 4 });
  for (const p of s.payments) rows.push({ t: `${PAY[p.type] ?? p.type}: ${money(p.amount)}`, s: 8.5 });
  rows.push({ t: "Xaridingiz uchun rahmat!", s: 8, c: true, gap: 8 });

  const lineH = (r: Row) => (r.s ?? 8) * 1.5 + (r.gap ?? 0);
  const H = M * 2 + rows.reduce((a, r) => a + lineH(r), 0);
  const page = doc.addPage([W, H]);
  let y = H - M;
  for (const r of rows) {
    const size = r.s ?? 8;
    const f = r.f === "b" ? bold : font;
    const txt = ascii(r.t);
    const x = r.c ? (W - f.widthOfTextAtSize(txt, size)) / 2 : M;
    y -= size * 1.5;
    page.drawText(txt, { x: Math.max(M, x), y, size, font: f, color: rgb(0.1, 0.12, 0.1) });
    y -= r.gap ?? 0;
  }
  return doc.save();
}
