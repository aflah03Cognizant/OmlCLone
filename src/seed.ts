// src/seed.ts
// Minimal seed: a few known users for the closed group. Run with `npm run seed`.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Three so you can test pairing (alice+bob match, carol waits in the queue).
  for (const handle of ["alice", "bob", "carol"]) {
    await prisma.user.upsert({
      where: { handle },
      update: {},
      create: { handle, email: `${handle}@example.com` },
    });
  }
  console.log("seeded: alice, bob, carol");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
