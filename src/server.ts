// src/server.ts
//
// Entry point for the signaling + webhook + admin server (run with `npm run dev`).
// The BullMQ stitch worker runs separately (`npm run worker`).
//
// Middleware ordering matters: the LiveKit webhook needs the RAW request body, so we
// never install a global JSON body parser — JSON/CORS are scoped to /api inside
// mountApi(), and the webhook installs its own express.raw().
import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs/promises";
import { PrismaClient } from "@prisma/client";
import { attachMatchmaker } from "./matchmaker";
import { mountWebhooks } from "./egress-webhook";
import { mountApi } from "./api";
import { mountAdmin } from "./admin";
import { toHostPath } from "./lib";

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

// Socket.IO has its own CORS (separate from Express). "*" is fine for a local,
// closed-group learning app; lock it to WEB_ORIGIN if you ever expose it.
const io = new Server(server, { cors: { origin: "*" } });

attachMatchmaker(io); // Socket.IO: queue, match, leave/next, teardown
mountApi(app); // REST: /api/login, /api/consent-notice, /api/consent
mountWebhooks(app, io); // LiveKit webhooks -> egress pipeline
mountAdmin(app); // /admin/* behind basic auth

// --- hourly cleanup: hard-delete anything older than 24h, files + rows ---
// PII and recordings shouldn't outlive their usefulness in a learning setup.
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - CLEANUP_AGE_MS);

    const old = await prisma.chatSession.findMany({
      where: { startedAt: { lt: cutoff } },
      include: { egressTracks: true },
    });
    for (const s of old) {
      // egress files are stored as container paths -> map to host before deleting.
      for (const t of s.egressTracks) {
        if (t.filePath) await fs.rm(toHostPath(t.filePath), { force: true });
      }
      if (s.stitchedPath) await fs.rm(s.stitchedPath, { force: true });
      // cascades egressTracks / messages / per-session consents
      await prisma.chatSession.delete({ where: { id: s.id } });
    }

    // Pre-queue (session-less) consent rows don't cascade with any session, so prune
    // the stale ones here too.
    const prunedConsents = await prisma.consentRecord.deleteMany({
      where: { sessionId: null, acceptedAt: { lt: cutoff } },
    });

    if (old.length || prunedConsents.count) {
      console.log(`cleanup: removed ${old.length} sessions, ${prunedConsents.count} stale consents`);
    }
  } catch (err) {
    console.error("cleanup failed:", err);
  }
}, 60 * 60 * 1000);

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => console.log(`signaling + webhooks + admin on :${PORT}`));
