---
kind: phase
name: phase-03-videos
test_specs_aware: false
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-06T04:52:28-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-08-06T04:53:07-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-06T04:48:45-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de vídeo de até 10GB sem travar a API (multipart via URLs pré-assinadas), processamento automático em background (extração de metadados + thumbnail via FFmpeg, consumido de uma fila BullMQ/Redis), URL única por vídeo (nanoid) e entrega por streaming/download (URL pré-assinada direto ao storage), com o ciclo de status `draft → processing → ready | error` persistido e a posse do vídeo (canal do usuário autenticado) validada em todo endpoint.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose

**Description:** Instalar as dependências de produção da Fase 03, criar os namespaces de configuração `storage` e `queue` seguindo o padrão `registerAs` da Fase 01, estender o schema Joi, e adicionar os serviços de infraestrutura novos (MinIO, Redis, Video Worker) ao Docker Compose.

**Technical actions:**

1. Instalar dependências em `nestjs-project`: `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `fluent-ffmpeg@^2.1.x`, `@types/fluent-ffmpeg@^2.1.x` (dev), `nanoid@^5.x` (per `phase-03-videos/TD-01`, `TD-02`, `TD-03`, `TD-04`, `TD-06`, `TD-07`; `library-refs.md`)
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` lendo `STORAGE_ENDPOINT` (string, obrigatório — ex.: `http://minio:9000`), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, obrigatório), `STORAGE_SECRET_KEY` (string, obrigatório), `STORAGE_BUCKET_SOURCE` (string, default `'videos-source'`), `STORAGE_BUCKET_THUMBNAILS` (string, default `'videos-thumbnails'`) (per `phase-03-videos/TD-02`)
3. Criar `src/config/queue.config.ts` — `registerAs('queue', ...)` lendo `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`) (per `phase-03-videos/TD-01`)
4. Atualizar `src/config/env.validation.ts` — adicionar todas as novas variáveis ao schema Joi (`STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` obrigatórias; demais com default). Atualizar `.env.example` com defaults compatíveis com o Compose
5. Adicionar a `nestjs-project/compose.yaml`: serviço `minio` (imagem `minio/minio`, comando `server /data --console-address ":9001"`, portas `9000`/`9001`, volume nomeado); serviço `redis` (imagem `redis:7-alpine`, porta `6379`, volume nomeado); serviço `video-worker` (mesmo `Dockerfile.dev` do `nestjs-api`, comando de entrypoint diferente — ver SI-03.4 — `depends_on: [db, redis, minio]`)

**Dependencies:** None

**Acceptance criteria:**

- Aplicação inicia sem erros com todas as novas variáveis de ambiente fornecidas — teste E2E existente (`GET /` retorna 200) continua passando
- Iniciar a aplicação sem `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY` ou `STORAGE_SECRET_KEY` causa erro de validação Joi no bootstrap — a app não inicia
- `docker compose ps` mostra `minio`, `redis` e `video-worker` com status `running`
- Console web do MinIO acessível em `localhost:9001`; Redis aceita conexões na porta `6379` dentro da rede Docker

---

### SI-03.2 — Video Entity and Migration

**Description:** Criar a entidade `Video` com o enum de status e o relacionamento com `Channel`, e gerar a migration correspondente.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `@Entity('videos')` com colunas: `id` (uuid PK gerado), `channel_id` (uuid, FK → channels.id), `title` (varchar(150), not null), `description` (text, nullable), `status` (enum: `'draft' | 'processing' | 'ready' | 'error'`, default `'draft'`), `slug` (varchar(12), unique, not null), `storage_key` (varchar, nullable), `thumbnail_key` (varchar, nullable), `upload_id` (varchar, nullable — S3 multipart `UploadId`), `duration_seconds` (int, nullable), `metadata` (jsonb, nullable), `error_reason` (varchar, nullable), `created_at`/`updated_at` (auto). Definir `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })`
2. Gerar migration via `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL gerado (colunas, constraints, índices)
3. Criar `src/videos/videos.module.ts` — `VideosModule` com `TypeOrmModule.forFeature([Video])` em imports, exports `TypeOrmModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique constraint em `slug`, `status` default `draft`, enum rejeita valor inválido, `channel_id` obrigatório, timestamps auto-populados |
| `src/videos/videos.module.spec.ts` | Unit | Módulo compila com `TypeOrmModule.forFeature` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, constraints e índices
- Inserir um vídeo com `slug` duplicado falha com violação de constraint unique
- Um vídeo recém-criado tem `status = 'draft'` por padrão
- Inserir um vídeo sem `channel_id` válido falha por violação de foreign key

