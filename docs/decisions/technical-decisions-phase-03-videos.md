---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-02
scope_description: "Upload e processamento de vídeos: fila, estratégia de upload 10GB, worker FFmpeg, URL única, streaming/download e ciclo de status"
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the videos module, storage service, queue producer, and the video worker; all TDs below target it.
- `next-frontend/` — Phase 03 is a backend-only challenge; the video UI is explicitly out of scope (per challenge statement and project plan Phase 05). No TD in this document. Cross-layer TDs (upload protocol, streaming) define the contract the frontend will consume in later phases.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)" + "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The project plan leaves the queue technology explicitly open ("Message Queue (TBD)" in the architecture diagram). This is the main stack decision of the phase: it determines a new Compose service, the job contract between API and worker, and the retry/failure semantics.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue; NestJS provides first-class integration (`@nestjs/bullmq@11.0.4`, peer deps `@nestjs/common ^11`). Producers and consumers are injectable services; workers can run in a separate process.
- **Pros:** official NestJS integration and docs; built-in retries with exponential backoff, delayed jobs, concurrency control, job events; Redis is a single lightweight Compose service; the de-facto standard for Node background jobs.
- **Cons:** adds Redis as new infrastructure; at-least-once semantics require idempotent processors.

### Option B: pg-boss (PostgreSQL-based)
- Job queue on top of the existing PostgreSQL using `SKIP LOCKED`. No new broker.
- **Pros:** zero new infra (reuses Postgres 17); ACID guarantees — job enqueue can join the same transaction as the video row update.
- **Cons:** no official NestJS module (manual wiring); polling-based; couples queue throughput to the app database; less standard in NestJS ecosystem/course context.

### Option C: RabbitMQ (`@nestjs/microservices` or `@golevelup/nestjs-rabbitmq`)
- Dedicated AMQP broker; NestJS supports it via the microservices transport layer.
- **Pros:** robust routing, acks, dead-letter exchanges; language-agnostic if the worker ever leaves Node.
- **Cons:** heavier operational footprint (Erlang broker) for a single queue type; NestJS microservices transport is request/event-oriented — job-queue features (retry/backoff/progress) must be assembled by hand; overkill for this phase's single video-processing queue.

**Recommendation:** Option A (BullMQ + Redis) — retry/backoff/concurrency semantics needed for heavy FFmpeg jobs come built-in, `@nestjs/bullmq@11` matches the installed NestJS 11, and Redis is one small Compose service; pg-boss's transactional enqueue is attractive but its manual NestJS wiring and polling model outweigh that for a video pipeline.

**Decision:** **A (BullMQ + Redis)**

---

## TD-02: 10GB Upload Strategy (no API bottleneck)

**Scope:** Cross-layer

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" + "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Passing a 10GB body through the NestJS API blocks Node's event loop I/O, consumes container memory/disk, and is an automatic-fail criterion. The upload handshake (who talks to storage, in which sequence) is a contract both backend and future frontend must honor. The project plan also asks for resumable uploads ("permita retomar em caso de falha de conexão").

**Options:**

### Option A: Presigned multipart upload direct to MinIO/S3
- API pre-registers the video as draft, calls `CreateMultipartUpload`, and issues presigned `UploadPart` URLs (parts 5MB–5GB, max 10,000). Client uploads parts directly to storage and calls the API to `CompleteMultipartUpload`.
- **Pros:** zero video bytes through the API; native resume (re-send only failed parts); parallel part upload; single presigned PUT caps at 5GB, multipart is the S3-sanctioned path to 10GB; same code works on MinIO and AWS S3.
- **Cons:** multi-step handshake (initiate → parts → complete) the client must implement; ETag of each part must be collected (CORS `ExposeHeaders` in browser scenarios).

### Option B: tus protocol (resumable upload server)
- Dedicated tus server (e.g., tusd container) receives chunked resumable uploads and offloads to S3; API only reacts to hooks.
- **Pros:** standardized resumability; mature clients.
- **Cons:** one more infra service beyond storage+queue+worker; hook integration with the draft/status lifecycle is extra glue; overlaps with what S3 multipart already provides.

### Option C: Streaming proxy through the API (multer/busboy → storage)
- API receives the multipart HTTP stream and pipes it to MinIO.
- **Pros:** simplest client contract (one POST).
- **Cons:** every byte passes through the API (bandwidth, event loop, restart kills upload); resume requires custom protocol; explicitly the anti-pattern the challenge fails.

