# Taxta Bozor — Telegram Mini App ERP / POS

Yog'och va qurilish materiallari bozori uchun savdo, ombor, kassa, qarzdorlik va
boshqaruv tizimi. Telegram Mini App sifatida ishlaydi.

> **Holat: Phase 1 (vertikal slice).** Telegram/mock auth → rollar → mahsulot
> katalogi → DB-transaction bilan POS savdo → chek. Qolgan modullar (kesish,
> ta'minotchilar, xarajatlar, kalendar, to'liq analitika, Excel/PDF eksport, audit
> log ko'rinishi) keyingi bosqichlarda shu poydevor ustiga qo'shiladi. Schema
> ularning barchasiga joy qoldirgan.

## Nima o'zgardi

Kelgan ikkala fayl ham **UI-maket** edi (ishlaydigan backend/DB/auth yo'q):

- `dadajon shirinliklari.zip` — bo'sh React 18 + Vite skeleti.
- `Taxta Bozor - Operator (standalone).html` — hardcode mock ma'lumotli dizayn-maket.

Shulardan:

- **`frontend/`** — zip'ning Vite + React tuzilishi saqlandi, "Taxta Bozor" deb
  qayta nomlandi, HTML-maketdagi barcha ekranlar React komponentlariga o'tkazildi
  va real API'ga ulandi. Dizayn tokenlari (`theme.css`) maketdan olindi.
- **`backend/`** — yangi: Node + Fastify + Prisma + PostgreSQL (TypeScript).

## Sahifalar (rolega qarab — spec §26)

| Sahifa | CUSTOMER | WORKER | OPERATOR | MANAGER | ADMIN |
|---|:-:|:-:|:-:|:-:|:-:|
| Mahsulotlar / Katalog | ✅ (faqat narx) | ✅ | ✅ | ✅ | ✅ |
| Savat / Kalkulyator / Xaridlar | ✅ | | | | |
| Savdo (POS) | | ✅ | ✅ | ✅ | ✅ |
| Mijozlar / Savdo tarixi | | ✅ | ✅ | ✅ | ✅ |
| Dashboard / Ombor / Kirim-Chiqim / Qarzlar / Kassa | | | ✅ | ✅ | ✅ |
| Hisobotlar (foyda/marja) | | | | ✅ | ✅ |
| Xodimlar | | | | | ✅ |

**Eng muhim qoida (spec §34):** CUSTOMER va WORKER hech qachon tannarx, minimal
narx, ta'minotchi, ichki foyda yoki aniq ombor sonini ko'rmaydi. Bu backendda
`serializeProduct()` da amalga oshirilgan — frontendda yashirish yetarli emas.

## Yangi funksiyalar (Phase 1)

- Telegram `initData` server-side HMAC validatsiyasi (`auth/telegramInitData.ts`).
- Telefon → rol biriktirish: admin oldindan yaratgan **ACTIVE** xodim yozuvi bilan
  mos kelsagina rol beriladi (spec §5, §29). Faqat telefonga ishonilmaydi.
- Account holati: `PENDING / ACTIVE / SUSPENDED / BLOCKED` — bloklangan foydalanuvchi
  spec §27 dagi xabarni ko'radi.
- POS savdo — bitta `prisma.$transaction` ichida: Sale + SaleItem + SalePayment,
  FIFO partiya sarfi + COGS/marja, ombor kamayishi (**hech qachon minusga
  tushmaydi**), StockMovement, kassa yozuvi, qarz (kerak bo'lsa), audit log. Bir
  qismi xato bersa — hammasi rollback (spec §43).
- Narx qoidalari: minimal narxdan past savdo bloklanadi; ADMIN `allowBelowMin` bilan
  o'tkaza oladi (spec §6). Narx-salomatlik indikatori 🟢🟡🔴 (spec §7).
- Miqdor **yoki** jami summa orqali kiritish (spec §20).
- Aralash to'lov (naqd + karta + bank + qarz), yig'indi jami bilan mos kelishi shart.
- Chegirma + yaxlitlash alohida saqlanadi (spec §16).
- Kirim/Chiqim: partiya, valyuta (UZS/USD kurs snapshot bilan), moving-average
  tannarx (spec §8, §24, §25).
- Qarzni qisman to'lash (spec §20), kassa harakati + audit.
- Chek: ekranda + `@media print` (58 / 80 mm), tarixdan qayta chop etish (spec §36–37).
- USD/UZS kursi: CBU API'dan kuniga bir marta, internet yo'q bo'lsa oxirgi saqlangan
  qiymat, admin qo'lda o'zgartira oladi (spec §5).
- Hisob-kitoblar `decimal.js` bilan (floating-point xatolarsiz).

## Database migrationlar

Schema: `backend/prisma/schema.prisma`. Asosiy jadvallar: `User`, `Employee`,
`Branch`, `Department`, `Position`, `Product`, `ProductCategory`, `ProductType`,
`InventoryBatch`, `StockMovement`, `PriceHistory`, `Sale`, `SaleItem`,
`SalePayment`, `Customer`, `CustomerDebt`, `DebtPayment`, `CashTransaction`,
`ExchangeRate`, `AuditLog`, `Setting`. Keyingi bosqich uchun bo'sh stub jadvallar:
`Supplier*`, `Expense*`, `CuttingService/Operation`.

Migratsiya yaratish / qo'llash:

```bash
cd backend
npx prisma migrate dev --name init      # local: migratsiya yaratadi + qo'llaydi
npx prisma migrate deploy               # prod: mavjud migratsiyalarni qo'llaydi
npm run seed                            # demo ma'lumot + admin xodim
```

## API endpointlar

`/api` prefiksi bilan. Barchasi (auth'dan tashqari) JWT talab qiladi; authorization
**har doim DB'dagi haqiqiy rol** bilan tekshiriladi.

| Metod | Yo'l | Min rol |
|---|---|---|
| POST | `/api/auth/telegram` | — (public) |
| POST | `/api/auth/phone` | auth |
| GET | `/api/me`, `/api/me/purchases` | auth |
| GET | `/api/products`, `/api/products/:id` | auth |
| POST/PATCH | `/api/products`, `/api/products/:id` | OPERATOR |
| GET/POST | `/api/categories` | auth / OPERATOR |
| GET/POST | `/api/customers`, `/api/customers/:id` | WORKER |
| GET | `/api/customers/debtors` | WORKER |
| POST | `/api/customers/:id/debt-payment` | WORKER |
| GET | `/api/inventory`, `/api/inventory/movements` | OPERATOR |
| POST | `/api/inventory/entry`, `/api/inventory/exit` | OPERATOR |
| POST | `/api/sales` | WORKER |
| GET | `/api/sales`, `/api/sales/:id`, `/api/sales/:id/receipt` | WORKER |
| POST | `/api/sales/:id/refund` | OPERATOR |
| GET | `/api/reports/dashboard`, `/api/reports/products` | OPERATOR |
| GET | `/api/cash/today` | OPERATOR |
| GET/PATCH | `/api/exchange-rate` | auth / ADMIN |
| GET/POST/PATCH | `/api/employees` | ADMIN |

## Rol ruxsatlari

`CUSTOMER < WORKER < OPERATOR < MANAGER < ADMIN` (`auth/rbac.ts`).
`requireRole(min)` — route guard. `canSeeInternal` (OPERATOR+) tannarx/min narx/ombor;
`canSeeProfit` (MANAGER+) foyda/COGS.

## Environment variables

`backend/.env` (`.env.example` dan nusxa oling):

| O'zgaruvchi | Tavsif |
|---|---|
| `DATABASE_URL` | PostgreSQL ulanish satri |
| `PORT` | API porti (default 8080) |
| `CORS_ORIGIN` | frontend origin(lar), vergul bilan |
| `JWT_SECRET` | uzun tasodifiy satr |
| `AUTH_DEV_MODE` | `true` + `BOT_TOKEN` bo'sh → `/auth/telegram` `{devUser}` qabul qiladi. **Prod'da `false`.** |
| `TELEGRAM_AUTH_TTL` | initData eskirish muddati, sekund (default 86400) |
| `BOT_TOKEN` | BotFather tokeni (hozircha bo'sh) |
| `MINI_APP_URL` | Mini App'ning public HTTPS URL'i |
| `ADMIN_SEED_PHONE` | seed qiladigan admin xodim telefoni |
| `CBU_RATE_URL` | kurs API (default cbu.uz) |
| `DEFAULT_USD_UZS` | internet ham, saqlangan kurs ham yo'q bo'lsa zaxira qiymat |

`frontend/.env`:

| O'zgaruvchi | Tavsif |
|---|---|
| `VITE_API_URL` | backend origin (prod). Dev'da bo'sh qoldiring — Vite proxy `/api` ni uzatadi |
| `VITE_API_PROXY` | dev proxy target (default `http://localhost:8080`) |

## USD kursi konfiguratsiyasi

`GET /api/exchange-rate` — joriy kurs (CBU'dan kuniga bir marta yangilanadi).
`GET /api/exchange-rate?force=1` — darhol yangilash. `PATCH /api/exchange-rate
{ "rate": 12850 }` (ADMIN) — qo'lda o'rnatish. Kirimda USD tanlansa, o'sha vaqtdagi
kurs partiyaga snapshot qilinadi — keyin kurs o'zgarsa eski tannarx o'zgarmaydi.

## Printer konfiguratsiyasi

Chek `@media print` bilan brauzer orqali chiqadi. Termal printer uchun brauzer
sozlamalarida qog'oz o'lchamini 58 mm yoki 80 mm qiling; sahifada `receipt-58` /
`receipt-80` klasslari kenglikni beradi. Tarix → "Chek" → "Chop etish" bilan eski
savdoni qayta chiqarish mumkin. PDF kerak bo'lsa brauzerning "Save as PDF" opsiyasi.

## Local ishga tushirish

```bash
# 1. Database
docker compose up -d db

# 2. Backend
cd backend
cp .env.example .env            # DATABASE_URL local compose'ga to'g'ri keladi
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev                     # http://localhost:8080  (AUTH_DEV_MODE=true)

# 3. Frontend (boshqa terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                     # http://localhost:5173
```

Brauzerda `http://localhost:5173` oching. Telegramdan tashqarida yuqorida **DEV**
paneli chiqadi — "Kim sifatida" ro'yxatidan seed qilingan rolni tanlang
(`+998901234567` = ADMIN, `...1111111` = MANAGER, `...2222222` = OPERATOR,
`...3333333` = WORKER, boshqa har qanday = CUSTOMER).

## Production deploy (PaaS)

### Render — Node runtime (eng oddiy)

Yangi **Web Service** yarating, bu repo'ni ulang. **Build/Start Command'larni
o'zgartirish shart emas** — default qiymatlar ishlaydi:

| Sozlama | Qiymat |
|---|---|
| Runtime | Node |
| Build Command | *(default — `yarn` / `npm install`)* |
| Start Command | *(default — `npm run start`)* |
| Health Check Path | `/health` |

`npm install` → `postinstall` skripti `prisma generate` + `tsc` ni ishga tushiradi
va `dist/server.js` ni yaratadi. `npm run start` = `prisma migrate deploy` +
`node dist/server.js` (migratsiya idempotent).

DB: `DATABASE_URL` ga **direct (pooler'siz)** Neon URL'ini qo'ying — Neon hostidan
`-pooler` qismini olib tashlang.

Seed (bir marta, ag'ar kerak bo'lsa): Render Shell'da `npm run seed`.

### Render — Docker (alternativa)

`render.yaml` blueprint tayyor (Postgres + Docker API). Yoki Web Service'da
Runtime = Docker, Dockerfile Path = `Dockerfile`. Boshqa hech narsa kerak emas —
Dockerfile build + migrate + start ni o'zi qiladi.

### Railway

1. Repo'ni ulang. Railway `railway.json` ni topadi (`Dockerfile`).
2. **PostgreSQL** plugin qo'shing — `DATABASE_URL` avtomatik ulanadi.
3. Variables (pastdagi jadval).
4. Deploy — `prisma migrate deploy` boot'da avtomatik. Seed: `railway run npm run seed`.

### Environment Variables (Render / Railway)

| Kalit | Qiymat | Majburiy |
|---|---|---|
| `DATABASE_URL` | Postgres ulanish satri (Render: Internal Database URL) | ✅ |
| `JWT_SECRET` | uzun tasodifiy satr (`openssl rand -hex 32`) | ✅ |
| `NODE_ENV` | `production` | ✅ |
| `AUTH_DEV_MODE` | `false` | ✅ |
| `CORS_ORIGIN` | frontend domeni, masalan `https://les-house.onrender.com` | ✅ |
| `PORT` | Render/Railway o'zi beradi — **qo'ymang** (kod `process.env.PORT` ni oladi) | — |
| `MINI_APP_URL` | frontend domeni (bot tugmasi uchun) | bot bo'lsa |
| `BOT_TOKEN` | BotFather tokeni | bot bo'lsa |
| `ADMIN_SEED_PHONE` | seed admin telefoni, masalan `+998901234567` | seed uchun |
| `TELEGRAM_AUTH_TTL` | `86400` | — |
| `CBU_RATE_URL` | `https://cbu.uz/uz/arkhiv-kursov-valyut/json/` | — |
| `DEFAULT_USD_UZS` | `12800` | — |

### Frontend (alohida repo: Les-House)

Static Site: Build `npm install && npm run build`, Publish `dist`, SPA rewrite
`/* → /index.html`, `VITE_API_URL=https://<backend-domain>`.

### Telegram bot (BotFather) — bot yaratgandan keyin

1. [@BotFather](https://t.me/BotFather) → `/newbot` → nom va username → **token**.
2. Token'ni backend `BOT_TOKEN` ga qo'ying, `AUTH_DEV_MODE=false` qiling, qayta deploy.
3. BotFather → `/newapp` (yoki Bot Settings → **Configure Mini App**) → Mini App
   URL = `MINI_APP_URL` (frontend HTTPS domeni).
4. BotFather → Bot Settings → **Menu Button** → "📱 Mini App" → o'sha URL. Xohlasangiz
   **Main Mini App** sifatida ham o'rnating.
5. Bot API bilan bitta process'da ishlaydi (`startBot()` server boot'da). Alohida
   kerak bo'lsa: `npm --prefix backend run bot`.
6. `/start` → salom + "📱 Mini Appni ochish" tugmasi. Mini App ochilганда frontend
   `Telegram.WebApp.initData` ni `/api/auth/telegram` ga yuboradi, backend HMAC
   tekshiradi, account yaratiladi/ochiladi, telefon so'raladi (`requestContact`),
   rol aniqlanadi.

## Test qilish

```bash
cd backend
npm run typecheck
npm run lint
npm test                 # initData HMAC, money/rounding, RBAC ko'rinish — DB kerak emas

# POS savdo integratsiya testi (disposable DB kerak):
createdb taxta_test
DATABASE_URL="postgres://.../taxta_test" npx prisma migrate deploy
TEST_DATABASE_URL="postgres://.../taxta_test" npm test
```

Frontend:

```bash
cd frontend
npm run build            # o'tishi shart
```

Qo'lda uchidan-uchiga: backend + `AUTH_DEV_MODE=true` bilan ishга tushiring →
DEV panelдан ADMIN tanlang → Dashboard'ga tushasiz → to'liq POS savdo (aralash
naqd+qarz) → chek → Ombor'da qoldiq kamaygani, Tarix'da savdo ko'ringanini
tekshiring → Mijoz kartochkasida qarz to'lovi qiling → CUSTOMER'ga o'ting →
katalogда tannarx/min narx yo'qligini va POS/admin menyusi yo'qligini tasdiqlang.

## Loyiha tuzilishi

```
frontend/   Vite + React 18 (JSX). Telegram WebApp SDK, rolega qarab shell,
            barcha sahifalar API'ga ulangan.
backend/    Fastify + Prisma + PostgreSQL (TS).
            src/auth      — initData HMAC, JWT plugin, RBAC
            src/services  — sale (transaction), inventory, auth
            src/routes    — REST endpointlar
            src/lib       — money (decimal), serialize (rol ko'rinishi), CBU kurs
            prisma        — schema + seed
docker-compose.yml   local Postgres
railway.json / render.yaml   PaaS deploy
```
