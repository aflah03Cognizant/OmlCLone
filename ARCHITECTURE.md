# Random Video-Chat — Full Architecture & Operations Guide

A deep, end-to-end explanation of this project: what every piece does, how data
flows through it, the (painful) networking model, the recording pipeline, and a
troubleshooting playbook keyed to the exact errors you'll hit running it locally.

> This is the companion to `README.md`. README = quick start. This file = the whole
> mental model.

---

## Table of contents

1. [What it is](#1-what-it-is)
2. [Tech stack and why each piece exists](#2-tech-stack-and-why-each-piece-exists)
3. [Repository layout](#3-repository-layout)
4. [The processes you actually run](#4-the-processes-you-actually-run)
5. [The data model](#5-the-data-model)
6. [Architecture overview](#6-architecture-overview)
7. [The networking model (read this twice)](#7-the-networking-model-read-this-twice)
8. [Lifecycle of one call, step by step](#8-lifecycle-of-one-call-step-by-step)
9. [Backend deep-dive (every file)](#9-backend-deep-dive-every-file)
10. [Frontend deep-dive](#10-frontend-deep-dive)
11. [The recording → stitch pipeline in detail](#11-the-recording--stitch-pipeline-in-detail)
12. [Permissions & filesystem model](#12-permissions--filesystem-model)
13. [Configuration reference](#13-configuration-reference)
14. [Troubleshooting playbook](#14-troubleshooting-playbook)
15. [Security hardening before exposing it](#15-security-hardening-before-exposing-it)
16. [Scaling & hosting for friends](#16-scaling--hosting-for-friends)
17. [Known limitations & approximations](#17-known-limitations--approximations)

---

## 1. What it is

A random 1-on-1 video-chat (think "Omegle") for a **closed, consenting group** — a
handful of known people, up to ~30 concurrent calls. The defining feature: **every
call is recorded per-participant and stitched into a single side-by-side MP4** that
an admin can review.

User's-eye view:

1. Open the app, enter a handle, read and accept a recording-consent notice.
2. Land in a queue. The matchmaker pairs you with whoever else is waiting.
3. You're dropped into a live video call with your peer.
4. Hit **Next** to leave and get re-queued for a new partner.
5. Meanwhile, the server quietly records both sides and produces a reviewable MP4.

Admin's-eye view: a password-protected dashboard listing every session, the live
count of active calls, and an inline player for each finished recording.

---

## 2. Tech stack and why each piece exists

| Layer | Tech | Why it's here |
|---|---|---|
| Frontend | React + Tailwind (Vite), LiveKit React components | UI + camera publish/render without hand-writing WebRTC |
| Signaling / matchmaking | Node + TypeScript + Socket.IO | real-time queue + pairing + token hand-off |
| Queue state | Redis | atomic pair-pop via a Lua script; also the BullMQ + LiveKit backbone |
| Media routing | LiveKit SFU (OSS) | a Selective Forwarding Unit routes everyone's live video |
| Recording | LiveKit Egress (separate service) | subscribes to each track and dumps it to a file |
| Stitch worker | BullMQ + FFmpeg | offline job: sync + combine the 4 raw tracks into 1 MP4 |
| Persistence | PostgreSQL + Prisma | users, sessions, messages, consent, media paths |
| Admin | Express (server-rendered HTML) | list sessions + stream MP4s behind Basic auth |

**Why a SFU and not peer-to-peer?** Recording. With P2P there's no central place to
capture the streams. A SFU sees every track, so Egress can subscribe and record them
server-side — which is the whole point of this project.

**Why per-track Egress and not composite?** Track Egress writes each raw track to
disk with *no live transcoding* — cheap. The expensive transcode (combining + syncing)
happens once, later, in the FFmpeg worker, where we can bound concurrency.

---

## 3. Repository layout

```
prisma/
  schema.prisma          data model (Prisma → Postgres)
src/
  server.ts              entry point: wires everything, runs the cleanup cron
  lib.ts                 shared: Redis, LiveKit clients, token, consent notice, path mapping
  matchmaker.ts          Socket.IO: queue, pairing, room teardown
  egress-webhook.ts      LiveKit webhooks → start egress, record paths, enqueue stitch
  stitch-worker.ts       BullMQ worker: FFmpeg side-by-side render
  api.ts                 REST: /api/login, /api/consent-notice, /api/consent
  admin.ts               /admin/* behind Basic auth: dashboard + MP4 streaming
  seed.ts                creates test users (alice, bob, carol)
web/
  src/
    main.tsx             React entry
    App.tsx              state machine: start → queue → call
    socket.ts            shared Socket.IO client
    api.ts               REST helpers
    components/
      StartScreen.tsx    handle + consent
      QueueScreen.tsx    "looking for someone…"
      CallScreen.tsx     LiveKit room + Next button
  vite.config.ts, tailwind.config.js, postcss.config.js, tsconfig*.json
livekit.yaml             the SFU config
egress.yaml              the recorder config
docker-compose.yml       Redis + Postgres + LiveKit SFU + LiveKit Egress
.env.example             backend env template
```

---

## 4. The processes you actually run

This trips people up: there are **five** moving processes, and only the infra runs in
Docker. The Node code and the frontend run on your host.

| # | Process | How you start it | Where it runs |
|---|---|---|---|
| 1 | Redis, Postgres, LiveKit SFU, LiveKit Egress | `docker compose up -d` | Docker |
| 2 | Backend (signaling + webhooks + admin) | `npm run dev` | host |
| 3 | Stitch worker | `npm run worker` | host |
| 4 | Frontend dev server | `cd web && npm run dev` | host |
| 5 | (one-time) DB migrate + seed | `npm run prisma:migrate`, `npm run seed` | host |

The backend and worker are **separate processes on purpose**: the worker runs CPU-heavy
FFmpeg jobs, and isolating it means a stitch storm can't stall the signaling server.

---

## 5. The data model

Defined in `prisma/schema.prisma`. Five tables.

### `User`
A known person. `handle` is the unique login (no passwords — closed group). Optional
`email`, plus `lastSeenAt`/`lastIp` telemetry (PII, pruned on cleanup).

### `ChatSession`
One pairing = one room = one row.
- `roomName` — the LiveKit room UUID (unique).
- `status` — `ACTIVE → ENDED → STITCHING → STITCHED` (or `FAILED`).
- `userAId` / `userBId` — the two participants.
- `startedAt` / `endedAt`.
- `stitchedPath` / `stitchedAt` — the final MP4 once rendered.
- relations: `egressTracks`, `messages`, `consents`.

### `EgressTrack`
One per recorded track — **4 per session** (each participant's audio + video).
- `egressId` — LiveKit's egress id (unique).
- `participant` — the user id (LiveKit "identity"), used to group tracks by person.
- `kind` — `AUDIO` | `VIDEO`.
- `filePath` — set on `egress_ended`; the authoritative on-disk path from LiveKit.
- `startedAt` — `BigInt` (unix **ms**) used to compute A/V offset.
- `endedAt`.

### `Message`
Chat transcript rows (scaffolded; not wired into the UI yet).

### `ConsentRecord` — note the deliberate design
Proof someone accepted the recording notice. **`sessionId` is optional**, which encodes
a two-phase consent flow:

- `sessionId = null` → a **pre-queue acceptance**, written by `POST /api/consent` on the
  Start screen. This is the "POST writes a ConsentRecord" requirement, and it's what the
  matchmaker checks before it will queue you.
- `sessionId = set` → a **durable per-recording proof**, written by the matchmaker when
  you're actually paired (that's the first moment a session exists).

`@@unique([userId, sessionId])` — and because Postgres treats `NULL`s as distinct,
repeated pre-queue acceptances are allowed (an audit log).

### Status state machine

```
ACTIVE ──room_finished──▶ ENDED ──all 4 tracks done──▶ STITCHING ──ffmpeg ok──▶ STITCHED
                                                              └──ffmpeg fails──▶ FAILED
```

---

## 6. Architecture overview

```mermaid
flowchart TB
  subgraph host[Your machine - host]
    BROWSER[Browser - React app]
    BE[Backend :3000<br/>signaling + webhooks + admin]
    WORKER[Stitch worker<br/>BullMQ + FFmpeg]
    REC[(./recordings)]
    OUT[(./stitched)]
  end
  subgraph docker[Docker]
    SFU[LiveKit SFU :7880 + UDP]
    EG[LiveKit Egress]
    REDIS[(Redis)]
    PG[(Postgres)]
  end

  BROWSER -- Socket.IO + REST --> BE
  BROWSER -- WS signaling + UDP media --> SFU
  BE -- start egress (HTTP) --> SFU
  SFU -- webhooks (HTTP) --> BE
  SFU <-- coordinate --> REDIS
  EG <-- coordinate --> REDIS
  EG -- subscribes to tracks --> SFU
  EG -- writes files --> REC
  BE -- enqueue stitch (Redis) --> REDIS
  WORKER -- consume jobs --> REDIS
  WORKER -- reads --> REC
  WORKER -- writes --> OUT
  BE -- Prisma --> PG
  WORKER -- Prisma --> PG
  BE -- streams MP4 --> BROWSER
```

The two "halves" that have to talk across the Docker boundary are the cause of nearly
every setup error: **SFU → backend (webhooks)** and **SFU → browser (media)**.

---

## 7. The networking model (read this twice)

Almost all the pain in this project is one idea: **a name/IP only means something from
where you're standing.** `localhost` inside a container is the container; `localhost` on
another device is that device. Here's the full matrix.

### Who connects to whom

| Connection | From → To | Protocol/Port | Address to use |
|---|---|---|---|
| App REST + Socket.IO | Browser → Backend | HTTP/WS :3000 | `localhost` (same machine) / **WiFi IP** (other device) |
| LiveKit signaling | Browser → SFU | WS :7880 | `localhost` / **WiFi IP** |
| **WebRTC media** | Browser ↔ SFU | **UDP 50000–50049** | governed by `rtc.node_ip` → **WiFi IP** |
| **Webhooks** | SFU → Backend | HTTP :3000 | `host.docker.internal` (or WiFi IP) |
| Start egress | Backend → SFU | HTTP :7880 | `localhost:7880` (host → published port) |
| SFU ↔ Egress ↔ Redis | container → container | Redis :6379 | **service name** (`redis`) |
| Egress → SFU | container → container | WS :7880 | **service name** (`livekit-server`) |

### The rule of thumb

> **Does a *browser* need to reach it? → use your WiFi LAN IP.**
> **Does only a *container* need to reach the host? → `host.docker.internal`.**
> **Does a *container* need another *container*? → the compose service name.**

### Why each "gotcha" address is what it is

- **`webhook.urls` = `host.docker.internal:3000`** — the SFU (in a container) calls *out*
  to your backend (on the host). On Docker Desktop this name is built in; on Linux the
  compose file adds `extra_hosts: host.docker.internal:host-gateway` to make it resolve.
  Your WiFi IP also works here.
- **`rtc.node_ip` = your WiFi IP** — this is the address the SFU *advertises to browsers*
  as where to send UDP media (ICE candidates). A browser can't resolve
  `host.docker.internal` (it's Docker-only), and `127.0.0.1` only works for a tab on the
  same machine. Your WiFi IP works for both the local tab and other devices, so use it.
  Pair it with `use_external_ip: false` so the SFU doesn't try to STUN-discover a public
  IP instead.
- **`redis.address` / `ws_url` = service names** (`redis:6379`, `ws://livekit-server:7880`)
  — these are container-to-container, on the compose network, where `localhost` would mean
  "myself."

### The three frontend env vars must match

In `web/.env`:
```
VITE_BACKEND_URL = http://<localhost-or-wifi-ip>:3000
VITE_LIVEKIT_URL = ws://<localhost-or-wifi-ip>:7880
```
For a cross-device test, use the **WiFi IP in both**, set `rtc.node_ip` to the same WiFi
IP, set `WEB_ORIGIN` (backend `.env`) to `http://<wifi-ip>:5173` for CORS, and set Vite
`server.host: true`.

### The HTTPS wall (why other devices can't use the camera over http)

Browsers only allow `getUserMedia` (camera/mic) in a **secure context**: `https://…` or
`localhost`. `http://<wifi-ip>:5173` is *neither*, so the camera silently fails on a
remote device even when routing is correct. This is why two tabs on `localhost` worked
but a phone on the WiFi didn't. Options: a per-device Chrome flag
(`chrome://flags/#unsafely-treat-insecure-origin-as-secure`) for quick tests, or real
HTTPS (mkcert locally; Let's Encrypt for hosting).

---

## 8. Lifecycle of one call, step by step

```mermaid
sequenceDiagram
  participant A as Browser A
  participant B as Browser B
  participant BE as Backend
  participant SFU as LiveKit SFU
  participant EG as Egress
  participant W as Stitch worker

  A->>BE: POST /api/login, /api/consent
  A->>BE: join_queue (Socket.IO)
  B->>BE: (same)
  BE->>BE: matchTick: Lua pop pair, create ChatSession + consent rows
  BE-->>A: matched {roomName, token, peer}
  BE-->>B: matched {roomName, token, peer}
  A->>SFU: join room + publish camera/mic (token)
  B->>SFU: join room + publish camera/mic (token)
  SFU-->>BE: webhook track_published (x4)
  BE->>SFU: startTrackEgress (x4)
  EG->>SFU: subscribe track
  EG->>EG: write ./recordings/<room>/<id>.webm/.ogg
  Note over A,B: ... live call ...
  A->>BE: leave {roomName}  (Next)
  BE->>SFU: deleteRoom
  SFU-->>BE: webhook egress_ended (x4)  store filePath + startedAt
  SFU-->>BE: webhook room_finished       status → ENDED
  BE->>BE: maybeEnqueueStitch: all 4 done → claim ENDED→STITCHING → enqueue
  W->>W: read 4 files, compute offset, FFmpeg hstack+amix
  W->>BE: status → STITCHED, stitchedPath set
  Note over W: ./stitched/<sessionId>.mp4 now playable in /admin/dashboard
```

Mapped to code:

1. **Login + consent** → `src/api.ts`. Consent writes a session-less `ConsentRecord`.
2. **`join_queue`** → `src/matchmaker.ts`. Gated on `hasConsented()`. Pushed to Redis list
   `mm:queue`.
3. **Pairing** → `matchTick()` runs every 1s, atomically pops two distinct users via the
   `POP_PAIR` Lua script, creates the `ChatSession`, writes the per-session `ConsentRecord`s,
   mints a LiveKit token each (`createJoinToken`), emits `matched`.
4. **Join + publish** → `web/src/components/CallScreen.tsx` renders `<LiveKitRoom>` which
   connects with the token and publishes camera + mic.
5. **`track_published` webhook** (×4) → `src/egress-webhook.ts` calls
   `egressClient.startTrackEgress(room, new DirectFileOutput({filepath}), trackId)` and
   records an `EgressTrack` row.
6. **Egress writes files** → into the bind-mounted `recordings/<room>/…`.
7. **Next / disconnect** → `matchmaker.ts` `leave`/`disconnect` calls `endRoom()`
   (`roomService.deleteRoom`) so the room ends deterministically.
8. **`egress_ended` webhook** (×4) → store the real `filePath` + `startedAt`.
9. **`room_finished` webhook** → mark `ENDED`.
10. **`maybeEnqueueStitch`** runs from *both* steps 8 and 9 (either can be last); when all 4
    tracks are done and status is `ENDED`, it atomically claims `ENDED → STITCHING` and
    enqueues a BullMQ job exactly once.
11. **Stitch** → `src/stitch-worker.ts` computes the offset, runs FFmpeg, writes the MP4,
    sets status `STITCHED`.
12. **Review** → `src/admin.ts` `/admin/dashboard` lists it and streams the MP4.

---

## 9. Backend deep-dive (every file)

### `src/lib.ts` — shared infrastructure
- **`redis`** — one ioredis client, created with `maxRetriesPerRequest: null` (BullMQ
  *requires* this). Used by matchmaking and BullMQ.
- **`createJoinToken(identity, room)`** — mints a LiveKit `AccessToken` (`canPublish` +
  `canSubscribe`), 2h TTL. `identity` = the user id, which is how webhook track events are
  attributed to a person.
- **`roomService` / `egressClient`** — LiveKit server clients. **Constructed with the HTTP
  URL** (`ws://` → `http://` conversion), because these speak Twirp-over-HTTP, not WS.
- **`endRoom(roomName)`** — `deleteRoom`, swallowing "already gone" errors.
- **`NOTICE_VERSION` / `NOTICE_TEXT`** — the single source of truth for the consent notice.
- **`toHostPath(egressPath)`** — translates an Egress container path (`/out/…`) into the
  host path the worker can read (`./recordings/…`). See [§12](#12-permissions--filesystem-model).

### `src/matchmaker.ts` — Socket.IO + pairing
- **`POP_PAIR`** Lua script — atomically pops two queue entries (Redis is single-threaded,
  so no two ticks can grab the same person); re-pushes a lone entry.
- **`join_queue`** — consent gate, then `rpush` onto `mm:queue` (with de-dupe).
- **`leave_queue`** — Cancel button; removes this socket's queue entries.
- **`leave`** — Next button; `endRoom()` then the client re-queues.
- **`disconnect`** — de-queue + end the room if they dropped mid-call.
- **`matchTick`** — the 1s pairing loop (described above).

### `src/egress-webhook.ts` — the pipeline driver
- Verifies each webhook with `WebhookReceiver.receive(rawBody, authHeader)`.
- **`track_published`** → start a Track Egress to a local file. Idempotent: skips if an
  `EgressTrack` for `(session, participant, kind)` already exists (webhooks retry).
- **`egress_ended`** → persist `filePath` (`fileResults[0].filename`) and `startedAt`
  (bigint nanoseconds → ms), then re-check the stitch condition.
- **`room_finished`** → mark `ACTIVE → ENDED`, then re-check.
- **`maybeEnqueueStitch`** → the exactly-once enqueue with an atomic `updateMany` claim.

> **SDK version note:** written for `livekit-server-sdk` v2. The two things that differ
> across versions: `startTrackEgress` takes a `DirectFileOutput`/string (not the old
> `{ file: {...} }`), and `TrackType.AUDIO === 0` / `VIDEO === 1`.

### `src/stitch-worker.ts` — the FFmpeg render
- BullMQ `Worker` on the `stitch` queue, **`concurrency: 2`** (the guardrail against a
  burst fork-bombing FFmpeg).
- Picks the 4 tracks by `(participant, kind)`, maps their paths with `toHostPath`,
  computes the offset, builds one FFmpeg command, writes the MP4, sets `STITCHED`.
- On failure → status `FAILED`.

### `src/api.ts` — REST (CORS + JSON scoped to `/api`)
- `POST /api/login {handle}` → upsert user, return `{id, handle}`.
- `GET /api/consent-notice` → `{version, text}` (server owns the wording).
- `POST /api/consent {userId, noticeVersion}` → writes the session-less `ConsentRecord`.

### `src/admin.ts` — review surface (Basic auth on all of `/admin`)
- Hand-rolled Basic auth (constant-time compare) using `ADMIN_USER` / `ADMIN_PASSWORD`.
- `GET /admin/dashboard` → server-rendered HTML: session list, live active-call count,
  inline `<video>` players for `STITCHED` sessions.
- `GET /admin/sessions` → JSON.
- `GET /admin/media/:id` → streams the MP4 with **HTTP range support** so the player can seek.

### `src/server.ts` — entry point
- Mounts api → webhooks → admin (**no global JSON parser** — it would eat the webhook's raw
  body; JSON is scoped to `/api`).
- **Cleanup cron** (hourly): hard-deletes sessions older than 24h (mapping container paths
  to host paths before `rm`), and prunes stale session-less consents.

### `src/seed.ts`
Upserts `alice`, `bob`, `carol` (three so you have an odd-one-out to watch the queue).

---

## 10. Frontend deep-dive

A small Vite + React + Tailwind app. All realtime coordination is over one shared
Socket.IO connection (`web/src/socket.ts`).

- **`App.tsx`** — a 3-state machine: `start → queue → call`. Listens for `matched`,
  `queued`, `needs_consent`. The **`requeue()` guard** (`requeuedFor` ref) ensures the
  "Next" button and LiveKit's `onDisconnected` callback don't double-requeue the same room.
- **`StartScreen.tsx`** — step 1: handle → `POST /api/login`; step 2: shows the
  server-provided notice, requires the checkbox, then `POST /api/consent` before entering
  the queue.
- **`QueueScreen.tsx`** — spinner + Cancel (`leave_queue`).
- **`CallScreen.tsx`** — `<LiveKitRoom>` (connect + publish camera/mic), `useTracks` +
  `<GridLayout>`/`<ParticipantTile>` to render local + remote tiles, `<RoomAudioRenderer>`
  for audio, a minimal `<ControlBar>` (mic/cam toggles; its own leave button hidden), and
  the **Next** button which ends the room and re-queues.

`main.tsx` deliberately does **not** use `<React.StrictMode>` — its double-invoked effects
make a live WS + LiveKit room connect/disconnect twice, which is confusing while learning.

---

## 11. The recording → stitch pipeline in detail

### What gets recorded
Each participant publishes a camera (video) and a mic (audio) track. The SFU fires
`track_published` per track; the backend starts a **Track Egress** per track → **4 raw
files per room**, e.g.:
```
recordings/<roomUUID>/<userIdA>-<trackSid>.webm   (A video)
recordings/<roomUUID>/<userIdA>-<trackSid>.ogg    (A audio)
recordings/<roomUUID>/<userIdB>-<trackSid>.webm   (B video)
recordings/<roomUUID>/<userIdB>-<trackSid>.ogg    (B audio)
```
The extension we request is a hint; the **authoritative path** is whatever LiveKit reports
in `egress_ended` (`fileResults[0].filename`), which is what we store.

### A/V sync (approximate, by design)
The two participants don't start at the same instant, and their media clocks are
independent. We approximate alignment using each video track's egress `startedAt`:

```
offset  = |startedB − startedA|  (seconds)
laterParticipant gets:  -itsoffset <offset>   (delays its inputs to line up t=0)
```

`-itsoffset` shifts an input's timestamps forward, so delaying the *later* starter by the
gap lines both timelines up at a common origin. Expect tens of milliseconds of residual
drift — fine for review, not broadcast-grade.

### The FFmpeg command (from `stitch-worker.ts`)
```
ffmpeg
  [-itsoffset <off>] -i A.video
  [-itsoffset <off>] -i B.video
  [-itsoffset <off>] -i A.audio
  [-itsoffset <off>] -i B.audio
  -filter_complex
    "[0:v]scale=-2:480[v0];[1:v]scale=-2:480[v1];[v0][v1]hstack=inputs=2[v];
     [2:a][3:a]amix=inputs=2:duration=longest:dropout_transition=2[a]"
  -map [v] -map [a]
  -c:v libx264 -preset veryfast -crf 26
  -c:a aac -movflags +faststart
  -y stitched/<sessionId>.mp4
```
- **`scale=-2:480`** on each video *before* `hstack` — the two webcams can negotiate
  different resolutions, and `hstack` errors on mismatched heights. We normalize to 480px
  tall (even width).
- **`hstack`** — side-by-side video. **`amix`** — mixed audio.
- **`+faststart`** — moves the MP4 index to the front so the admin player can start before
  the whole file downloads.

---

## 12. Permissions & filesystem model

This is the other big source of local errors.

### The shared folder
`docker-compose.yml` bind-mounts the host's `./recordings` to the egress container's
`/out`, and `egress.yaml` sets `local_output_directory: /out`. So:

```
Egress writes:   /out/<room>/<file>          (container path)
Same bytes on host: ./recordings/<room>/<file>
```

The webhook stores the **container** path; the worker translates it back with
`toHostPath()` (`EGRESS_OUTPUT_DIR=/out` → `REC_DIR=./recordings`) before FFmpeg opens it.
Stitched output (`./stitched`) is host-only — no mapping needed.

### Why "permission denied" happens
- The egress process runs as a **non-root user** (`uid=1001`).
- On Linux, a bind-mounted host folder keeps **host ownership**. If Docker auto-created
  `./recordings` (because it didn't exist at first `up`), it's owned by **root**, so uid
  1001 can't create `/out/<room>` → `mkdir: permission denied`.

### The fix
Make the folder writable by the egress user:
```fish
sudo chown -R $USER:$USER recordings stitched   # if root-owned from a prior run
chmod -R 777 recordings                          # any UID (incl. 1001) can write
```
Verify from *inside* the container (the source of truth):
```fish
docker compose exec egress id            # uid=1001(egress)
docker compose exec egress ls -la /out   # should be drwxrwxrwx
docker compose exec egress touch /out/writetest; and echo OK
```

### Why you can't "just run egress as root"
`user: "0:0"` makes the egress image fail to start — it's built around its own
`egress` user (home dir, Chrome sandbox). It also leaves root-owned files the host worker
can't clean up. Don't; fix the folder perms instead.

---

## 13. Configuration reference

### Backend `.env` (see `.env.example`)
| Var | Meaning | Local default |
|---|---|---|
| `DATABASE_URL` | Postgres connection | `postgresql://postgres:dev@localhost:5432/postgres` |
| `REDIS_URL` | Redis connection | `redis://localhost:6379` |
| `LIVEKIT_URL` | SFU **ws** URL (also derives the HTTP URL) | `ws://localhost:7880` |
| `LIVEKIT_API_KEY` / `_SECRET` | must match `livekit.yaml` keys | `devkey` / `devsecret_change_me` |
| `REC_DIR` | host folder the worker reads | `./recordings` |
| `EGRESS_OUTPUT_DIR` | container path egress writes (for `toHostPath`) | `/out` |
| `OUT_DIR` | stitched MP4 output (host) | `./stitched` |
| `WEB_ORIGIN` | allowed CORS origin for `/api` | `http://localhost:5173` |
| `NOTICE_VERSION` | bump to invalidate old consents | `v1` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | `/admin` Basic auth | `admin` / `changeme` |
| `PORT` | backend port | `3000` |

### `web/.env`
| Var | Meaning |
|---|---|
| `VITE_BACKEND_URL` | backend base URL (localhost or WiFi IP) |
| `VITE_LIVEKIT_URL` | SFU ws URL (localhost or WiFi IP) |

### `livekit.yaml` (the SFU)
- `keys` — API key/secret (must match the backend + `egress.yaml`).
- `rtc.port_range_start/end` — UDP media ports; **must match the published range** in
  `docker-compose.yml`.
- `rtc.use_external_ip: false` + `rtc.node_ip: <WiFi IP>` — what browsers use for media.
- `room.empty_timeout: 30` — close empty rooms quickly so `room_finished` fires.
- `redis.address: redis:6379` — compose service name.
- `webhook.urls: http://host.docker.internal:3000/livekit/webhook` — SFU → backend.

### `egress.yaml` (the recorder)
- `redis.address: redis:6379`, `ws_url: ws://livekit-server:7880` — service names.
- `api_key` / `api_secret` — must match `livekit.yaml`.
- `local_output_directory: /out` — the container side of the recordings bind mount.

### `docker-compose.yml`
- Publishes 6379 (Redis), 5432 (Postgres), 7880/7881 + the UDP range (SFU).
- Bind-mounts `./livekit.yaml`, `./egress.yaml`, and `./recordings:/out`.
- `extra_hosts: host.docker.internal:host-gateway` on the SFU (Linux webhook reachability).

---

## 14. Troubleshooting playbook

Diagnose **in pipeline order** — recordings empty? check egress; stitched empty? check the
worker. Use Prisma Studio (`npm run prisma:studio`) to see the truth in the DB.

### `EgressTrack` rows tell you where you are
| You see | Meaning | Look at |
|---|---|---|
| 0 rows | webhook never arrived, or `startTrackEgress` threw | webhook delivery (below) |
| rows, `filePath` null | egress was asked but never wrote/finished | egress health + perms |
| rows + `filePath`, no file on disk | container wrote, host path mismatch | the bind mount / `toHostPath` |
| rows + `filePath` + file exists | recording works | move on to the stitch stage |

### Symptom → cause → fix
| Symptom | Cause | Fix |
|---|---|---|
| `failed to send webhook` / `connection refused` in `livekit-server` logs | SFU can't reach the host backend | use `host.docker.internal:3000` (or WiFi IP); open host firewall to :3000; ensure `npm run dev` is up |
| `mkdir: permission denied` in egress logs | bind-mounted folder not writable by uid 1001 | `chown $USER` + `chmod -R 777 recordings` ([§12](#12-permissions--filesystem-model)) |
| egress container won't start | you set `user: "0:0"` | remove it; egress must run as its own user |
| call connects but video is black | SFU advertising an unreachable IP | set `rtc.node_ip` = WiFi IP, `use_external_ip: false`, open UDP range |
| camera permission error on another device | `http://<ip>` is not a secure context | Chrome insecure-origin flag, or HTTPS |
| "port 3000" error from another device | frontend pointing at `localhost` | set `VITE_BACKEND_URL`/`VITE_LIVEKIT_URL` to WiFi IP; `WEB_ORIGIN` too; `server.host: true` |
| webhook `signature/parse failed` (401) | key mismatch | align `livekit.yaml` keys with backend `LIVEKIT_API_KEY/SECRET` |
| recordings exist, `stitched/` empty | worker not running, or `room_finished` not firing | start `npm run worker`; check `room_finished` in SFU logs; lower `empty_timeout` |
| session stuck `STITCHING`/`FAILED` | FFmpeg error | read worker logs; usually a missing/zero-byte track or codec issue |

### Useful commands
```fish
docker compose ps                                   # are all 4 services Up?
docker compose logs --since=2m egress               # fresh egress activity
docker compose logs --since=2m livekit-server | grep -i webhook
docker compose exec egress ls -la /out              # what egress actually sees
ls -R recordings ; ls stitched                      # files on disk
npm run prisma:studio                               # inspect EgressTrack / ChatSession
```

---

## 15. Security hardening before exposing it

The defaults are dev-only. Before anyone outside your machine touches it:
- **Regenerate LiveKit keys** (`devkey`/`devsecret_change_me` are public) and update
  `livekit.yaml`, `egress.yaml`, and the backend `.env`.
- **Strong `ADMIN_PASSWORD`**, served only over HTTPS.
- **Lock CORS**: Socket.IO is `origin: "*"` and `/api` allows the Vite origin — set both to
  your real domain.
- **Gate logins**: today any handle creates a user. Pre-seed allowed handles and reject
  unknowns, or add a shared room passcode.
- Recordings + `lastIp` are PII — the 24h cleanup helps; keep it.

---

## 16. Scaling & hosting for friends

For 1–30 concurrent calls the **SFU is not the bottleneck**; **Egress + FFmpeg are**.

- Each active call = 4 egresses (RAM-bound). Track egress (no live transcode) is the cheap
  choice — keep it.
- **Move the worker (FFmpeg) to its own machine** as load grows; it only needs Redis + read
  access to the recordings volume.
- **Egress scales horizontally**: run multiple `livekit-egress` instances against the same
  Redis.
- Redis/Postgres are nowhere near limits; Upstash / Neon free tiers drop in via env if you
  want them off-box.

Hosting for friends needs three things `localhost` hid: a **public IP + open UDP**, **HTTPS/
WSS** (for camera permission), and a **TURN server** for strict NATs. The free-friendly
path that keeps your local-recording design: one small public VM (e.g. Oracle Cloud Always
Free) running everything, a free domain (DuckDNS), Caddy for auto-TLS, `rtc.node_ip` =
the VM's public IP, UDP range opened in the cloud firewall, and LiveKit's built-in TURN
enabled. (LiveKit Cloud's free tier removes the networking pain but records to cloud
storage, not local disk — which would mean rewriting the stitch/admin flow.)

---

## 17. Known limitations & approximations

- **A/V sync is approximate** — independent media clocks; we get close with `-itsoffset`,
  not sample-accurate.
- **Local Docker media** needs `rtc.node_ip` set correctly; it's the #1 "connects but no
  video" cause.
- **Exactly-4-tracks assumption** — if someone never grants camera/mic, fewer than 4 tracks
  arrive and the session stays `ENDED` (never stitches). That's intentional, not a bug.
- **No reconnection/resume** — a dropped socket re-queues you; it doesn't restore the call.
- **Messages table is scaffolded** but not wired into the UI.
- **Consent is per-notice-version** — bumping `NOTICE_VERSION` invalidates old acceptances
  by design.
- This is a **learning project**, not production: no rate limiting, no abuse controls, no
  horizontal session affinity.
```
