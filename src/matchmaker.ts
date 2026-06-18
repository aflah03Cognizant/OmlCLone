// src/matchmaker.ts
//
// Socket.IO signaling + the random matchmaker. Users join a Redis queue; a 1s tick
// atomically pops pairs (Lua, so no double-matching), creates a ChatSession + a
// LiveKit room, mints a token for each, and emits `matched`.
import { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { redis, QUEUE_KEY, createJoinToken, endRoom, NOTICE_VERSION } from "./lib";

const prisma = new PrismaClient();

// Atomic "pop two distinct users" — Redis runs Lua single-threaded, so no two
// matcher ticks (or instances) can ever grab the same person. Returns 2 entries
// or nil. If only one is present, it's pushed back so it isn't lost.
const POP_PAIR = `
  local a = redis.call('LPOP', KEYS[1])
  if not a then return nil end
  local b = redis.call('LPOP', KEYS[1])
  if not b then
    redis.call('LPUSH', KEYS[1], a)
    return nil
  end
  return {a, b}
`;

type QueueEntry = { userId: string; handle: string; socketId: string };

/** Has this user accepted the current notice version (pre-queue, session-less row)? */
async function hasConsented(userId: string): Promise<boolean> {
  const row = await prisma.consentRecord.findFirst({
    where: { userId, sessionId: null, noticeVersion: NOTICE_VERSION },
  });
  return !!row;
}

export function attachMatchmaker(io: Server) {
  io.on("connection", (socket: Socket) => {
    socket.on("join_queue", async (payload: { userId: string; handle: string }) => {
      // Gate: never queue someone who hasn't accepted the recording notice. The
      // frontend POSTs consent first, so this is defense-in-depth.
      if (!(await hasConsented(payload.userId))) {
        socket.emit("needs_consent");
        return;
      }

      const entry: QueueEntry = { ...payload, socketId: socket.id };
      // dedupe: don't let the same socket sit in the queue twice
      await redis.lrem(QUEUE_KEY, 0, JSON.stringify(entry));
      await redis.rpush(QUEUE_KEY, JSON.stringify(entry));
      socket.emit("queued");
    });

    // Leave the queue without disconnecting (the "Cancel" button on the wait screen).
    async function dequeueSocket() {
      const all = await redis.lrange(QUEUE_KEY, 0, -1);
      for (const item of all) {
        try {
          if ((JSON.parse(item) as QueueEntry).socketId === socket.id) {
            await redis.lrem(QUEUE_KEY, 0, item);
          }
        } catch {
          /* ignore malformed entries */
        }
      }
    }
    socket.on("leave_queue", () => {
      dequeueSocket().catch(console.error);
    });

    // "Next": leave the current call and go back into the queue. We tear the room
    // down server-side so the session ends deterministically (-> egress ends ->
    // room_finished -> stitch) instead of waiting on LiveKit's empty_timeout.
    socket.on("leave", async ({ roomName }: { roomName?: string }) => {
      if (roomName) await endRoom(roomName);
      if (socket.data.roomName === roomName) socket.data.roomName = undefined;
    });

    socket.on("disconnect", async () => {
      // best-effort: remove any of this socket's queue entries
      await dequeueSocket();
      // If they dropped mid-call, end the room so the other side isn't stranded and
      // the recording gets stitched.
      if (socket.data.roomName) await endRoom(socket.data.roomName);
    });
  });

  // matching tick — 1s is plenty for a small group
  setInterval(() => matchTick(io).catch(console.error), 1000);
}

async function matchTick(io: Server) {
  // drain as many pairs as are available this tick
  while (true) {
    const pair = (await redis.eval(POP_PAIR, 1, QUEUE_KEY)) as string[] | null;
    if (!pair) break;

    const a = JSON.parse(pair[0]) as QueueEntry;
    const b = JSON.parse(pair[1]) as QueueEntry;

    // guard: never pair a user with themselves (e.g. two tabs)
    if (a.userId === b.userId) {
      await redis.rpush(QUEUE_KEY, pair[0]); // requeue one, drop the dup
      continue;
    }

    const roomName = randomUUID();
    const session = await prisma.chatSession.create({
      data: { roomName, userAId: a.userId, userBId: b.userId },
    });

    // Durable per-recording consent proof now that a session id exists. Both users
    // were already gated on a session-less acceptance at join_queue time.
    await prisma.consentRecord.createMany({
      data: [
        { userId: a.userId, sessionId: session.id, noticeVersion: NOTICE_VERSION },
        { userId: b.userId, sessionId: session.id, noticeVersion: NOTICE_VERSION },
      ],
      skipDuplicates: true,
    });

    const [tokenA, tokenB] = await Promise.all([
      createJoinToken(a.userId, roomName),
      createJoinToken(b.userId, roomName),
    ]);

    // Remember which room each socket is in so we can tear it down on disconnect.
    const sockA = io.sockets.sockets.get(a.socketId);
    const sockB = io.sockets.sockets.get(b.socketId);
    if (sockA) sockA.data.roomName = roomName;
    if (sockB) sockB.data.roomName = roomName;

    io.to(a.socketId).emit("matched", { roomName, token: tokenA, peer: b.handle });
    io.to(b.socketId).emit("matched", { roomName, token: tokenB, peer: a.handle });
  }
}