**Recommendation:** Option A (presigned multipart) — it is the S3-native answer to both the 10GB limit and resumability, requires no additional service, and keeps the API as a thin control plane (pre-register draft → issue part URLs → complete → enqueue job).

**Decision:** **A (Presigned multipart direct to storage)**

---

## TD-03: Video Worker Execution Model

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)" + "Processamento automático do vídeo após upload" + "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** FFmpeg jobs are CPU/IO heavy and must not share the API's event loop. The architecture diagram already prescribes a separate "Video Worker" container. What remains open is how the worker is built and deployed relative to the API codebase.

**Options:**

### Option A: Separate container, same NestJS codebase, dedicated entrypoint
- The worker is a second Compose service built from the same `nestjs-project` image, started with a worker-only bootstrap (`NestFactory.createApplicationContext` loading only the processing module). FFmpeg/ffprobe installed in the image.
- **Pros:** reuses TypeORM entities, repositories, config and DI — no code duplication; one build pipeline; scales independently (`docker compose up --scale`); crash isolation from the API.
- **Cons:** API image grows (FFmpeg binaries) unless a worker-specific Dockerfile target is used; deploy couples API and worker versions.

### Option B: Independent worker project (own package.json)
- A separate Node project (e.g., `video-worker/`) consuming the queue and talking to DB/storage directly.
- **Pros:** total isolation; minimal image.
- **Cons:** duplicates entities/config/migrations knowledge; two dependency trees to maintain; violates the project's continuity principle for a monorepo already centered on `nestjs-project`.

### Option C: In-process consumer inside the API
- The API process also consumes the queue.
- **Pros:** no new service.
- **Cons:** FFmpeg competes with HTTP traffic for CPU/event loop; defeats the purpose of the queue; contradicts the architecture diagram; fails the "worker subindo via Compose" acceptance criterion.

**Recommendation:** Option A (separate container, same codebase, dedicated entrypoint) — matches the C4 diagram, keeps single-source-of-truth for entities/config, and delivers real process isolation with one extra Compose service; use a dedicated Dockerfile stage adding FFmpeg only to the worker image if size matters.

**Decision:** **A (Separate container, same codebase, dedicated entrypoint)**

---

## TD-04: FFmpeg/ffprobe Invocation Strategy

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)" + "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration/metadata (ffprobe) and capture a frame as thumbnail (ffmpeg). The historical wrapper `fluent-ffmpeg` was archived in May 2025 (readonly, "no longer works properly with recent ffmpeg versions"), so the wrapper choice must be made deliberately.

**Options:**

### Option A: System binaries (apt) + direct `child_process` spawn
- Install `ffmpeg` via apt in the worker image; call `ffprobe -print_format json` and `ffmpeg -ss <t> -vframes 1` through `spawn`, parsing stdout.
- **Pros:** zero npm dependencies (no abandoned wrapper risk); full control over flags; ffprobe JSON output is stable and trivially parseable; binaries pinned by the Debian image.
- **Cons:** hand-written argument building and error mapping (~small utility module); no typed API.

### Option B: `ffmpeg-static` + `ffprobe-static` npm binaries + spawn
- Same direct-spawn approach but binaries ship via npm packages.
- **Pros:** no apt layer; version pinned in package.json.
- **Cons:** ~70MB+ binaries inside node_modules crossing the bind mount; per-platform binaries clash with the host-mount workflow used in this repo (macOS host / Linux container); apt already solves distribution.

### Option C: `fluent-ffmpeg` wrapper
- Classic fluent API over ffmpeg.
- **Pros:** ergonomic API; abundant examples.
- **Cons:** archived/unmaintained since May 2025 and flagged as broken with recent ffmpeg — inadequate for new code.

**Recommendation:** Option A (apt binaries + direct spawn) — the two commands this phase needs (probe JSON, single-frame capture) don't justify a wrapper, and the only popular wrapper is archived; a small typed utility around `spawn` keeps everything testable and dependency-free.

**Decision:** **A (apt binaries + direct spawn)**

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Each video needs a short, unique, URL-safe public identifier (YouTube-style), stored in the videos table and used by streaming/watch routes. It must never collide and should not expose sequence information (future unlisted videos must not be enumerable).

