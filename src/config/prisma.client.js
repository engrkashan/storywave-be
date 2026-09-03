import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

const basePrisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

function isTransientConflictError(error) {
  if (!error) return false;
  const msg = String(error.message || "");
  const code = String(error.code || "");
  return (
    code === "P2034" || // Write conflict or deadlock
    code === "P2028" || // Transaction API error
    msg.includes("write conflict") ||
    msg.includes("deadlock") ||
    msg.includes("WriteConflict") ||
    msg.includes("Transaction failed due to a write conflict") ||
    msg.includes("TransientTransactionError")
  );
}

const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const MAX_RETRIES = 5;
        let attempt = 0;
        while (true) {
          try {
            return await query(args);
          } catch (error) {
            attempt++;
            if (isTransientConflictError(error) && attempt <= MAX_RETRIES) {
              const delay = Math.min(50 * Math.pow(2, attempt) + Math.random() * 50, 1000);
              await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
            throw error;
          }
        }
      },
    },
  },
});

process.on("SIGINT", async () => {
  await basePrisma.$disconnect();
  process.exit(0);
});

export default prisma;

