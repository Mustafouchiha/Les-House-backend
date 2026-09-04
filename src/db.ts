import { PrismaClient, Prisma } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["warn", "error"] : ["warn", "error"],
});

export { Prisma };

// A Prisma transaction client type, for services that take an interactive tx.
export type Tx = Prisma.TransactionClient;