**Options:**

### Option A: nanoid v3 (CommonJS) with custom length + unique index
- Generate an 11-char URL-safe id (`A-Za-z0-9_-`) at pre-registration; DB `UNIQUE` constraint as safety net with regenerate-on-conflict retry. nanoid v4+ is ESM-only; v3.x is the CJS-compatible line for this `commonjs` NestJS project.
- **Pros:** YouTube-like short ids; collision probability negligible (64^11); non-enumerable; tiny lib.
- **Cons:** pinned to the 3.x line (still maintained for CJS); needs the conflict-retry guard however unlikely.

### Option B: UUID v4 (`crypto.randomUUID()`)
- Use the entity's UUID (already the PK pattern in this project) in the URL.
- **Pros:** zero new dependency; guaranteed unique (PK).
- **Cons:** 36-char URLs — fails the spirit of "URL curta e única" from the project plan's attention points; exposes the PK in public URLs.

### Option C: DB sequence + base62 encoding
- Encode an auto-increment counter.
- **Pros:** shortest possible ids; zero collision by construction.
- **Cons:** sequential → enumerable (breaks future unlisted visibility); leaks platform volume; needs a dedicated sequence + encoding logic anyway.

**Recommendation:** Option A (nanoid v3, 11 chars, unique index + retry) — short non-enumerable ids match the "URL curta e única" attention point, and the CJS constraint of the installed toolchain rules the v3 line, not v5.

**Decision:** **A (nanoid v3, 11 chars, unique index + retry)**

---

## TD-06: Streaming and Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** "Reprodução via streaming (sem necessidade de download completo)" + "Download do vídeo pelo usuário"

**Context:** Players need HTTP Range / `206 Partial Content` to seek without downloading the whole file. The choice is whether video bytes flow through the API or directly from MinIO/S3. Affects backend routes and how any client (frontend, curl, e2e test) consumes video.

**Options:**

### Option A: Presigned GET + API redirect (302)
- `GET /videos/:urlId/stream` validates access and redirects to a time-limited presigned URL; MinIO/S3 serves Range/206 natively. Download uses the same flow with `response-content-disposition: attachment`.
- **Pros:** zero video bytes through the API; S3/MinIO implement Range, ETag and caching correctly out of the box; download support is a query parameter, not new code.
- **Cons:** presigned URL must be signed against an endpoint reachable by the client (in dev, `localhost:9000` vs container-internal `minio:9000` — requires an explicit public-endpoint config); URL expiry must exceed a viewing session or the client re-requests.

### Option B: API streaming proxy with Range handling
- API receives the Range header, issues `GetObject` with the range to MinIO, and pipes bytes back with `206` + `Content-Range`.
- **Pros:** single-origin URLs (no MinIO exposure, no endpoint duality); per-request authorization on every byte range.
- **Cons:** all video traffic re-enters the API (bandwidth ×2 inside Compose, event loop pressure); manual Range parsing/edge cases; contradicts the "no video bytes through the API" principle established for upload.

### Option C: Hybrid — proxy for streaming, presigned for download
- Range proxy on the watch path; presigned URLs only for downloads.
- **Pros:** stable player URL.
- **Cons:** carries all of Option B's costs on the hottest path (streaming) while keeping Option A's config anyway; two delivery paths to test/maintain.

**Recommendation:** Option A (presigned GET + redirect) — consistent with the upload decision (storage handles bytes, API handles control), Range/206 comes free and battle-tested from MinIO, and the only real cost is a public-endpoint config that the multipart upload flow (TD-02) already requires.

**Decision:** **A (Presigned GET + 302 redirect)**

---

## TD-07: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" + "Processamento automático do vídeo após upload" — transversal to the processing pipeline (draft → processing → ready/error reflected in the database)

**Context:** The video row is created before any byte is uploaded and mutates as the pipeline advances. The state machine, its transitions, and what happens when FFmpeg fails must be explicit — the challenge grades "ciclo de status refletido no banco".

**Options:**