---

### SI-03.3 — StorageService (Cliente S3/MinIO)

**Description:** Criar o serviço que encapsula o `S3Client` e expõe as operações de multipart upload e URLs pré-assinadas usadas pelo restante da fase.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — `StorageModule` global (`@Global()`), provider `StorageService`, `imports: [ConfigModule]`
2. Criar `src/storage/storage.service.ts` — `StorageService` injetando `storageConfig`. Constrói `S3Client` com `endpoint`, `region`, `forcePathStyle: true`, `credentials` (per `phase-03-videos/TD-02`; `library-refs.md`). Métodos: `createMultipartUpload(bucket, key): Promise<{ uploadId }>`, `presignUploadPart(bucket, key, uploadId, partNumber): Promise<{ url, expiresInSeconds }>`, `completeMultipartUpload(bucket, key, uploadId, parts): Promise<void>`, `headObject(bucket, key): Promise<{ sizeBytes }>`, `createPresignedGetUrl(bucket, key, expiresInSeconds): Promise<string>` (per `phase-03-videos/TD-03`, `TD-07`)
3. Criar `src/storage/storage.module.spec.ts` — teste de compilação do módulo

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | `createMultipartUpload` + `presignUploadPart` + upload real de uma parte + `completeMultipartUpload` recuperam o objeto no MinIO real; `headObject` retorna o tamanho correto; `createPresignedGetUrl` retorna URL que serve o objeto com suporte a `Range` |
| `src/storage/storage.module.spec.ts` | Unit | Módulo compila com `StorageService` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Uma parte enviada via URL pré-assinada de `presignUploadPart` e finalizada via `completeMultipartUpload` resulta em um objeto recuperável no bucket
- `headObject` de um objeto de N bytes retorna `sizeBytes = N`
- Uma requisição `Range` contra a URL de `createPresignedGetUrl` retorna `206 Partial Content` com o conteúdo parcial correto (validado contra o MinIO real do Compose)

---

### SI-03.4 — BullMQ Queue Module e Video Worker (esqueleto)

