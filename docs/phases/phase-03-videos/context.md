---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-06T04:21:56-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-06T04:48:45-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-08-06T04:21:56-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-06T04:21:56-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-06T04:21:55-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, categorias, visibilidade público/unlisted, fluxo rascunho→publicação, painel de gerenciamento do canal (Fase 04); player de reprodução, página de visualização, sugestões, contagem de visualizações (Fase 05); comentários, likes, inscrições (Fase 06); qualquer tela de upload/gerenciamento de vídeo no frontend.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — telas de upload, player e gerenciamento de vídeo ficam diferidas para `Fase 04 — Gerenciamento de Vídeos e Canal` e `Fase 05 — Página de Visualização do Vídeo` (`docs/project-plan.md`). No open decision in this document (see `_Subprojects in scope_` note in the decisions doc).

**Sequencing notes:** Depends on Fase 01 (configuração base — Docker Compose, config namespaces, migrations) and Fase 02 (auth — JWT guard, domain exception filter, rate limiting, channel entity that videos attach to).

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta** (prior)
- **Fase 04 — Gerenciamento de Vídeos e Canal** (next)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | A (BullMQ) | `@nestjs/bullmq`, `bullmq` |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client & Key Organization | decided | A (`@aws-sdk/client-s3` + presigner, per-videoId keys) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Large File Upload Strategy (10GB) | decided | A (S3/MinIO Multipart Upload via presigned part URLs) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Metadata Extraction & Thumbnail Generation | decided | A (`fluent-ffmpeg`) | `fluent-ffmpeg`, `@types/fluent-ffmpeg` (dev) |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle & Failure Handling | decided | A (Linear 4-state machine) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier Strategy | decided | B (`nanoid`) | `nanoid` |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Media Delivery Strategy (Streaming & Download) | decided | A (Presigned GET URL, direct client↔storage) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ — the architecture diagram already treats the queue as its own container regardless of choice, so the "no new infra" advantage of a Postgres-native queue is smaller than it looks. BullMQ's NestJS-native module, built-in backoff, and `jobId` dedup directly satisfy this phase's idempotent-retry requirements with the least custom code.

**Reconsideration:** RabbitMQ was picked first, then reverted to BullMQ after `library-refs.md` showed RabbitMQ needs a hand-built DLX + bounded-redelivery mechanism to get the same retry guarantee BullMQ provides natively — not worth the extra build/test surface for a wash on infra cost (Redis vs. RabbitMQ, both new).

**Resolution:** BullMQ's native `attempts`/`backoff` on `Queue.add()` — no custom retry code. After the last attempt, the worker's `catch` transitions the video to `error`.

**Libraries:** `@nestjs/bullmq`, `bullmq`

### phase-03-videos/TD-02

**Recommendation:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — the one client that is simultaneously correct against MinIO today (via `forcePathStyle` + custom `endpoint`) and against production AWS S3 tomorrow with no code change. Keys are scoped by `videoId` only, one bucket per asset type (`videos-source`, `videos-thumbnails`).

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-03

**Recommendation:** S3/MinIO Multipart Upload via presigned part URLs — the only option that satisfies the hard 5GB single-object PUT ceiling without adding a new infrastructure component, and it directly answers the project's explicit resumability requirement at part granularity.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-04

**Recommendation:** `fluent-ffmpeg` — covers both metadata extraction (`ffprobe()`) and thumbnail generation (`screenshots()`) with a documented, purpose-built API; native FFmpeg performance is required at the file sizes this phase handles. The worker must download the source object to local disk before invoking FFmpeg (percentage-based thumbnail timestamps require a file path, not a remote stream) — implies scratch disk sized for the largest expected source file on the worker container.

**Resolution:** thumbnail captured at 10% of video duration (`screenshots({ timestamps: ['10%'] })`), avoiding black/intro frames at `0s`.

**Libraries:** `fluent-ffmpeg`, `@types/fluent-ffmpeg` (dev); system `ffmpeg`/`ffprobe` binaries in the worker's Docker image (not an npm dependency)

### phase-03-videos/TD-05

**Recommendation:** Linear 4-state machine (`draft → processing → ready | error`) — matches the phase's own capability wording; transient-failure retry is delegated entirely to the queue layer (TD-01).

