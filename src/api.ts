// src/api.ts
//
// The small REST surface the React app calls (everything else is over Socket.IO):
//   POST /api/login          { handle }                 -> { id, handle }
//   GET  /api/consent-notice                            -> { version, text }
//   POST /api/consent        { userId, noticeVersion }  -> { ok: true }
//
// CORS + JSON parsing are scoped to /api so they don't interfere with the LiveKit
// webhook (which needs the raw body) or the admin pages.
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { NOTICE_VERSION, NOTICE_TEXT } from "./lib";

const prisma = new PrismaClient();

export function mountApi(app: express.Express) {
  const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.use("/api", cors({ origin: WEB_ORIGIN }));
  app.use("/api", express.json());

  // "Login" for a closed group is just: give me your handle, I'll upsert you and
  // hand back your id. No passwords — everyone here is known and invited.
  app.post("/api/login", async (req, res) => {
    const handle = String(req.body?.handle ?? "").trim();
    if (!handle) return res.status(400).json({ error: "handle required" });
    const user = await prisma.user.upsert({
      where: { handle },
      update: { lastSeenAt: new Date() },
      create: { handle },
    });
    res.json({ id: user.id, handle: user.handle });
  });

  // The notice text + version are owned by the server so the client always shows
  // (and accepts) exactly what we gate on.
  app.get("/api/consent-notice", (_req, res) => {
    res.json({ version: NOTICE_VERSION, text: NOTICE_TEXT });
  });

  // Records the pre-queue acceptance (a session-less ConsentRecord). The matchmaker
  // checks for this before it will queue the user; the durable per-session records
  // are written when the user is actually matched.
  app.post("/api/consent", async (req, res) => {
    const userId = String(req.body?.userId ?? "");
    const noticeVersion = String(req.body?.noticeVersion ?? "");
    if (!userId || !noticeVersion) {
      return res.status(400).json({ error: "userId and noticeVersion required" });
    }
    if (noticeVersion !== NOTICE_VERSION) {
      return res.status(409).json({ error: "stale notice version", current: NOTICE_VERSION });
    }
    // Make sure the user exists (avoids a foreign-key error if the client is stale).
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "unknown user" });

    await prisma.consentRecord.create({
      data: { userId, sessionId: null, noticeVersion },
    });
    res.json({ ok: true });
  });
}
