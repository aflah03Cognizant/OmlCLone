// src/admin.ts
//
// Admin review surface, all under /admin and gated by HTTP Basic auth:
//   GET /admin/dashboard      server-rendered HTML: session list, active-call count, players
//   GET /admin/sessions       the same data as JSON (handy for debugging)
//   GET /admin/media/:id.mp4  streams a stitched recording (with HTTP range -> seeking)
//
// Basic auth is hand-rolled (one tiny middleware) to avoid another dependency — fine
// for a single admin in a closed setup. Set ADMIN_USER / ADMIN_PASSWORD in .env.
import express from "express";
import { createReadStream } from "fs";
import fs from "fs/promises";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Constant-time string compare so we don't leak length/contents via timing. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const expectedUser = process.env.ADMIN_USER ?? "admin";
  const expectedPass = process.env.ADMIN_PASSWORD ?? "changeme";

  const header = req.headers.authorization ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user && pass && safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="admin", charset="UTF-8"');
  res.status(401).send("Authentication required.");
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "#16a34a",
  ENDED: "#6b7280",
  STITCHING: "#d97706",
  STITCHED: "#2563eb",
  FAILED: "#dc2626",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

export function mountAdmin(app: express.Express) {
  app.use("/admin", basicAuth);

  // Raw JSON (kept from the original scaffold) — useful for debugging.
  app.get("/admin/sessions", async (_req, res) => {
    const sessions = await prisma.chatSession.findMany({
      orderBy: { startedAt: "desc" },
      include: { userA: true, userB: true },
      take: 100,
    });
    // BigInt isn't JSON-serializable; this endpoint doesn't include egressTracks so
    // we're fine, but guard anyway.
    res.json(JSON.parse(JSON.stringify(sessions, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  });

  // Stream a stitched MP4 with HTTP range support so the browser <video> can seek.
  // (No ".mp4" in the path — the Content-Type header is what the <video> needs, and
  // it sidesteps Express 4's quirky handling of dots in route params.)
  app.get("/admin/media/:id", async (req, res) => {
    const session = await prisma.chatSession.findUnique({ where: { id: req.params.id } });
    if (!session?.stitchedPath) return res.status(404).send("no recording");

    let stat;
    try {
      stat = await fs.stat(session.stitchedPath);
    } catch {
      return res.status(404).send("file missing on disk");
    }

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size) {
        return res.status(416).set("Content-Range", `bytes */${stat.size}`).end();
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
      });
      createReadStream(session.stitchedPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      });
      createReadStream(session.stitchedPath).pipe(res);
    }
  });

  // The dashboard itself.
  app.get("/admin/dashboard", async (_req, res) => {
    const [sessions, activeCount] = await Promise.all([
      prisma.chatSession.findMany({
        orderBy: { startedAt: "desc" },
        include: { userA: true, userB: true },
        take: 100,
      }),
      prisma.chatSession.count({ where: { status: "ACTIVE" } }),
    ]);

    const rows = sessions
      .map((s) => {
        const color = STATUS_COLORS[s.status] ?? "#6b7280";
        const started = s.startedAt.toISOString().replace("T", " ").slice(0, 19);
        const player =
          s.status === "STITCHED"
            ? `<video controls preload="metadata" src="/admin/media/${s.id}"></video>`
            : `<span class="muted">${s.status === "FAILED" ? "stitch failed" : "no recording yet"}</span>`;
        return `
          <tr>
            <td>
              <div class="who">${escapeHtml(s.userA.handle)} &harr; ${escapeHtml(s.userB.handle)}</div>
              <div class="muted mono">${s.id}</div>
            </td>
            <td><span class="badge" style="background:${color}">${s.status}</span></td>
            <td class="mono">${started}</td>
            <td>${player}</td>
          </tr>`;
      })
      .join("");

    res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Admin · Recorded sessions</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; background:#0b0f17; color:#e5e7eb; }
  header { padding: 20px 24px; border-bottom: 1px solid #1f2937; display:flex; align-items:baseline; gap:16px; }
  h1 { font-size: 18px; margin: 0; }
  .active { font-size: 14px; color:#9ca3af; }
  .active b { color:#34d399; font-size: 16px; }
  main { padding: 16px 24px 48px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 12px 10px; border-bottom: 1px solid #1f2937; vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color:#9ca3af; }
  .who { font-weight: 600; }
  .muted { color:#6b7280; font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .badge { color:#fff; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight:600; }
  video { width: 360px; max-width: 100%; border-radius: 8px; background:#000; }
  .empty { color:#6b7280; padding: 40px 0; }
</style>
</head>
<body>
  <header>
    <h1>Recorded sessions</h1>
    <span class="active">Active calls right now: <b>${activeCount}</b></span>
    <span class="active">· ${sessions.length} shown (newest first)</span>
  </header>
  <main>
    ${
      sessions.length
        ? `<table>
        <thead><tr><th>Participants</th><th>Status</th><th>Started (UTC)</th><th>Recording</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`
        : `<div class="empty">No sessions yet. Pair two users and finish a call to see recordings here.</div>`
    }
  </main>
  <!-- Static page; refresh to update the active-call count and statuses. -->
</body>
</html>`);
  });
}