### Option A: Single enum status column + bounded retries + terminal failure state
- `status ENUM('draft','uploading','processing','ready','failed')` (exact set defined in the plan's Data Model) on the videos table; transitions: draft/uploading at pre-register+upload, processing when the job starts, ready on success, failed after queue retries are exhausted (e.g., 3 attempts, exponential backoff), storing a failure reason column. Re-processing = re-enqueue, back to processing.
- **Pros:** one source of truth, trivially queryable (`WHERE status`); retry policy delegated to the queue (TD-01); terminal `failed` + reason satisfies the error-cycle criterion; simple to test.
- **Cons:** no per-transition history (only current state).

### Option B: Status column + separate transition/event log table
- Same enum plus an append-only `video_status_events` table.
- **Pros:** full audit trail; debuggable pipeline.
- **Cons:** extra table/writes with no Phase 03 requirement consuming it; widens migration and test surface — YAGNI for this phase.

### Option C: Minimal two-state model (draft/ready) without failure state
- Treat failures as "still draft".
- **Pros:** smallest possible model.
- **Cons:** cannot distinguish "user never uploaded" from "processing exploded"; fails the explicit "rascunho → processando → pronto/erro" acceptance criterion.

**Recommendation:** Option A (enum + queue-managed retries + terminal failed state with reason) — matches the graded lifecycle exactly, leans on BullMQ's native retry/backoff instead of hand-rolled logic, and keeps the schema lean; an event log (Option B) can be added in a future phase if operational need appears.

**Decision:** **A (enum + queue-managed retries + terminal failed state)**

---

## TD-08: Object Storage Layout and Access Policy (MinIO/S3 usage)

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)" — the storage itself is fixed (S3-compatible / MinIO); this TD decides bucket/key organization and access policy.

**Context:** The challenge fixes S3-compatible storage (MinIO in dev). Open sub-decisions: bucket topology, key naming, and whether objects are ever public. Key layout is a contract between API (writes/presigns) and worker (reads video, writes thumbnail).

**Options:**

### Option A: Single private bucket, prefix-per-content-type, id-based keys
- One bucket (e.g., `streamtube`), keys `videos/{videoId}/original.{ext}` and `thumbnails/{videoId}.jpg`. Bucket private; all access via presigned URLs. Bucket auto-created on startup/init container.
- **Pros:** one bucket to provision/configure (CORS, lifecycle); keys derivable from the video row without extra columns beyond stored keys; private-by-default matches presigned strategy (TD-02/TD-06).
- **Cons:** mixed content types share quotas/policies; per-type lifecycle rules need prefix filters.

### Option B: Two buckets (`videos`, `thumbnails`)
- Separate buckets per content type.
- **Pros:** per-type policies trivially (e.g., public thumbnails); isolation.
- **Cons:** double provisioning/CORS/config; cross-bucket consistency in the worker; no Phase 03 requirement demands different policies yet.

### Option C: Single bucket with public-read thumbnails
- Same as A but thumbnails prefix is public.
- **Pros:** thumbnail `<img>` URLs without presigning.
- **Cons:** mixed ACL model on one bucket invites misconfiguration; presigning thumbnails is cheap; public access can be revisited when the UI phase actually consumes thumbnails.

**Recommendation:** Option A (single private bucket, prefixed keys) — smallest configuration surface for Compose/tests, fully consistent with the presigned-only access model, and nothing in Phase 03 needs public objects or per-type policies.

**Decision:** **A (single private bucket, prefixed keys)**

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | A (BullMQ + Redis) | **A (BullMQ + Redis)** |
| TD-02 | Cross-layer | 10GB Upload Strategy | A (Presigned multipart direct to storage) | **A (Presigned multipart)** |
| TD-03 | Backend | Video Worker Execution Model | A (Separate container, same codebase) | **A (Separate container, same codebase)** |
| TD-04 | Backend | FFmpeg/ffprobe Invocation | A (apt binaries + direct spawn) | **A (apt binaries + direct spawn)** |
| TD-05 | Backend | Unique Video URL Identifier | A (nanoid v3, 11 chars, unique index) | **A (nanoid v3)** |
| TD-06 | Cross-layer | Streaming & Download Delivery | A (Presigned GET + 302 redirect) | **A (Presigned GET + 302 redirect)** |
| TD-07 | Backend | Status Lifecycle & Failure Handling | A (enum + queue retries + terminal failed) | **A (enum + queue retries + terminal failed)** |
| TD-08 | Backend | Storage Layout & Access Policy | A (single private bucket, prefixed keys) | **A (single private bucket, prefixed keys)** |
