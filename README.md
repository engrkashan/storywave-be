# Node.js + Prisma Starter

This project is initialized with Node.js and Prisma ORM.

## Getting Started

1. Define your data models in `prisma/schema.prisma` (set provider to `mongodb`).
2. Set your MongoDB connection string in `.env` as `DATABASE_URL` (e.g., `mongodb+srv://USER:PASSWORD@HOST/dbname`).
3. Generate Prisma client:
   ```sh
   npx prisma generate
   ```
4. Use Prisma Client in your Node.js code:
   ```js
   const {{ PrismaClient }} = require('@prisma/client');
   const prisma = new PrismaClient();
   ```

## Scripts
- `npm install` — install dependencies
- `npx prisma studio` — open Prisma Studio (visual DB browser)

---

For more info, see the [Prisma MongoDB docs](https://www.prisma.io/docs/orm/prisma-schema/data-model#mongodb).
