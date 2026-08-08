---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-06
scope_description: "Backend foundation for video upload and processing: background job queue, object storage client and key strategy, large-file (10GB) upload protocol, metadata/thumbnail extraction, video status lifecycle, unique URL identifier, and streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns every capability of this phase: video module, object storage client, background queue, worker (metadata extraction + thumbnail generation), video status lifecycle, unique URL, streaming and download delivery.
- `next-frontend/` — Frontend deferred: video upload UI, player and video management screens are owned by `Fase 04 — Gerenciamento de Vídeos e Canal` and `Fase 05 — Página de Visualização do Vídeo` (`docs/project-plan.md`). No open decision in this document.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` already fixes a `Message Queue` container between the API and the `Video Worker` container, with the technology marked `TBD`. The API must enqueue a processing job the moment an upload is confirmed and return immediately (RNF: does not block the request); the worker consumes it independently, possibly retrying on transient failure (e.g., FFmpeg crash, temporary storage timeout). This is the phase's central open stack decision per the assignment brief.

**Options:**

### Option A: BullMQ (Redis-backed)
- Redis-backed queue with official NestJS integration (`@nestjs/bullmq`). Producer side: `Queue.add()` with `attempts`/`backoff` for automatic retries and an optional `jobId` that BullMQ treats as an idempotency key — re-adding a job with an existing `jobId` is silently ignored (confirmed via BullMQ's current docs). Worker side: `@Processor` + `WorkerHost` class consumes jobs; job-level timeouts are implemented with `AbortController` inside the processor (there is no built-in `job.opts.timeout`).
- **Pros:** First-class NestJS module (`BullModule.registerQueue`, `@Processor`/`WorkerHost`), mature and widely used for exactly this kind of workload (video/image processing pipelines), built-in exponential backoff, `jobId`-based dedup covers the idempotent-enqueue concern for free, active maintenance.
- **Cons:** Introduces Redis as a brand-new infrastructure dependency — nothing in the current stack uses it (`nestjs-project/compose.yaml` only has `api`, `db`, `mailpit`). One more container to run, monitor, and persist (append-only file or RDB) in Compose.

### Option B: pg-boss (PostgreSQL-backed)
- Queue implemented entirely on top of PostgreSQL (`SKIP LOCKED` polling + `LISTEN/NOTIFY`), no external broker. Jobs are rows in a table it manages; retry count, backoff and dead-letter handling are configured per queue.
- **Pros:** Zero new infrastructure — PostgreSQL is already the project's only stateful dependency (`db` service, already in Compose). One less moving part to operate for a single-instance Docker Compose deployment like this project's.
- **Cons:** No official NestJS wrapper (would need a thin custom module around the `pg-boss` client). Polling-based dispatch has higher latency than Redis' push-based `BRPOPLPUSH`/blocking-list model (usually low hundreds of ms, immaterial for video processing but a real trade-off). Smaller ecosystem/community than BullMQ for this specific "media processing worker" use case.

### Option C: RabbitMQ (`amqplib` / `@golevelup/nestjs-rabbitmq`)
- Dedicated AMQP message broker. NestJS integrates via `@golevelup/nestjs-rabbitmq` (RPC + pub/sub decorators) or the built-in `@nestjs/microservices` RMQ transport.
- **Pros:** Battle-tested, general-purpose broker, strong routing/exchange model if the platform later needs multiple consumer types or cross-service messaging beyond video processing.
- **Cons:** Heaviest option for the current need — the phase only requires a single producer (API) → single consumer (Video Worker) pipeline; RabbitMQ's exchange/routing model is unused complexity here. New infra dependency, same cost as Option A without a corresponding NestJS-native ergonomics win for this specific job-queue use case (BullMQ is designed specifically for job queues; RabbitMQ is a general message broker).

**Recommendation:** **Option A (BullMQ)** — the architecture diagram already treats the queue as its own container regardless of choice, so Option B's "no new infra" advantage is smaller than it looks (Compose already grows by one service either way it is only a question of *which* new container). BullMQ's NestJS-native module, built-in backoff, and `jobId` dedup directly satisfy this phase's idempotent-retry requirements with the least custom code, and it is the dominant choice for exactly this workload (background media processing) in the NestJS ecosystem.

**Decision:** A (BullMQ)

**Reconsideration (post-`/plan-resolve`):** Decision C (RabbitMQ) was tried first, then reverted back to the Recommendation (BullMQ) after `library-refs.md` made the concrete cost of RabbitMQ visible — `@golevelup/nestjs-rabbitmq` has no `attempts`/`backoff` equivalent, so IC-1's retry/backoff requirement would have needed a hand-built dead-letter-exchange + bounded-redelivery mechanism (see the superseded resolution previously here, now replaced). BullMQ's native `attempts`/`backoff`/`jobId` dedup close IC-1 for free, at the cost of Redis instead of RabbitMQ as the new infrastructure component — a wash on infra cost, but materially less custom retry code to build and test. Consumed via `@nestjs/bullmq` (official NestJS wrapper around `bullmq`) in the API (producer, `Queue.add()`) and the Video Worker (`@Processor`/`WorkerHost`).

**Resolution (`/plan-resolve`, closes `validation.md` IC-1):** retry mechanism is BullMQ's built-in `attempts: N` + `backoff: { type: 'exponential', delay }` on `Queue.add()` — no custom dead-letter/requeue code needed. After the last attempt still fails, BullMQ marks the job `failed` (inspectable via `queue.getFailed()` if a dashboard is added later) and the worker's `catch` block transitions the video's status to `error` (TD-05) before letting the error propagate for BullMQ's own bookkeeping.

---

## TD-02: Object Storage Client & Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The object storage technology itself is not open — `docs/diagrams/software-arch.mermaid` fixes it as `S3 or MinIO`, run locally as MinIO (S3-compatible) per the assignment brief, swapped for real S3 in production. What is open is (1) which client library talks to it, and (2) how buckets/keys are organized, since both are cross-component contracts (referenced by the video entity's `storage_key`/`thumbnail_key` columns, the upload flow, and the worker).

**Options:**

### Option A: `@aws-sdk/client-s3` (AWS SDK v3) + `@aws-sdk/s3-request-presigner`
- Official AWS SDK, modular v3 architecture. `S3Client` configured with a custom `endpoint` + `forcePathStyle: true` talks to MinIO unmodified; the same client talks to real AWS S3 in production by only changing `endpoint`/credentials. `getSignedUrl(client, command, { expiresIn })` (from `s3-request-presigner`) generates presigned `PutObjectCommand`/`GetObjectCommand`/multipart-part URLs.
- **Pros:** Officially supported by AWS, the exact client the production swap (S3) needs — zero code change when moving from MinIO to AWS S3, only config. First-class TypeScript types. `@aws-sdk/lib-storage`'s `Upload` helper is available for any server-side upload path (e.g., worker re-uploading a generated thumbnail).
- **Cons:** More verbose command-object API (`new PutObjectCommand({...})`) than a purpose-built MinIO client's convenience methods.

### Option B: `minio` (official MinIO JS SDK)
- MinIO's own client, with convenience methods (`presignedPutObject`, `presignedGetObject`) and a simpler surface.
- **Pros:** Slightly simpler API for the common presigned-URL case, maintained by MinIO directly.
- **Cons:** Built and documented against MinIO's server semantics — using it against real AWS S3 in production (the explicit target per the assignment) is not the officially supported path, reintroducing exactly the client-swap risk the brief says to avoid designing for.

### Option C: `s3-lite-client`
- Lightweight, dependency-free S3-compatible client for any runtime (Node, Deno, Bun).
- **Pros:** Minimal footprint, no AWS SDK weight.
- **Cons:** Smaller community/maturity than the official AWS SDK, no bundled multipart-upload helper equivalent to `@aws-sdk/lib-storage`, less alignment with "the production target is real S3."

**Recommendation:** **Option A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)** — it is the one client that is simultaneously correct against MinIO today (via `forcePathStyle` + custom `endpoint`) and against production AWS S3 tomorrow with no code change, which is exactly the swap the assignment describes. The verbosity trade-off (Option B) is minor compared to avoiding a client-migration risk at production cutover.

**Key organization (part of this decision, not a separate TD):** one bucket per asset type (`videos-source`, `videos-thumbnails`) rather than a single bucket with type-prefixed keys — keeps lifecycle policies (e.g., future cold-storage rules for source files) and access policies independent per asset type. Object keys are scoped by `videoId` only (`{videoId}/source.<ext>`, `{videoId}/thumbnail.jpg`) — **not** by `channelId` — since the DB is already the source of truth for video→channel ownership; embedding the owner ID in the storage key would leak it into any log, error message or presigned-URL path that surfaces the key.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, per-videoId keys, one bucket per asset type)

---

## TD-03: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** `docs/project-plan.md` §4 explicitly calls out that the upload "precisa ser feito de forma que não trave o sistema **e permita retomar em caso de falha de conexão**" (resumability on connection failure is an explicit point of attention, not just "don't block the API"). This also has a hard technical ceiling: both AWS S3 and MinIO reject a single `PutObject` request body larger than **5GB** — so for a 10GB file, a single whole-file upload is not just undesirable, it is technically invalid regardless of who initiates it (API or client). Depends on TD-02 (storage client).

**Options:**

### Option A: S3/MinIO Multipart Upload via presigned part URLs
- Client-orchestrated multipart flow: API calls `CreateMultipartUploadCommand` and returns the `uploadId` plus a set of presigned `UploadPartCommand` URLs (or an endpoint the client calls per-part as it progresses); the client `PUT`s each part (e.g., 25–100MB) directly to storage; the client then calls an API endpoint that issues `CompleteMultipartUploadCommand`. The video binary never passes through the NestJS process.
- **Pros:** Satisfies the 5GB single-object ceiling by construction (parts are well under it; up to 10,000 parts of up to 5GB each). Resumable at part granularity — a dropped connection only requires re-uploading the current part, not the whole file, directly addressing the "retomar em caso de falha" requirement. No new infrastructure component — reuses the storage decided in TD-02.
- **Cons:** More orchestration than a single PUT — API must track `uploadId`/part ETags and the client must implement the multi-request sequence (or a client library that does).

### Option B: `tus` resumable protocol
- Open resumable-upload protocol (byte-offset based, not part-based). Requires a `tus` server component — either `tusd` (Go binary, has an S3 storage backend) or a Node `@tus/server` middleware — sitting in the upload path.
- **Pros:** Finer-grained resumability than Option A (resumes mid-part, at the exact byte offset, not just from the start of the current part). Rich client ecosystem (Uppy and others implement `tus` natively).
- **Cons:** Adds a new always-on server component (`tusd` or a Node process) that the bytes flow through — reintroducing a process in the upload path that Option A avoids entirely. That process still ends up writing to S3/MinIO via its own multipart logic under the hood, so it does not remove the multipart mechanics, it adds a layer in front of them.

### Option C: Single presigned `PutObject` (whole file, one request)
- One presigned PUT URL for the entire file, uploaded in a single HTTP request directly to storage.
- **Pros:** Simplest possible client implementation — one request.
- **Cons:** **Not viable for this phase's 10GB requirement** — exceeds the 5GB single-object PUT limit enforced by S3 and MinIO. Even disregarding the size ceiling, a single unresumable multi-gigabyte request is exactly the fragile pattern `project-plan.md` warns against (no recovery from a dropped connection short of restarting the entire transfer). Included here only to document why it is rejected, not as a real candidate.

**Recommendation:** **Option A (S3/MinIO Multipart Upload via presigned part URLs)** — it is the only option that satisfies the hard 5GB technical ceiling without adding a new infrastructure component, and it directly answers the project's explicit resumability requirement at a reasonable granularity (per-part, not per-byte). Option B's finer resumability is a real advantage but is not worth a dedicated new server process for a Docker Compose–scale project when Option A already clears both the size constraint and the resumability requirement.

**Decision:** A (S3/MinIO Multipart Upload via presigned part URLs)

---

## TD-04: Video Metadata Extraction & Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker needs to (1) extract duration/technical metadata and (2) generate a thumbnail from a frame, both via FFmpeg/ffprobe. The choice is how the worker process invokes FFmpeg.

**Options:**

### Option A: `fluent-ffmpeg`
- Fluent JS API wrapping the system `ffmpeg`/`ffprobe` binaries via `child_process`. `ffmpeg(path).ffprobe(cb)` returns structured `streams`/`format` metadata (duration, codec, resolution, bitrate); `.screenshots({ timestamps, folder, size })` generates thumbnail files from specific timestamps or percentages.
- **Pros:** Both capabilities this phase needs (`ffprobe()` metadata, `screenshots()` thumbnail) are first-class, documented methods — no argument-string hand-rolling or stdout-parsing. Mature, widely used in Node video-processing pipelines. Works with system FFmpeg, so codec/format support matches whatever the worker image ships (no WASM feature ceiling).
- **Cons:** Requires the FFmpeg/ffprobe binaries present in the worker's container image (a Dockerfile concern, not a library concern). `screenshots()`'s percentage-based timemarks require probing duration first from **a file path, not a stream** (per the library's own docs) — the worker must download the source object to local disk before generating a thumbnail; it cannot operate on a bare remote URL/stream for percentage-based timestamps.

### Option B: Direct `child_process.spawn('ffmpeg', [...])` / `ffprobe`
- Hand-roll the FFmpeg/ffprobe invocations: build the argument array, spawn the process, parse stdout/stderr manually (ffprobe's `-print_format json` output, ffmpeg's screenshot output files).
- **Pros:** Zero dependency beyond Node's built-in `child_process`. Full control over exact flags.
- **Cons:** Reimplements what `fluent-ffmpeg` already provides (argument building, JSON parsing, timestamp computation) with no material benefit — pure extra maintenance surface for this phase's straightforward needs.

### Option C: `@ffmpeg/ffmpeg` (ffmpeg.wasm)
- WebAssembly build of FFmpeg, runs in-process (no system binary, no `child_process`).
- **Pros:** No native binary dependency in the worker image.
- **Cons:** Designed for browser/lightweight use; WASM throughput is well below native FFmpeg for large files, and processing files up to 10GB server-side is exactly the scenario it is not built for. Would materially slow down worker throughput compared to native FFmpeg.

**Recommendation:** **Option A (`fluent-ffmpeg`)** — covers both extraction and thumbnail generation with a documented, purpose-built API, and native FFmpeg performance is required at the file sizes this phase handles (ffmpeg.wasm is not a realistic candidate at 10GB). The worker downloading the source object to local disk before invoking FFmpeg (required for percentage-based thumbnail timestamps regardless of wrapper choice, per Option A's Cons) is a worker-implementation detail resolved at build time, not a further open decision — it does imply the worker container needs local scratch disk sized for the largest expected source file.

**Decision:** A (`fluent-ffmpeg`)

**Resolution (`/plan-resolve`, closes `validation.md` AMB-1):** thumbnail frame timestamp decided as **10% of the video's duration** (via `screenshots({ timestamps: ['10%'] })`), avoiding black/intro frames at `0s`. Requires probing duration via `ffprobe()` first, which is already required by this TD's metadata-extraction half — no extra I/O beyond what TD-04 already does.

---

## TD-05: Video Status Lifecycle & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The assignment brief explicitly calls out "o ciclo de status do vídeo e o que acontece em caso de falha no processamento" as a decision to make and justify — not an implementation detail. It determines what state a video is in at every point between upload start and playable-ready, and how a processing failure surfaces.

**Options:**

### Option A: Linear 4-state machine — `draft → processing → ready | error`
- The video row is created as `draft` the instant upload is initiated (TD-03). On upload completion the API transitions it directly to `processing` and enqueues the job (TD-01) in the same operation. The worker transitions to `ready` on success or `error` on terminal failure (after BullMQ's `attempts`/`backoff` — TD-01 — are exhausted). `error` is terminal for that upload; recovering means starting a new upload.
- **Pros:** Simplest model — 4 states map directly to the phase's own vocabulary. Retries are fully delegated to the queue layer (TD-01), so this state machine does not need its own retry bookkeeping. Easy to reason about and test (4 states, 4 valid transitions).
- **Cons:** No distinction between "upload confirmed, waiting in queue" and "worker actively processing" — both are `processing`. No path to retry a specific failed video without a brand-new upload.

### Option B: 5-state machine — adds `uploaded` between `draft` and `processing`
- `draft → uploaded → processing → ready | error`. `uploaded` is set the instant upload completes (before the job is picked up by a worker); `processing` is set only when the worker actually starts the job.
- **Pros:** Gives observability into queue backlog (videos stuck in `uploaded` for a long time signal worker capacity problems) distinct from "a worker is actively failing on this file."
- **Cons:** In this design, enqueue happens synchronously right after upload confirmation (TD-03's `CompleteMultipartUpload` handler calls `queue.add()` in the same request) — so `uploaded` and `processing` differ only for the (typically sub-second, at most few-second) time a job sits in queue before a worker picks it up. Extra state for a distinction with little practical signal in a single-worker Compose setup.

### Option C: Retryable error — `error` carries a re-enqueue path
- Same as Option A, but `error` is not fully terminal: an explicit action can transition `error → processing` again, re-running the same job without requiring a new upload (source file is still in storage).
- **Pros:** Recovers from transient failures (e.g., a worker crash unrelated to the file itself) without forcing the user to re-upload a 10GB file.
- **Cons:** Needs an explicit trigger (who calls it — a user action, an admin action, or automatic?) that is undefined by this phase's scope (no video-management UI exists yet — that's Fase 04). Introducing a manual-retry capability without a corresponding UI/endpoint consumer is premature for this phase.

**Recommendation:** **Option A (4-state machine)** — it matches the phase's own capability wording, is fully covered by BullMQ's built-in retry/backoff (TD-01) for the transient-failure case, and avoids building a manual-retry surface (Option C) that has no consumer until Fase 04's video-management panel exists. Option B's extra state is a reasonable future refinement once the system has more than one worker and queue depth becomes an operational concern, but is not justified for this phase's scope.

**Decision:** A (Linear 4-state machine — `draft → processing → ready | error`)

**Note:** Retry/backoff for the transient-failure case is BullMQ's native `attempts`/`backoff` (TD-01) — `error` is only reached after BullMQ's retry budget is exhausted, at which point the worker's `catch` block performs the transition explicitly.

---

## TD-06: Unique Video URL Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a public identifier that appears in its URL, is guaranteed unique, and does not need to be the same as its internal database primary key.

**Options:**

### Option A: Reuse the UUID v4 primary key as the public identifier
- The video's own PK (a standard UUID v4, matching the rest of the schema's convention) doubles as the URL segment.
- **Pros:** Zero extra column, zero extra generation logic — reuses TypeORM's default PK strategy already used elsewhere in the schema.
- **Cons:** UUIDs are 36 characters — noticeably longer than the short IDs video platforms conventionally use in URLs (e.g., YouTube's 11-character `v=` ids), which is a usability/shareability regression with no offsetting benefit here.

### Option B: `nanoid` — short, URL-safe random ID in a dedicated column
- Generate a separate short identifier (e.g., 12 characters, URL-safe alphabet) at video-creation time, stored in a `slug`/`public_id` column distinct from the PK.
- **Pros:** Short, shareable URLs matching the genre convention. Decouples the public identifier from the internal PK (the PK is never exposed), which is also a minor IDOR-hardening side benefit — an attacker cannot enumerate videos by incrementing/guessing a PK-shaped value in the URL. Collisions are handled by the DB's `UNIQUE` constraint plus a regenerate-and-retry loop on the (very rare) conflict — no proactive existence check needed for typical collision odds at this ID length.
- **Cons:** One extra column and one extra generation step per video creation (trivial cost).

### Option C: Auto-incrementing integer + hashids-style obfuscation
- A sequential integer ID reversibly encoded/decoded through an obfuscation library to look non-sequential in the URL.
- **Pros:** Compact, decodable without a DB round-trip if ever needed.
- **Cons:** Reversible obfuscation is not true uniqueness protection against enumeration (the encoding can be reversed or brute-forced) and adds a new dependency + shared-secret management (the obfuscation salt) for a benefit Option B already provides more simply and more securely (truly random, not just obfuscated-sequential).

**Recommendation:** **Option B (`nanoid`)** — matches the genre's URL convention, decouples the public identifier from the primary key, and needs only a `UNIQUE` column plus regenerate-on-conflict, no proactive uniqueness check.

**Decision:** B (`nanoid`)

---

## TD-07: Media Delivery Strategy (Streaming & Download)

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Once a video is `ready` (TD-05), it needs to be playable via streaming (HTTP `Range`/`206 Partial Content`, no full download required) and downloadable in full. `docs/diagrams/software-arch.mermaid` already draws `Rel(frontend, storage, "Streams", "HTTPS")` — a direct frontend↔storage relationship, bypassing the API — which constrains this decision rather than leaving it fully open.

**Options:**

### Option A: Presigned GET URL, direct client↔storage
- The API's stream/download endpoints do no byte-proxying — they authorize the request and return a short-lived presigned `GetObjectCommand` URL (TD-02's client). The client (browser `<video>` element or a download click) requests that URL directly from storage. S3/MinIO natively serve `Range`/`206 Partial Content` on `GetObject` — no extra code needed for seeking/scrubbing.
- **Pros:** Matches the architecture diagram's already-drawn direct frontend↔storage relationship. Zero byte-proxying load on the API — consistent with why TD-03 keeps the upload path off the API too. Range/206 behavior is storage-native, not something this project has to implement or maintain.
- **Cons:** The API cannot inject per-request logic into the byte stream itself (e.g., dynamic watermarking) — not a requirement of this phase, but a constraint to be aware of for future phases.

### Option B: API proxies bytes with manual Range/206 handling
- The API reads the object from storage (`GetObjectCommand` with a `Range` header derived from the incoming request) and streams it back to the client via `StreamableFile`, implementing 206 handling itself.
- **Pros:** Centralizes access control and lets the API log/meter every byte served.
- **Cons:** Reintroduces exactly the API-as-bottleneck pattern TD-03 was designed to avoid for uploads — every play/seek/download request now flows the full video through the NestJS process. Duplicates Range/206 logic that storage already implements correctly and for free.

### Option C: CDN-fronted signed URL (e.g., CloudFront in front of S3)
- A CDN sits between the client and storage, serving cached signed URLs.
- **Pros:** Best latency/scalability at real production traffic, offloads storage egress.
- **Cons:** No CDN exists anywhere in this project's stack (local MinIO in Docker Compose has no CDN equivalent) — out of scope infrastructure for this phase; would need its own research when the project actually reaches a production deployment phase.

**Recommendation:** **Option A (Presigned GET URL, direct client↔storage)** — it is what the architecture diagram already commits to, it keeps the API off the hot path exactly like the upload strategy (TD-03) does, and it gets correct Range/206 behavior for free from the storage layer instead of reimplementing it.

**Decision:** A (Presigned GET URL, direct client↔storage)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ (Redis-backed) | A (BullMQ) |
| TD-02 | Backend | Object Storage Client & Key Organization | `@aws-sdk/client-s3` + presigner, per-videoId keys | A (`@aws-sdk/client-s3` + presigner, per-videoId keys) |
| TD-03 | Backend | Large File Upload Strategy (10GB) | S3/MinIO Multipart Upload via presigned part URLs | A (S3/MinIO Multipart Upload via presigned part URLs) |
| TD-04 | Backend | Video Metadata Extraction & Thumbnail Generation | `fluent-ffmpeg` | A (`fluent-ffmpeg`) |
| TD-05 | Backend | Video Status Lifecycle & Failure Handling | Linear 4-state machine (`draft → processing → ready|error`) | A (Linear 4-state machine) |
| TD-06 | Backend | Unique Video URL Identifier Strategy | `nanoid` short public ID | B (`nanoid`) |
| TD-07 | Backend | Media Delivery Strategy (Streaming & Download) | Presigned GET URL, direct client↔storage | A (Presigned GET URL, direct client↔storage) |
