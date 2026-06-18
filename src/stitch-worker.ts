// src/stitch-worker.ts
//
// BullMQ worker (run as its own process: `npm run worker`). For each ended session
// it computes the A/V offset between the two participants, then runs ONE FFmpeg
// command that side-by-side stitches the two videos and mixes the two audio tracks
// into a single MP4.
//
// Concurrency is capped at 2 — the real guardrail so a burst of session-ends can
// never fork-bomb FFmpeg.
import { Worker } from "bullmq";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { PrismaClient, TrackKind } from "@prisma/client";
import { redis, OUT_DIR, toHostPath } from "./lib";

const run = promisify(execFile);
const prisma = new PrismaClient();

new Worker(
  "stitch",
  async (job) => {
    const { sessionId } = job.data as { sessionId: string };
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: { egressTracks: true, userA: true, userB: true },
    });
    if (!session) throw new Error(`stitch: session ${sessionId} not found`);

    // Pull out the 4 tracks by participant + kind. If any is missing (e.g. someone
    // never published a camera) we fail loudly rather than crash with `undefined`.
    const t = session.egressTracks;
    const pick = (userId: string, kind: TrackKind) =>
      t.find((x) => x.participant === userId && x.kind === kind);
    const vA = pick(session.userAId, TrackKind.VIDEO);
    const aA = pick(session.userAId, TrackKind.AUDIO);
    const vB = pick(session.userBId, TrackKind.VIDEO);
    const aB = pick(session.userBId, TrackKind.AUDIO);
    if (!vA || !aA || !vB || !aB) {
      throw new Error(
        `stitch: session ${sessionId} is missing tracks ` +
          `(vA=${!!vA} aA=${!!aA} vB=${!!vB} aB=${!!aB}) — cannot stitch`
      );
    }

    // Egress reports container paths; translate them to host paths we can read.
    const fvA = toHostPath(vA.filePath!);
    const faA = toHostPath(aA.filePath!);
    const fvB = toHostPath(vB.filePath!);
    const faB = toHostPath(aB.filePath!);

    // A/V SYNC (approximate — the two media clocks are independent, see README):
    // align on whoever started first; delay the later starter by the difference so
    // both timelines share a t=0. We anchor on the *video* egress start and apply the
    // same offset to that participant's audio.
    const startA = Number(vA.startedAt);
    const startB = Number(vB.startedAt);
    const offset = Math.abs(startB - startA) / 1000; // seconds
    const bIsLater = startB > startA;
    // `-itsoffset` shifts an input's timestamps forward, i.e. delays it. Apply it to
    // the later starter's two inputs only.
    const off = (later: boolean) => (later ? ["-itsoffset", offset.toFixed(3)] : []);

    await fs.mkdir(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${session.id}.mp4`);

    // Scale both cameras to a common height (480) BEFORE hstack — otherwise FFmpeg
    // errors if the two webcams negotiated different resolutions. `-2` keeps each
    // aspect ratio while forcing an even width (required by libx264).
    const filter =
      "[0:v]scale=-2:480[v0];[1:v]scale=-2:480[v1];[v0][v1]hstack=inputs=2[v];" +
      "[2:a][3:a]amix=inputs=2:duration=longest:dropout_transition=2[a]";

    const args = [
      ...off(!bIsLater), "-i", fvA,
      ...off(bIsLater),  "-i", fvB,
      ...off(!bIsLater), "-i", faA,
      ...off(bIsLater),  "-i", faB,
      "-filter_complex", filter,
      "-map", "[v]", "-map", "[a]",
      // software encode — fine for a few stitches/day. swap to h264_nvenc on a GPU box.
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-c:a", "aac",
      "-movflags", "+faststart", // lets the admin <video> start before the full download
      "-y", out,
    ];

    await run("ffmpeg", args, { maxBuffer: 1 << 26 });

    await prisma.chatSession.update({
      where: { id: session.id },
      data: { status: "STITCHED", stitchedPath: out, stitchedAt: new Date() },
    });
    console.log(`stitch: session ${session.id} -> ${out} (offset ${offset.toFixed(3)}s)`);
    return out;
  },
  {
    connection: redis,
    concurrency: 2, // <-- the real guardrail: never let a burst fork-bomb ffmpeg
  }
)
  .on("failed", async (job, err) => {
    console.error("stitch failed", job?.id, err);
    if (job?.data?.sessionId) {
      await prisma.chatSession
        .update({ where: { id: job.data.sessionId }, data: { status: "FAILED" } })
        .catch(() => {});
    }
  })
  .on("ready", () => console.log("stitch worker ready (concurrency 2)"));
