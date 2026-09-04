import type { Role } from "@prisma/client";

// Server copy of the role → nav map (spec §26). The frontend has its own copy for
// rendering; this one is the source of truth for /me.
export const NAV_BY_ROLE: Record<Role, string[]> = {
  CUSTOMER: ["mahsulotlar", "savat", "kalkulyator", "hisobim", "xaridlar"],
  WORKER: ["savdo", "mijozlar", "tarix"],
  OPERATOR: ["dashboard", "savdo", "ombor", "kirim", "mahsulotlar", "mijozlar", "qarzlar", "kassa", "tarix"],
  MANAGER: [
    "dashboard",
    "savdo",
    "ombor",
    "mahsulotlar",
    "kirim",
    "mijozlar",
    "qarzlar",
    "hisobotlar",
    "kassa",
    "tarix",
  ],
  ADMIN: [
    "dashboard",
    "savdo",
    "ombor",
    "mahsulotlar",
    "kirim",
    "mijozlar",
    "qarzlar",
    "kassa",
    "hisobotlar",
    "kalkulyator",
    "employees",
    "tarix",
  ],
};
