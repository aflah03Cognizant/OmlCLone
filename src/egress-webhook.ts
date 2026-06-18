// src/egress-webhook.ts
//
// Receives LiveKit webhooks and drives the recording pipeline:
//   track_published -> start a per-track Egress to a local file
//   egress_ended    -> persist the file path + precise start timestamp
//   room_finished   -> mark session ENDED, and (once all 4 tracks are down) enqueue the stitch
//
// VERSION NOTE (livekit-server-sdk v2): verified against the published types ---
//   * startTrackEgress(room, output: DirectFileOutput | string, trackId)
//     For local disk pass `new DirectFileOutput({ filepath })` (NOT `{ file: {...} }`,
//     which was the old shape) and leave the cloud `output` oneof unset.
//   * TrackType enum is AUDIO = 0, VIDEO = 1 — so `track.type === 1` is VIDEO. We use
//     the imported enum instead of magic numbers.
// If you upgrade the SDK, re-check these two things first.
import express from "express";
import { Server } from "socket.io";
import { WebhookReceiver, DirectFileOutput, TrackType } from "livekit-server-sdk";
import { PrismaClient, TrackKind } from "@prisma/client";
import { Queue } from "bullmq";
import { redis, egressClient } from "./lib";

const prisma = new PrismaClient();
const receiver = new WebhookReceiver(
  process.env.LIVEKIT_API_KEY ?? "devkey",
  process.env.LIVEKIT_API_SECRET ?? "devsecret_change_me"
);
export const stitchQueue = new Queue("stitch", { connection: redis });

/**
 * Each room produces exactly 4 track egresses (2 participants x audio+video). Once
 * all 4 have a file path AND a start timestamp, AND the room has ended, we stitch.
 * This runs from BOTH egress_ended and room_finished because the last egress_ended
 * can arrive *after* room_finished — if we only checked in room_finished we'd lose
 * the stitch. The guarded updateMany makes the enqueue exactly-once under races.
 */
async function maybeEnqueueStitch(sessionId: string) {
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    include: { egressTracks: true },
  });
  if (!session) return;

  const tracks = session.egressTracks;
  const allDone =
    session.status === "ENDED" &&
    tracks.length >= 4 &&
    tracks.every((t) => t.filePath && t.startedAt != null);
  if (!allDone) return;

  // Atomic claim: flip ENDED -> STITCHING. Only the call that actually changes a row
  // (count === 1) gets to enqueue, so concurrent egress_ended/room_finished can't
  // double-queue the same session.
  const claim = await prisma.chatSession.updateMany({
    where: { id: sessionId, status: "ENDED" },
    data: { status: "STITCHING" },
  });
  if (claim.count === 1) {
    await stitchQueue.add("stitch", { sessionId });
  }
}

export function mountWebhooks(app: express.Express, _io: Server) {
  // LiveKit POSTs the raw JSON body with an Authorization header we must validate.
  // `type: () => true` makes express capture the raw bytes regardless of the exact
  // content-type header (LiveKit uses "application/webhook+json").
  app.post("/livekit/webhook", express.raw({ type: () => true }), async (req, res) => {
    let event;
    try {
      // receive() verifies the signature against our API key/secret. Pass the raw
      // body string exactly as sent (express.raw gives us a Buffer).
      event = await receiver.receive(req.body.toString("utf8"), req.headers.authorization);
    } catch (err) {
      console.error("webhook: signature/parse failed:", (err as Error).message);
      return res.sendStatus(401);
    }

    try {
      switch (event.event) {
        // A participant published a track -> start a Track Egress for just that track.
        case "track_published": {
          const { room, participant, track } = event;
          if (!room?.name || !participant?.identity || !track?.sid) break;

          const kind = track.type === TrackType.AUDIO ? TrackKind.AUDIO : TrackKind.VIDEO;
          const ext = kind === TrackKind.AUDIO ? "ogg" : "webm";

          const session = await prisma.chatSession.findUnique({
            where: { roomName: room.name },
          });
          if (!session) break;

          // Idempotency: LiveKit retries webhooks. Each participant has exactly one
          // audio + one video track here, so skip if we already started this one.
          const existing = await prisma.egressTrack.findFirst({
            where: { sessionId: session.id, participant: participant.identity, kind },
          });
          if (existing) break;

          // Relative to egress.yaml `local_output_directory` (the container's
          // EGRESS_OUTPUT_DIR). The authoritative on-disk path comes back on
          // egress_ended; this is just where we ask it to write.
          const filepath = `${room.name}/${participant.identity}-${track.sid}.${ext}`;

          const info = await egressClient.startTrackEgress(
            room.name,
            new DirectFileOutput({ filepath }), // local file (no cloud output set)
            track.sid
          );

          if (info.egressId) {
            await prisma.egressTrack.create({
              data: {
                sessionId: session.id,
                egressId: info.egressId,
                participant: participant.identity,
                kind,
              },
            });
          }
          break;
        }

        // Egress finished -> persist the real file path + the precise start time.
        case "egress_ended": {
          const eg = event.egressInfo;
          if (!eg?.egressId) break;
          // Track egress writes one file; its real path is in fileResults[0].filename.
          const fileResult = eg.fileResults?.[0];
          const updated = await prisma.egressTrack.updateMany({
            where: { egressId: eg.egressId },
            data: {
              filePath: fileResult?.filename ?? null,
              // startedAt is a bigint in NANOSECONDS on EgressInfo -> store ms.
              startedAt: eg.startedAt ? BigInt(eg.startedAt) / 1_000_000n : null,
              endedAt: new Date(),
            },
          });
          // Find the owning session so we can re-check the stitch condition (the
          // last egress_ended can land after room_finished).
          if (updated.count > 0) {
            const t = await prisma.egressTrack.findUnique({ where: { egressId: eg.egressId } });
            if (t) await maybeEnqueueStitch(t.sessionId);
          }
          break;
        }

        // Room over -> mark ENDED, then try to enqueue the stitch.
        case "room_finished": {
          const name = event.room?.name;
          if (!name) break;
          const session = await prisma.chatSession.findUnique({ where: { roomName: name } });
          if (!session) break;
          // Only move ACTIVE -> ENDED (don't clobber STITCHING/STITCHED on a re-delivery).
          await prisma.chatSession.updateMany({
            where: { id: session.id, status: "ACTIVE" },
            data: { status: "ENDED", endedAt: new Date() },
          });
          await maybeEnqueueStitch(session.id);
          break;
        }
      }
    } catch (err) {
      // Don't 500 — LiveKit will retry, and our handlers are written to be
      // idempotent, but for a learning app a logged error is enough.
      console.error(`webhook handler error (${event.event}):`, err);
    }

    res.sendStatus(200);
  });
}
