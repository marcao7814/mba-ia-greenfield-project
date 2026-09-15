# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, container port `3000` mapped to host port `3001` (host `3000` may be occupied by another local service — always verify via `docker compose port nestjs-api 3000` rather than assuming)
- `video-worker` — background video processing worker (FFmpeg), no exposed port — consumes the `video-processing` BullMQ queue
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture for local email testing, SMTP port `1025`, Web UI port `8025`
- `minio` — S3-compatible object storage, API port `9000`, console port `9001`, user/password `streamtube`/`streamtube123`
- `redis` — BullMQ broker, port `6379`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3001

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3001
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos Module (Phase 03)

Upload, background processing, and delivery of videos, scoped to the authenticated user's channel. Module lives in `src/videos/` (entity, repository, service, controller, DTOs) plus `src/videos/workers/video-processing.processor.ts` (the FFmpeg consumer), `src/storage/` (S3/MinIO client), and `src/queue/` (BullMQ registration). Decisions and full contracts: `docs/decisions/technical-decisions-phase-03-videos.md` and `docs/phases/phase-03-videos/phase-03-videos.md`.

### Endpoints (all under `/channels/:channelId/videos`, JWT + `OwnedChannelGuard`)

| Method & path | Purpose |
|---|---|
| `POST /uploads` | Creates a draft video, starts an S3/MinIO multipart upload, returns `{ videoId, slug, uploadId }` |
| `GET /uploads/:uploadId/parts/:partNumber` | Presigned URL for uploading one multipart part directly to storage |
| `POST /:videoId/uploads/complete` | Finalizes the multipart upload, validates the real size against the declared `fileSizeBytes`, transitions the video to `processing`, enqueues the `video.process` job |
| `GET /:videoId` | Current video status (`draft` \| `processing` \| `ready` \| `error`) — safe to poll |
| `GET /:videoId/stream` | Presigned GET URL (1h TTL) that supports HTTP `Range` requests (`206 Partial Content`) |
| `GET /:videoId/download` | Presigned GET URL (5min TTL) for the full file — only when `status = ready` |

The client never sends video bytes through the API — files go straight to MinIO/S3 via the presigned part URLs, which is how a 10GB upload doesn't block the API process.

### Storage (`src/storage/storage.service.ts`)

`StorageService` wraps an `S3Client` (`forcePathStyle: true`, MinIO-compatible) and exposes multipart upload (`createMultipartUpload` / `presignUploadPart` / `completeMultipartUpload`), `headObject`, `createPresignedGetUrl`, `uploadObject`, and `downloadObjectToFile` (used by the worker to pull the source file locally for FFmpeg). Buckets: `videos-source` and `videos-thumbnails` (env `STORAGE_BUCKET_SOURCE` / `STORAGE_BUCKET_THUMBNAILS`), auto-created on module init. Object keys are scoped by `videoId`, never by `channelId` (`{videoId}/source`, `{videoId}/thumbnail.jpg`).

### Queue and Worker

BullMQ queue `video-processing` (`src/queue/queue.module.ts`, Redis-backed). `VideosService.completeUpload` enqueues a `video.process` job (`{ videoId, storageKey }`, `jobId: videoId` for producer-side dedup, 3 attempts with exponential backoff). The Video Worker is a separate process (`src/worker.main.ts` / `src/worker.module.ts`, run via `npm run start:worker` / `start:worker:dev`, `video-worker` Compose service) — it has no HTTP server, only consumes the queue. `VideoProcessingProcessor` (`src/videos/workers/video-processing.processor.ts`) downloads the source object to a temp file, extracts duration/codec/resolution/bitrate via `ffprobe`, generates a thumbnail at 10% duration via `ffmpeg`, uploads the thumbnail, and marks the video `ready` — or `error` (with a closed `error_reason` code: `PROCESSING_FAILED`, `TIMEOUT`) on failure. FFmpeg/ffprobe are installed in `Dockerfile.dev`; timeout is `FFMPEG_TIMEOUT_MS` (default 120000ms).

### Status lifecycle

`draft` → `processing` (atomic, conditional `UPDATE ... WHERE status = 'draft'`, guards against double-completion) → `ready` | `error`. A declared/actual size mismatch at completion reverts the video to `draft` instead of advancing it.
