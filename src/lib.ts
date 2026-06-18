// src/lib.ts
//
// Shared infrastructure: the Redis connection, LiveKit server-side clients and
// token helper, a few env-driven constants, the consent notice (single source of
// truth), and the container->host path mapper the stitch worker needs.
import Redis from "ioredis";
import path from "path";
import { AccessToken, RoomServiceClient, EgressClient } from "livekit-server-sdk";

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------
// BullMQ REQUIRES `maxRetriesPerRequest: null` on the ioredis connection it uses
// (otherwise the Worker throws on startup). We share one client for both the
// matchmaking queue commands and BullMQ; BullMQ internally `.duplicate()`s it for
// its blocking reads, so this is safe at our scale.
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const QUEUE_KEY = "mm:queue"; // Redis list of JSON {socketId,userId,handle}

// ---------------------------------------------------------------------------
// LiveKit
// ---------------------------------------------------------------------------
// Clients (browser) use the ws URL; server-side REST clients (Egress/RoomService,
// which speak Twirp-over-HTTP) need the HTTP URL. Convert ws->http / wss->https so
// a single LIVEKIT_URL env var works for both.
export const LIVEKIT_WS_URL = process.env.LIVEKIT_URL ?? "ws://localhost:7880";
export const LIVEKIT_HTTP_URL =
  process.env.LIVEKIT_HTTP_URL ?? LIVEKIT_WS_URL.replace(/^ws/, "http");

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? "devsecret_change_me";

/**
 * Mint a LiveKit join token for one participant.
 * identity = the user id; LiveKit uses it to label tracks in webhooks, which is how
 * the stitch worker later tells the two participants' tracks apart.
 */
export async function createJoinToken(identity: string, room: string) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    // Generous TTL: this only needs to be valid at JOIN time, but a short TTL can
    // cause reconnection problems on longer calls. 2h is plenty for a learning app.
    ttl: "2h",
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return await at.toJwt(); // async in v2 of the SDK
}

// Server-side clients, created once and reused.
export const roomService = new RoomServiceClient(
  LIVEKIT_HTTP_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);
export const egressClient = new EgressClient(
  LIVEKIT_HTTP_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

/** Force a room to end (kicks both participants -> egress ends -> room_finished). */
export async function endRoom(roomName: string) {
  try {
    await roomService.deleteRoom(roomName);
  } catch (err) {
    // Room may already be gone (both peers left and it timed out). Not fatal.
    console.warn("endRoom: deleteRoom failed (probably already closed):", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Consent notice — single source of truth, served to the client and checked here.
// Bump NOTICE_VERSION whenever you change the wording so old acceptances don't count.
// ---------------------------------------------------------------------------
export const NOTICE_VERSION = process.env.NOTICE_VERSION ?? "v1";
export const NOTICE_TEXT =
  "This is a closed, recorded video-chat for a known group. Your camera and " +
  "microphone will be recorded for the entire session, and an administrator can " +
  "review the recording afterwards. By continuing you confirm you are an invited " +
  "participant and you consent to being recorded.";

// ---------------------------------------------------------------------------
// Recording paths
// ---------------------------------------------------------------------------
// Egress runs in Docker and writes files under EGRESS_OUTPUT_DIR *inside the
// container* (mounted from REC_DIR on the host). The webhook stores the path the
// container reports; the host-side stitch worker must translate that prefix back to
// the host path before FFmpeg can read it. See toHostPath().
export const EGRESS_OUTPUT_DIR = process.env.EGRESS_OUTPUT_DIR ?? "/out"; // container side
export const REC_DIR = path.resolve(process.env.REC_DIR ?? "./recordings"); // host side
export const OUT_DIR = path.resolve(process.env.OUT_DIR ?? "./stitched"); // stitched MP4s (host only)

/**
 * Translate a path reported by Egress (a Linux/container path under
 * EGRESS_OUTPUT_DIR) into a path the host worker can actually open (under REC_DIR).
 * Example: "/out/<room>/alice-TR_xxx.webm" -> "<repo>/recordings/<room>/alice-TR_xxx.webm".
 * If the path doesn't start with the container prefix (e.g. you ran Egress on the
 * host directly), it's returned unchanged.
 */
export function toHostPath(egressPath: string): string {
  // Use posix semantics for the container side — it's always a Linux path.
  const prefix = EGRESS_OUTPUT_DIR.replace(/\/+$/, "");
  if (egressPath.startsWith(prefix)) {
    const rel = egressPath.slice(prefix.length).replace(/^\/+/, "");
    return path.join(REC_DIR, ...rel.split("/"));
  }
  return egressPath;
}