**Note:** Retry/backoff for the transient-failure case is BullMQ's native `attempts`/`backoff` (TD-01) — this does not change the 4-state model itself; `error` is only reached after TD-01's retry budget is exhausted.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** `nanoid` — matches the genre's short-URL convention, decouples the public identifier from the primary key (minor IDOR-hardening side benefit), needs only a `UNIQUE` column plus regenerate-on-conflict.

**Libraries:** `nanoid`

### phase-03-videos/TD-07

**Recommendation:** Presigned GET URL, direct client↔storage — matches what `docs/diagrams/software-arch.mermaid` already commits to (`frontend --Streams--> storage`), keeps the API off the hot path exactly like the upload strategy (TD-03), and gets correct `Range`/`206` behavior for free from the storage layer.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (same client as TD-02)

## Inherited Decisions Detail

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) recommended; diverged in implementation.

**Note:** Decision deliberately diverged from the Recommendation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — strongest security model with automatic theft detection, no new infra since PostgreSQL is already in the stack.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — revocable, decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — best NestJS integration, SMTP-based (matches Mailpit locally, any SMTP provider in production).

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — documented NestJS approach, no shared schemas with frontend needed.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes `{ statusCode, error, message }`, reused by every endpoint from Phase 02 onward, including Phase 03's video endpoints.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — native NestJS guard/decorator integration, scoped per module via `APP_GUARD`.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) recommended; diverged in implementation.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — strict `[a-z0-9_]` allowlist with `user_<random>` fallback for nickname generation. Not directly reused by Phase 03, kept for completeness of inherited channel/user context.

**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — official, `registerAs()` namespaced factory pattern. Phase 03 adds its own namespaces (e.g., `storage`, `queue`) following the same pattern.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — first-class integration with `@nestjs/config` via `validationSchema`. Phase 03's new environment variables (storage endpoint/credentials, queue connection) extend the same Joi schema.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the same factory pattern; not directly relevant to Phase 03 beyond the existing `databaseConfig` reuse.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Domain errors extend a `DomainException` base class (`errorCode: string`, `httpStatus: number`); a global `@Catch(DomainException)` filter maps them to `{ statusCode, error, message }` — new Phase 03 domain exceptions (e.g., video-not-found, upload-not-in-progress) follow the same base class instead of throwing raw NestJS `HttpException`s. _(from phase 02)_
- Request DTOs use `class-validator` decorators; the global `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true, transform: true`) rejects unknown/invalid payloads before they reach services. _(from phase 02)_
- Each domain gets its own module exporting `TypeOrmModule` (or its own service) so other modules inject repositories/services through the module boundary, never by reaching into another domain's internals directly — established by the `ChannelsModule` extraction in SI-02.15. Applies to the new `VideosModule` (and any `StorageModule`/`QueueModule` split). _(from phase 02)_
- One migration per schema-owning SI, generated via `npm run migration:generate` and reviewed before commit — never hand-written from scratch. _(from phase 02)_
- `@Public()` decorator + reflector-based check opts a route out of the global `JwtAuthGuard`; every other route requires authentication by default — Phase 03's video endpoints require auth unless explicitly marked otherwise. _(from phase 02)_
- Rate limiting is scoped per-module via `ThrottlerModule.forRoot([...])` imported inside the owning module (not globally in `AppModule`), with `APP_GUARD` registered in that module's providers. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/` (entities → integration; services with branching → unit + integration; services with a side-effect dependency like storage → integration against a real capture/adapter; modules → unit compilation test; controllers/DTOs → E2E only; filters → unit + E2E). Phase 03 introduces two artifact types not covered by the existing guide table: a **queue publisher/consumer** (RabbitMQ) and a **worker entrypoint** process. Per the project's testing policy (no mocking what can be exercised against real Compose infra), these should be tested with integration tests against the real `rabbitmq` service — publish a job from the API side, assert the worker consumer processes it end-to-end (including real MinIO read/write and a real FFmpeg run against a small fixture video) rather than mocking the broker or FFmpeg. Exact layer boundaries (what is unit vs. integration for the worker's internal steps) are resolved per-SI in `phase-03-videos.md`.
