# Random Video-Chat — Closed Learning Setup

A small, self-contained app for learning the full WebRTC recording pipeline:
random pairing → LiveKit SFU → per-track egress → FFmpeg side-by-side stitch →
admin review.

**Intended use:** a closed group of known, consenting people. Every session is
recorded and reviewable by the admin (you). Not production code — a learning map.

## Components

| Piece           | Tech                          | Job                                          |
|-----------------|-------------------------------|----------------------------------------------|
| Frontend        | React + Tailwind (`web/`)     | sign in, consent, publish camera, "Next"     |
| Signaling/match | Node + TS + Socket.IO         | queue users, pair them, hand out tokens      |
| Queue state     | Redis                         | matchmaking list + atomic pairing            |
| Media           | LiveKit SFU (OSS, Go)         | route the live video                         |
| Recording       | LiveKit Egress (separate svc) | dump each track to a file                    |
| Stitch worker   | BullMQ + FFmpeg               | sync + combine 4 tracks into 1 MP4           |
| Persistence     | PostgreSQL + Prisma           | sessions, messages, consent, media paths     |
| Admin           | Express (server-rendered)     | review sessions + play stitched MP4s         |

## Layout

```
prisma/schema.prisma     data model
src/                      backend (server, matchmaker, egress webhook, stitch worker, api, admin, lib, seed)
web/                      React + Tailwind frontend (Vite)
livekit.yaml egress.yaml  LiveKit SFU + Egress config
docker-compose.yml        Redis + Postgres + LiveKit SFU + Egress
```

## Data flow

1. **Start screen**: user signs in by handle (`POST /api/login`) and accepts the
   recording notice (`POST /api/consent` → writes a session-less `ConsentRecord`).
   That acceptance is required before the matchmaker will queue them.
2. Client `join_queue` over WebSocket → pushed to Redis list `mm:queue`.
3. Matchmaker pops a pair atomically (Lua), creates a room UUID + `ChatSession`,
   writes the durable **per-session** `ConsentRecord`s, issues a LiveKit token to
   each, emits `matched`.
4. Both clients join the LiveKit room and publish camera + mic.
5. On each `track_published` webhook, the server starts a **Track Egress** to a
   local file → 4 files per room.
6. On `egress_ended`, the real file path + start timestamp are saved.
7. On `room_finished` **and** on the final `egress_ended` (either can arrive last),
   once all 4 tracks are down a stitch job is enqueued exactly once.
8. Stitch worker computes `offset = |startedB − startedA|`, runs FFmpeg
   (`-itsoffset` + `scale` + `hstack` + `amix`), writes the MP4 path to the session.
9. Admin reviews everything at `/admin/dashboard`.

## Run order (all local, free)

> Requires Docker (for infra), Node 20+, and FFmpeg on your PATH (for the worker).

```bash
# 1. infra: Redis, Postgres, LiveKit SFU + Egress
mkdir -p recordings stitched          # egress writes ./recordings; worker reads it
# (Linux only) chmod 777 recordings   # egress doesn't run as root
docker compose up -d

# 2. backend
cp .env.example .env                  # adjust ADMIN_PASSWORD etc.
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init # creates the schema in Postgres
npm run seed                          # alice, bob, carol
npm run dev                           # signaling + webhooks + admin on :3000
npm run worker                        # BullMQ stitch worker (own terminal)

# 3. frontend
cd web
cp .env.example .env
npm install
npm run dev                           # http://localhost:5173
```

Open two browser profiles/windows at <http://localhost:5173>, sign in as different
handles (e.g. `alice` and `bob`), accept the notice in both, and they'll be paired.
Click **Next** to end the call and requeue. Review recordings at
<http://localhost:3000/admin/dashboard> (Basic auth — `ADMIN_USER`/`ADMIN_PASSWORD`).

## Known caveats (read these)

- **LiveKit media over Docker (local).** Inside Docker the SFU advertises its
  container IP, which a browser on your host usually can't reach — so the call may
  connect (signaling) but show no video. Easiest fixes: run `livekit-server`
  natively on the host instead of in compose, or set `rtc.node_ip` in `livekit.yaml`
  to your host's LAN IP. See the comments in `livekit.yaml`. The signaling, egress,
  stitch, and admin code all work regardless; this is purely a local-networking
  detail of the SFU.
- **A/V sync is approximate.** We align on each participant's egress start time and
  `-itsoffset` the later starter. The two media clocks are independent, so expect
  some residual drift (tens of ms). Good enough to learn from; don't over-tune it.
- **SDK version sensitivity.** `src/egress-webhook.ts` is written for
  `livekit-server-sdk` v2 (`startTrackEgress(room, new DirectFileOutput({filepath}),
  trackId)`, `TrackType.AUDIO === 0`). If you bump the SDK, re-check those calls.
- **Stitch concurrency is capped at 2** so a burst of session-ends can't fork-bomb
  FFmpeg.
- **Recordings live on local disk** (`./recordings`, `./stitched`) and are
  hard-deleted after 24h by the cleanup cron in `src/server.ts`.