**Description:** Registrar a fila `video-processing` no BullMQ e criar o processo/entrypoint separado do Video Worker que a consome, sem lógica de processamento ainda (implementada na SI-03.8).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `QueueModule` importando `BullModule.forRootAsync` (inject `queueConfig.KEY`, `connection: { host, port }` a partir de `queueConfig`) e `BullModule.registerQueue({ name: 'video-processing' })`; exporta `BullModule` (per `phase-03-videos/TD-01`; `library-refs.md`)
2. Criar `src/worker.main.ts` — entrypoint separado do Video Worker: bootstrap de um `NestFactory.createApplicationContext(WorkerModule)` (sem HTTP), mantendo o processo vivo para consumir jobs
3. Criar `src/worker.module.ts` — `WorkerModule` importando `ConfigModule`, `TypeOrmModule` (mesma config do `AppModule`), `QueueModule`, `StorageModule`, `VideosModule`; providers: `VideoProcessingProcessor` (esqueleto — implementado na SI-03.8)
4. Atualizar `nestjs-project/package.json` — script `start:worker` (`nest start --entryFile worker.main`) e `start:worker:dev` (watch mode); atualizar o serviço `video-worker` do `compose.yaml` (SI-03.1) para rodar `npm run start:worker:dev`
5. Instalar FFmpeg/ffprobe no `Dockerfile.dev` usado pelo `video-worker` (`apt-get install -y ffmpeg`) (per `phase-03-videos/TD-04`; `library-refs.md`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker.module.spec.ts` | Unit | Módulo compila com `QueueModule`, `StorageModule`, `VideosModule` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose exec video-worker node -e "process.exit(0)"` confirma que o entrypoint do worker sobe sem erro (bootstrap de `WorkerModule` completa)
- `docker compose exec video-worker ffmpeg -version` e `ffprobe -version` retornam sucesso (binários instalados)
- API consegue publicar um job de teste na fila `video-processing` e o worker o recebe (visível via log; lógica de processamento ainda não implementada nesta SI)

---

### SI-03.5 — Channel Ownership Guard

**Description:** Criar um guard reutilizável que valida que o `:channelId` do path pertence ao usuário autenticado, fechando o gap de IDOR em que qualquer usuário logado poderia operar sobre o canal de outra pessoa apenas trocando o parâmetro da URL.

**Technical actions:**

1. Criar `src/channels/guards/owned-channel.guard.ts` — `OwnedChannelGuard implements CanActivate`. Injeta `Repository<Channel>`. Em `canActivate()`: extrai `channelId` do path param e `sub` (user id) de `request.user` (populado pelo `JwtAuthGuard` da Fase 02), consulta o canal por `id = channelId`, lança `ChannelNotOwnedException` (403) se o canal não existir ou seu `user_id` não for igual a `sub`
2. Criar `src/common/exceptions/channel-not-owned.exception.ts` — `ChannelNotOwnedException extends DomainException` com `errorCode = 'CHANNEL_NOT_OWNED'`, `httpStatus = 403` (segue o padrão `DomainException` da Fase 02)
3. Criar `src/videos/repositories/videos.repository.ts` — `VideosRepository` injetando `Repository<Video>`. Método `findByIdScopedToChannel(videoId, channelId): Promise<Video | null>` — sempre filtra `WHERE id = :videoId AND channel_id = :channelId` (nunca busca por `id` isolado), fechando o gap de vídeo não escopado ao canal

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/guards/owned-channel.guard.spec.ts` | Unit | Canal pertencente ao usuário passa; canal de outro usuário lança `ChannelNotOwnedException`; canal inexistente lança a mesma exceção (não revela existência) |
| `src/videos/repositories/videos.repository.integration-spec.ts` | Integration | `findByIdScopedToChannel` retorna `null` quando o vídeo existe mas pertence a outro canal — nunca vaza vídeo de canal alheio |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Requisição a qualquer rota `/channels/:channelId/...` com um `channelId` que não pertence ao usuário autenticado retorna 403 com `CHANNEL_NOT_OWNED`, mesmo que o canal exista
- `VideosRepository.findByIdScopedToChannel` nunca retorna um vídeo cujo `channel_id` seja diferente do `channelId` informado

---

### SI-03.6 — Upload Initiation Endpoint

**Description:** Implementar o endpoint que valida o tamanho declarado do arquivo, cria o vídeo como rascunho, inicia o multipart upload no storage e emite URLs de parte sob demanda.

**Technical actions:**

1. Criar `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto` com `title` (`@IsString() @IsNotEmpty() @MaxLength(150)`), `description` (`@IsString() @IsOptional()`), `fileSizeBytes` (`@IsInt() @Min(1) @Max(10737418240)` — 10GB, per `phase-03-videos/TD-03`), `contentType` (`@IsString() @Matches(/^video\//)`)
2. Implementar `VideosService.initiateUpload(channelId, dto)` — gera `slug` via `nanoid` (12 chars, retry em `QueryFailedError` de unicidade — per `phase-03-videos/TD-06`), monta `storageKey = \`${videoId}/source\`` (sem `channelId` na key — per `phase-03-videos/TD-02`), cria o vídeo com `status: 'draft'`, chama `storageService.createMultipartUpload`, persiste `upload_id`, retorna `{ videoId, slug, uploadId }`
3. Implementar `VideosService.getUploadPartUrl(channelId, videoId, uploadId, partNumber)` — busca o vídeo via `findByIdScopedToChannel`, lança `VideoNotFoundException` (404) se ausente, lança `UploadNotInProgressException` (409) se `status !== 'draft'` ou `upload_id !== uploadId`, retorna `storageService.presignUploadPart(...)`
4. Criar `src/videos/videos.controller.ts` — `@UseGuards(JwtAuthGuard, OwnedChannelGuard)`, `@Controller('channels/:channelId/videos')`. `@Post('uploads')` chama `initiateUpload`. `@Get('uploads/:uploadId/parts/:partNumber')` chama `getUploadPartUrl`
5. Criar `src/common/exceptions/video-not-found.exception.ts` e `src/common/exceptions/upload-not-in-progress.exception.ts` — `DomainException` subclasses (404 / 409)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initiateUpload`: gera slug único, monta storageKey sem channelId, retry em colisão de slug; `getUploadPartUrl`: rejeita quando status != draft |
| `src/videos/videos.service.integration-spec.ts` | Integration | `initiateUpload` persiste vídeo `draft` com `upload_id`; slug respeita constraint unique real do banco |
| `test/videos.e2e-spec.ts` | E2E | `POST /channels/:channelId/videos/uploads` 201 com payload válido; 400 com `fileSizeBytes` > 10GB; 403 com `channelId` de outro usuário; `GET .../uploads/:uploadId/parts/:partNumber` 200 com URL válida, 409 se vídeo não está em `draft` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.5

**Acceptance criteria:**

- `POST /channels/:channelId/videos/uploads` com `fileSizeBytes` válido (≤10GB) retorna 201 com `{ videoId, slug, uploadId }`; um vídeo é persistido com `status = 'draft'`
- `POST /channels/:channelId/videos/uploads` com `fileSizeBytes` acima de 10GB retorna 400 com `errorCode: "VALIDATION_ERROR"`
- `POST /channels/:channelId/videos/uploads` com `:channelId` que não pertence ao usuário autenticado retorna 403 com `CHANNEL_NOT_OWNED`
- `GET .../uploads/:uploadId/parts/:partNumber` de um vídeo cujo status não é `draft` retorna 409 com `UPLOAD_NOT_IN_PROGRESS`

---

### SI-03.7 — Upload Completion Endpoint

**Description:** Implementar o endpoint que finaliza o multipart upload, valida o tamanho real do objeto contra o declarado, transiciona o vídeo para `processing` de forma idempotente e enfileira o job de processamento.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto` com `uploadId` (`@IsString() @IsNotEmpty()`), `parts` (`@IsArray() @ArrayNotEmpty()`, cada item `{ partNumber: number, eTag: string }`)
2. Implementar `VideosService.completeUpload(channelId, videoId, dto)` — busca o vídeo via `findByIdScopedToChannel`; transição atômica condicional `UPDATE videos SET status = 'processing' WHERE id = :id AND status = 'draft'` (via `Repository.update` com `where: { id, status: DRAFT }`, checando `affected === 1`) — lança `UploadAlreadyCompletedException` (409) se `affected === 0`, fechando a corrida de dupla-conclusão; chama `storageService.completeMultipartUpload`; valida `headObject(storageKey).sizeBytes` contra o `fileSizeBytes` declarado na iniciação (tolerância zero — mismatch reverte o status para `draft` e lança `UploadSizeMismatchException`, 422); enfileira o job com `jobId: videoId` (dedup nativo do BullMQ — per `phase-03-videos/TD-01`)
3. Adicionar `@Post('uploads/complete')` a `VideosController` — chama `completeUpload`, retorna 200 com `{ videoId, status: 'processing' }`
4. Criar `src/common/exceptions/upload-already-completed.exception.ts` e `src/common/exceptions/upload-size-mismatch.exception.ts` — `DomainException` subclasses (409 / 422)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload`: chamada dupla concorrente só transiciona uma vez (segunda recebe `UploadAlreadyCompletedException`); mismatch de tamanho reverte para `draft` |
| `src/videos/videos.service.integration-spec.ts` | Integration | `completeUpload` persiste `status = 'processing'`; job publicado na fila real com `jobId = videoId` |
| `test/videos.e2e-spec.ts` | E2E | `POST .../uploads/complete` 200 com transição para `processing`; segunda chamada retorna 409 `UPLOAD_ALREADY_COMPLETED`; tamanho divergente retorna 422 `UPLOAD_SIZE_MISMATCH` |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- `POST .../uploads/complete` com partes válidas retorna 200 e o vídeo transiciona para `processing`
- Chamar `POST .../uploads/complete` duas vezes em sequência para o mesmo vídeo retorna 409 `UPLOAD_ALREADY_COMPLETED` na segunda chamada — nenhum job duplicado é enfileirado
- Se o objeto final no storage tiver tamanho diferente do `fileSizeBytes` declarado na iniciação, a chamada retorna 422 `UPLOAD_SIZE_MISMATCH` e o vídeo volta para `draft`

---

### SI-03.8 — Video Processing Worker (FFmpeg)

**Description:** Implementar o processor que consome a fila `video-processing`: baixa o arquivo do storage, extrai duração/metadados via `ffprobe`, gera a thumbnail a 10% da duração via `ffmpeg`, faz upload da thumbnail e transiciona o vídeo para `ready` ou `error`.

**Technical actions:**

1. Criar `src/videos/workers/video-processing.processor.ts` — `@Processor('video-processing') class VideoProcessingProcessor extends WorkerHost`. `process(job: Job<{ videoId, storageKey }>)`: baixa o objeto do storage para um arquivo temporário local (`fs.mkdtemp` + stream do `GetObjectCommand`) — necessário porque `fluent-ffmpeg` exige um caminho de arquivo local para `ffprobe`/timestamps percentuais, não uma URL remota (per `phase-03-videos/TD-04`; `library-refs.md`)
2. Implementar extração de metadados via `ffmpeg.ffprobe(localPath, cb)` — `durationSeconds`, `metadata: { codec, width, height, bitrate }` (per `phase-03-videos/TD-04`)
3. Implementar geração de thumbnail via `.screenshots({ timestamps: ['10%'], folder: tmpDir })` (per `phase-03-videos/TD-04` Resolution — fecha `validation.md` AMB-1), upload do arquivo gerado via `storageService` para o bucket de thumbnails com key `\`${videoId}/thumbnail.jpg\``
4. No sucesso: `videosRepository.updateStatus(videoId, 'ready', { durationSeconds, metadata, thumbnailKey })`. No erro: `videosRepository.updateStatus(videoId, 'error', { errorReason: <código fechado, não a mensagem crua da exceção — ex: 'PROCESSING_FAILED', 'INVALID_FORMAT', 'TIMEOUT'> })` antes de relançar o erro para o retry nativo do BullMQ (`attempts: 3`, `backoff: exponential` — per `phase-03-videos/TD-01`, `TD-05`)
5. Envolver a chamada ao FFmpeg com `AbortController` + timeout configurável (`FFMPEG_TIMEOUT_MS`), lançando `UnrecoverableError` no timeout para não desperdiçar tentativas de retry em um arquivo que trava (per `library-refs.md`); limpar o arquivo temporário local no `finally`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/workers/video-processing.processor.integration-spec.ts` | Integration | Job real processado contra um vídeo fixture pequeno no MinIO real: `durationSeconds`/`metadata` extraídos corretamente, thumbnail gerada e enviada ao bucket, status final `ready`; vídeo corrompido/formato inválido resulta em `status: 'error'` com `errorReason` de um código fechado (nunca a mensagem crua da exceção) |

**Dependencies:** SI-03.3, SI-03.4, SI-03.7

**Acceptance criteria:**

- Um job publicado para um vídeo válido resulta em `status = 'ready'`, `duration_seconds` e `metadata` populados, e uma thumbnail existente no bucket de thumbnails
- Um job para um arquivo de vídeo corrompido resulta em `status = 'error'` após esgotar as tentativas de retry, com `error_reason` sendo um código fechado (nunca a mensagem bruta de exceção do FFmpeg)
- Um processamento que excede `FFMPEG_TIMEOUT_MS` é abortado sem consumir uma tentativa de retry adicional (via `UnrecoverableError`)

---

### SI-03.9 — Video Status Query Endpoint

**Description:** Implementar o endpoint de consulta do vídeo, expondo o status atual sem bloquear enquanto o processamento roda em segundo plano.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` — `VideoResponseDto` com `id`, `slug`, `title`, `description`, `status`, `durationSeconds`, `errorReason`, `createdAt`
2. Adicionar `@Get(':videoId')` a `VideosController` — chama `videosService.findById(channelId, videoId)` (via `findByIdScopedToChannel`, lança `VideoNotFoundException` se ausente), retorna 200 com `VideoResponseDto`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | `GET /channels/:channelId/videos/:videoId` 200 com o status atual do vídeo; 404 se o vídeo não existe ou pertence a outro canal; 403 se `:channelId` não pertence ao usuário |

**Dependencies:** SI-03.2, SI-03.5

**Acceptance criteria:**

- `GET .../:videoId` retorna 200 com o `status` refletindo o estado real do vídeo (`draft`, `processing`, `ready` ou `error`) sem bloquear a resposta enquanto um job está em andamento
- `GET .../:videoId` com um `videoId` pertencente a outro canal retorna 404 `VIDEO_NOT_FOUND` — não vaza a existência do vídeo

---

### SI-03.10 — Streaming e Download Endpoints

**Description:** Implementar os endpoints que emitem URLs pré-assinadas de leitura para streaming (com suporte nativo a `Range`/`206`) e para download, apenas para vídeos com status `ready`.

**Technical actions:**

1. Implementar `VideosService.getStreamUrl(channelId, videoId)` — busca o vídeo via `findByIdScopedToChannel`, lança `VideoNotFoundException` se ausente, lança `VideoNotReadyException` (409) se `status !== 'ready'`, retorna `storageService.createPresignedGetUrl(bucket, storageKey, expiresInSeconds: 3600)` (per `phase-03-videos/TD-07`)
2. Implementar `VideosService.getDownloadUrl(channelId, videoId)` — mesma validação de `getStreamUrl`, mas com `expiresInSeconds: 300` (TTL menor que streaming — operação de posse do arquivo completo é mais sensível a vazamento do link)
3. Adicionar `@Get(':videoId/stream')` e `@Get(':videoId/download')` a `VideosController` — retornam 200 com `{ url, expiresInSeconds }`
4. Criar `src/common/exceptions/video-not-ready.exception.ts` — `DomainException` subclass (409, `errorCode: 'VIDEO_NOT_READY'`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `getStreamUrl`/`getDownloadUrl` rejeitam vídeo com status != `ready`; download usa TTL menor que stream |
| `test/videos.e2e-spec.ts` | E2E | `GET .../stream` e `GET .../download` de vídeo `ready` retornam 200 com URL válida (requisição `Range` contra a URL retorna 206 do MinIO real); vídeo `processing`/`draft`/`error` retorna 409 `VIDEO_NOT_READY` em ambos |

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `GET .../stream` de um vídeo `ready` retorna 200 com uma URL que, requisitada com header `Range`, responde `206 Partial Content` com o conteúdo parcial correto
- `GET .../download` de um vídeo `ready` retorna 200 com uma URL válida para o arquivo completo, com TTL menor que a URL de streaming
- `GET .../stream` ou `GET .../download` de um vídeo que não está `ready` (qualquer outro status) retorna 409 `VIDEO_NOT_READY`

---

### SI-03.11 — Rate Limiting nos Endpoints de Vídeo

**Description:** Aplicar limites de taxa por usuário autenticado nos endpoints de vídeo, com limites mais restritivos em upload/download (emissão de credenciais de storage) e mais permissivo em consulta de status (polling legítimo).

**Technical actions:**

1. Configurar `ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }])` (default) em `VideosModule` imports, com `ThrottlerGuard` registrado como `APP_GUARD` escopado ao módulo (mesmo padrão de `AuthModule` na Fase 02)
2. Aplicar `@Throttle({ default: { limit: 10, ttl: 60_000 } })` em `POST .../uploads`, `@Throttle({ default: { limit: 20, ttl: 60_000 } })` em `POST .../uploads/complete`, `@Throttle({ default: { limit: 30, ttl: 60_000 } })` em `GET .../stream`, `@Throttle({ default: { limit: 10, ttl: 60_000 } })` em `GET .../download`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | 11ª requisição a `POST .../uploads` dentro de 60s retorna 429; `GET .../:videoId` (status, sem `@Throttle` explícito) não é limitado pelos limites mais restritivos |

**Dependencies:** SI-03.6, SI-03.7, SI-03.10

**Acceptance criteria:**

- A 11ª requisição a `POST .../uploads` dentro de uma janela de 60 segundos retorna 429 Too Many Requests
- `GET .../:videoId` (consulta de status) permite polling em uma taxa maior (60/min) sem ser limitado como os endpoints de upload/download
- O rate limiting é por usuário autenticado (chave = `sub` do JWT), não por IP

---

### SI-03.12 — Migration Runner Integration Test

**Description:** Adicionar um teste de integração que roda a migration de vídeos programaticamente e confirma a integridade bidirecional (apply/revert), seguindo o padrão já estabelecido na Fase 02.

**Technical actions:**

1. Estender `src/database/migrations.integration-spec.ts` (criado na Fase 02) — registrar a entidade `Video` no `DataSource` de teste; assertar que `runMigrations()` agora inclui a migration `CreateVideos`; assertar que a tabela `videos` aparece em `information_schema.tables` após `runMigrations()` e desaparece após `dataSource.undoLastMigration()`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` | Integration | `runMigrations` aplica a migration `CreateVideos`; tabela `videos` existe após apply e não existe após `undoLastMigration` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Após `dataSource.runMigrations()`, a tabela `videos` está presente em `information_schema.tables`
- Após `dataSource.undoLastMigration()` (revertendo apenas a última migration), `videos` não existe mais, e as tabelas da Fase 02 permanecem intactas

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null | |
| title | varchar(150) | not null | |
| description | text | nullable | |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | Ciclo de status (`phase-03-videos/TD-05`) |
| slug | varchar(12) | unique, not null | Identificador de URL única, gerado via nanoid (`phase-03-videos/TD-06`) |
| storage_key | varchar | nullable | Chave do arquivo de vídeo — escopada por `videoId`, nunca por `channelId` (`phase-03-videos/TD-02`) |
| thumbnail_key | varchar | nullable | Chave da thumbnail |
| upload_id | varchar | nullable | S3 Multipart `UploadId` — limpo após `completeMultipartUpload` |
| declared_size_bytes | bigint | nullable | `fileSizeBytes` declarado em SI-03.6; comparado contra `HeadObject` real em SI-03.7 (`UPLOAD_SIZE_MISMATCH`) — adicionado durante a implementação (SI-03.6/03.7), não constava no rascunho original do plano |
| duration_seconds | int | nullable | Populado pelo worker (`phase-03-videos/TD-04`) |
| metadata | jsonb | nullable | codec, width, height, bitrate |
| error_reason | varchar | nullable | Código fechado (nunca mensagem crua de exceção) |
| created_at | timestamptz | not null, auto | |
| updated_at | timestamptz | not null, auto | |

**Relations:** Video → Channel (many-to-one)
**Indexes:** `(slug)` — unique, `(channel_id)` — FK

---

### API Contracts

#### POST /channels/:channelId/videos/uploads (SI-03.6)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — max 150 characters
- description: string, optional
- fileSizeBytes: integer, required — min 1, max 10737418240 (10GB)
- contentType: string, required — must match `video/*`

**Response 201:**
- videoId: string (uuid)
- slug: string
- uploadId: string

**Error responses:**
- 400 validation error: `fileSizeBytes` acima de 10GB, `title` ausente, `contentType` inválido
- 403 CHANNEL_NOT_OWNED: `:channelId` não pertence ao usuário autenticado

---

#### GET /channels/:channelId/videos/uploads/:uploadId/parts/:partNumber (SI-03.6)

**Response 200:**
- url: string
- expiresInSeconds: number

**Error responses:**
- 404 VIDEO_NOT_FOUND: vídeo não encontrado ou não pertence ao canal
- 403 CHANNEL_NOT_OWNED
- 409 UPLOAD_NOT_IN_PROGRESS: vídeo não está com status `draft` ou `uploadId` não confere

---

#### POST /channels/:channelId/videos/:videoId/uploads/complete (SI-03.7)

**Request body:**
- uploadId: string, required
- parts: array, required — cada item `{ partNumber: number, eTag: string }`

**Response 200:**
- videoId: string
- status: `"processing"`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 CHANNEL_NOT_OWNED
- 409 UPLOAD_ALREADY_COMPLETED: chamada repetida — vídeo não está mais em `draft`
- 422 UPLOAD_SIZE_MISMATCH: tamanho real do objeto diverge do `fileSizeBytes` declarado

---

#### GET /channels/:channelId/videos/:videoId (SI-03.9)

**Response 200:**
- id, slug, title, description, status, durationSeconds, errorReason, createdAt

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 CHANNEL_NOT_OWNED

---

#### GET /channels/:channelId/videos/:videoId/stream (SI-03.10)

**Response 200:**
- url: string
- expiresInSeconds: number (3600)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 CHANNEL_NOT_OWNED
- 409 VIDEO_NOT_READY: status diferente de `ready`

---

#### GET /channels/:channelId/videos/:videoId/download (SI-03.10)

**Response 200:**
- url: string
- expiresInSeconds: number (300 — menor que streaming)

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 403 CHANNEL_NOT_OWNED
- 409 VIDEO_NOT_READY

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /channels/:channelId/videos/uploads | ✗ | ✗ | ✓ |
| GET /channels/:channelId/videos/uploads/:uploadId/parts/:partNumber | ✗ | ✗ | ✓ |
| POST /channels/:channelId/videos/:videoId/uploads/complete | ✗ | ✗ | ✓ |
| GET /channels/:channelId/videos/:videoId | ✗ | ✗ | ✓ |
| GET /channels/:channelId/videos/:videoId/stream | ✗ | ✗ | ✓ |
| GET /channels/:channelId/videos/:videoId/download | ✗ | ✗ | ✓ |

Todos os endpoints exigem posse do canal (`OwnedChannelGuard`, SI-03.5) — nenhum é apenas "autenticado", diferindo do padrão de alguns endpoints públicos da Fase 02.

---

### Error Catalog

**Formato de erro:** herdado da Fase 02 (`phase-02-auth/TD-07`) — `{ statusCode, error, message }`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| CHANNEL_NOT_OWNED | 403 | `:channelId` do path não pertence ao usuário autenticado |
| VIDEO_NOT_FOUND | 404 | `:videoId` não encontrado ou não pertence ao `:channelId` |
| UPLOAD_NOT_IN_PROGRESS | 409 | Solicitar URL de parte para vídeo que não está em `draft` |
| UPLOAD_ALREADY_COMPLETED | 409 | Chamar `uploads/complete` em vídeo que não está mais em `draft` |
| UPLOAD_SIZE_MISMATCH | 422 | Tamanho real do objeto (via `HeadObject`) diverge do `fileSizeBytes` declarado |
| VIDEO_NOT_READY | 409 | Solicitar stream/download de vídeo cujo status não é `ready` |
| VALIDATION_ERROR | 400 | Payload inválido (herdado da Fase 02) |

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "string" }
```

**Producer:** `VideosService` (per `phase-03-videos/TD-01`, `TD-03`)
**Consumer:** `VideoProcessingProcessor` — Video Worker (per `phase-03-videos/TD-01`, `TD-04`)
**Trigger:** `POST .../uploads/complete` bem-sucedido (multipart completo + `HeadObject` confirma o tamanho declarado)
**Delivery semantics:** at-least-once (padrão BullMQ); consumer idempotente — `jobId: videoId` garante deduplicação no lado do produtor (`phase-03-videos/TD-01`)

---

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depends on SI-03.1 (entidade precisa de deps/config instalados)
│   ├── SI-03.5 — depends on SI-03.2 (guard consulta Channel/Video)
│   │   ├── SI-03.6 — depends on SI-03.2, SI-03.3, SI-03.5
│   │   │   └── SI-03.7 — depends on SI-03.4, SI-03.6
│   │   │       └── SI-03.8 — depends on SI-03.3, SI-03.4, SI-03.7
│   │   ├── SI-03.9 — depends on SI-03.2, SI-03.5
│   │   └── SI-03.10 — depends on SI-03.3, SI-03.5
│   └── SI-03.12 — depends on SI-03.2
├── SI-03.3 — depends on SI-03.1 (StorageService)
└── SI-03.4 — depends on SI-03.1 (BullMQ + Worker skeleton)

SI-03.11 — depends on SI-03.6, SI-03.7, SI-03.10 (decora endpoints já existentes)
```

Ordem de implementação linearizada: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (paralelo) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9, SI-03.10 (paralelo) → SI-03.11 → SI-03.12 (pode rodar em paralelo com 03.9-03.11, depende só de 03.2)

## Implementation Notes (desvios registrados durante o `implement`)

Pequenos ajustes feitos durante a implementação, mantidos aqui para rastreabilidade (por que o código diverge da letra de uma technical action, mas não do contrato/API):

1. **`declared_size_bytes`** foi adicionado ao `Video` (ver Data Model) — necessário para `UPLOAD_SIZE_MISMATCH` (SI-03.7) comparar o tamanho declarado em SI-03.6 contra o `HeadObject` real; não estava na tabela original do plano.
2. **`GET /channels/:channelId/videos/uploads/:uploadId/parts/:partNumber`** é resolvido por `(channelId, uploadId)` via `VideosRepository.findByUploadIdScopedToChannel`, não por `videoId` — a Technical Action de SI-03.6 menciona um parâmetro `videoId`, mas o contrato de API (fonte da verdade, seção "API Contracts") não inclui `:videoId` nessa rota.
3. **Rate limiting (SI-03.11)** é aplicado via `@Throttle()` por rota no `VideosController`, reaproveitando o `ThrottlerGuard` global já registrado como `APP_GUARD` em `AuthModule`. Não foi criado um segundo `ThrottlerModule.forRoot()` nem um segundo `APP_GUARD` em `VideosModule` como a Technical Action #1 sugeria — registrar dois guards globais de throttling causaria dupla contagem/config conflitante. O efeito (limites diferentes por endpoint, incluindo um limite mais permissivo em `GET :videoId`) é o mesmo.
4. **`JwtAuthGuard` não é reaplicado** no `VideosController` — ele já é global (`APP_GUARD` em `AuthModule`), e `.claude/rules/nestjs-controllers.md` proíbe reaplicá-lo localmente. Apenas `OwnedChannelGuard` é declarado via `@UseGuards`.

## Deliverables

- [ ] SI-03.1 — Dependencies, Config Namespaces, and Docker Compose
- [ ] SI-03.2 — Video Entity and Migration
- [ ] SI-03.3 — StorageService (Cliente S3/MinIO)
- [ ] SI-03.4 — BullMQ Queue Module e Video Worker (esqueleto)
- [ ] SI-03.5 — Channel Ownership Guard
- [ ] SI-03.6 — Upload Initiation Endpoint
- [ ] SI-03.7 — Upload Completion Endpoint
- [ ] SI-03.8 — Video Processing Worker (FFmpeg)
- [ ] SI-03.9 — Video Status Query Endpoint
- [ ] SI-03.10 — Streaming e Download Endpoints
- [ ] SI-03.11 — Rate Limiting nos Endpoints de Vídeo
- [ ] SI-03.12 — Migration Runner Integration Test

**Full test suites:**

- [ ] Testes unitários e de integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Verificação de tipos passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Build do projeto (`docker compose exec nestjs-api npm run build`)
- [ ] `docker compose up -d` sobe `minio`, `redis` e `video-worker` junto com `nestjs-api`, `db` e `mailpit`
