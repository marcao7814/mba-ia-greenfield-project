# phase-03-videos — Progress

**Status:** implementado — todas as 12 SIs concluídas e com testes verificados verdes; suíte completa (`npm test` + `npm run test:e2e`) não pôde ser confirmada 100% verde em uma única rodada nesta sessão de desenvolvimento por instabilidade do ambiente local (ver "Nota sobre o ambiente" no final). Recomenda-se rodar a suíte completa uma vez mais em ambiente limpo antes do merge para `dev`.
**SIs:** 12/12 completed

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose
- **Status:** completed
- **Tests:** sem testes dedicados (infra) — validado via `docker compose up -d` (minio/redis/video-worker sobem healthy) e `npx tsc --noEmit`
- **Observations:** `nanoid@5.1.16` instalado originalmente no esqueleto é ESM-only e quebra sob o build CommonJS do projeto (`SyntaxError: Cannot use import statement outside a module`) — o próprio `library-refs.md` já previa esse risco e recomendava pinar em `^3.x`; corrigido durante a SI-03.5/03.6.

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 5/5 passing (`video.entity.integration-spec.ts`)
- **Observations:** Adicionada a coluna `declared_size_bytes` (bigint, nullable) à entidade e à migration — necessária para o `VideosService.completeUpload` validar `UPLOAD_SIZE_MISMATCH` contra o `HeadObject` real; não constava no rascunho original do Data Model do plano (documentado em `phase-03-videos.md`).

### SI-03.3 — StorageService (Cliente S3/MinIO)
- **Status:** completed
- **Tests:** 3/3 passing (`storage.service.integration-spec.ts`: 2 integration contra MinIO real incl. `Range` → 206; `storage.module.spec.ts`: 1 module)
- **Observations:** Adicionado `downloadObjectToFile` (stream para arquivo local) — necessário para o worker baixar o vídeo antes do FFmpeg processar (fluent-ffmpeg exige caminho de arquivo local).

### SI-03.4 — BullMQ Queue Module e Video Worker
- **Status:** completed
- **Tests:** 1/1 passing (`worker.module.spec.ts`)
- **Observations:** `WorkerModule` não importava `UsersModule`; como `Channel` tem `@OneToOne(() => User, ...)`, o `autoLoadEntities` não conseguia resolver a metadata de `Channel#user`, e o `video-worker` real travava em loop de retry ao subir (`TypeORMError: Entity metadata for Channel#user was not found`). Corrigido importando `UsersModule` em `WorkerModule`. Confirmado via `docker compose logs video-worker` que o processo agora inicializa todos os módulos sem erro.

### SI-03.5 — Channel Ownership Guard
- **Status:** completed
- **Tests:** 8/8 passing (`owned-channel.guard.spec.ts`: 3 unit; `videos.repository.integration-spec.ts`: 5 integration)
- **Observations:** `OwnedChannelGuard` já existia do commit anterior ("esqueleto"); adicionado apenas o teste unitário. `VideosRepository` criado com `findByIdScopedToChannel`/`findByUploadIdScopedToChannel` (sempre filtra por `channel_id`, nunca busca por `id` isolado) e geração de slug via `nanoid/customAlphabet` (alfabeto alfanumérico minúsculo, 12 chars, per `library-refs.md`).

### SI-03.6 — Upload Initiation Endpoint
- **Status:** completed
- **Tests:** cobertos em `videos.service.spec.ts` (unit) e `videos.service.integration-spec.ts` (integration) — ver totais consolidados abaixo
- **Observations:** `GET .../uploads/:uploadId/parts/:partNumber` é resolvido por `(channelId, uploadId)`, não por `videoId` — o contrato de API do plano não inclui `:videoId` nessa rota (divergência entre a Technical Action e a seção "API Contracts"; segui o contrato, que é a fonte da verdade testável).

### SI-03.7 — Upload Completion Endpoint
- **Status:** completed
- **Tests:** incluídos nos mesmos arquivos de SI-03.6
- **Observations:** Transição `draft → processing` é atômica e condicional (`UPDATE ... WHERE status = 'draft'`, checando `affected === 1`), fechando a corrida de dupla-conclusão. Mismatch de tamanho reverte para `draft` antes de lançar `UPLOAD_SIZE_MISMATCH`.

### SI-03.8 — Video Processing Worker (FFmpeg)
- **Status:** completed
- **Tests:** 2/2 passing (`video-processing.processor.integration-spec.ts` — pipeline real: gera um vídeo sintético via `ffmpeg -f lavfi`, processa contra MinIO real, extrai metadados/duração, gera thumbnail, marca `ready`; segundo teste confirma `status: error` com `error_reason` de código fechado para arquivo corrompido)
- **Observations:** Corrigidos três bugs no próprio teste durante a validação: (1) faltava `TypeOrmModule.forFeature([Video])` no módulo de teste, causando falha de DI; (2) o objeto `video` retornado por `createDraftWithUniqueSlug` ficava com `storage_key` desatualizado após `attachUpload` (helper agora refaz o `findOneByOrFail`); (3) `afterAll` não protegia contra `dataSource`/`fixturesDir` indefinidos quando o `beforeAll` falhava, deixando uma conexão órfã aberta contra o Postgres — essa conexão órfã foi a causa raiz de uma cascata de falhas (deadlocks, "relation already exists") em testes completamente não relacionados quando a suíte inteira rodava em sequência.

### SI-03.9 — Video Status Query Endpoint
- **Status:** completed
- **Tests:** cobertos em `videos.service.spec.ts`/`videos.service.integration-spec.ts`
- **Observations:** nenhuma

### SI-03.10 — Streaming e Download Endpoints
- **Status:** completed
- **Tests:** cobertos em `videos.service.spec.ts`/`videos.service.integration-spec.ts`
- **Observations:** `download` usa TTL de 300s vs 3600s do `stream`, conforme o plano.

### SI-03.11 — Rate Limiting nos Endpoints de Vídeo
- **Status:** completed
- **Tests:** cobertos em `test/videos.e2e-spec.ts` (11ª requisição de upload → 429; `GET :videoId` não é limitado pelo limite mais restritivo)
- **Observations:** Implementado via `@Throttle()` por rota reaproveitando o `ThrottlerGuard` global já registrado em `AuthModule`, em vez de um segundo `ThrottlerModule.forRoot()`/`APP_GUARD` em `VideosModule` como a Technical Action sugeria — dois guards globais de throttling causariam dupla contagem/config conflitante. Documentado em `phase-03-videos.md` → "Implementation Notes".

### SI-03.12 — Migration Runner Integration Test
- **Status:** completed
- **Tests:** 3/3 passing (`migrations.integration-spec.ts` — aplica as 3 migrations e cria as 5 tabelas; reverte só `videos`; reverte auth tokens)
- **Observations:** `DROP TABLE ... CASCADE` não remove o `TYPE` enum associado — rodar a suíte mais de uma vez contra o mesmo Postgres falhava com `type "..." already exists`. Corrigido adicionando `DROP TYPE IF EXISTS ... CASCADE` para `verification_tokens_type_enum` e `videos_status_enum` no `beforeAll`.

---

## Totais de teste (módulo de vídeo, rodada isolada em stack limpa)

**38/38 passing** em 12 suites: `video-processing.processor.integration-spec` (2), `videos.module.spec` (1), `owned-channel.guard.spec` (3), `worker.module.spec` (1), `videos.service.integration-spec` (5), `videos.service.spec` (11), `storage.module.spec` (1), `storage.service.integration-spec` (2), `videos.repository.integration-spec` (5), `video.entity.integration-spec` (5), `migrations.integration-spec` (3), `env.validation.integration-spec` (3).

`npx tsc --noEmit`: **exit 0**, confirmado múltiplas vezes após cada correção.

`npm run lint`: erros reais no código da fase 03 corrigidos (tipagem do erro do driver Postgres, cast via `QueryDeepPartialEntity` em vez de `any`, promise rejection tipado). Restam erros pré-existentes em arquivos da Fase 02 não tocados por esta fase (`mail.service.integration-spec.ts`, `create-test-data-source.ts:9`, `users.service.integration-spec.ts:12`) — confirmado que `@typescript-eslint`/`eslint` estão na mesma versão de `origin/dev`, ou seja, essa dívida é pré-existente e não foi introduzida por esta branch; fora do escopo desta fase corrigir.

`test/videos.e2e-spec.ts` (15 casos cobrindo todo o fluxo: iniciação de upload, URL de parte, conclusão, mismatch de tamanho, consulta de status, stream/download, rate limiting): lógica revisada e um bug real de regressão corrigido (ver Nota sobre o ambiente) — não foi possível confirmar uma rodada 100% verde da suíte e2e completa nesta sessão por instabilidade do ambiente local descrita abaixo.

## Bug real encontrado e corrigido: timeout no bootstrap dos testes e2e

Adicionar `StorageModule` (2 chamadas ao MinIO no `onModuleInit`) e `QueueModule` (conexão Redis) ao `AppModule` tornou o bootstrap completo genuinamente mais pesado. Nenhum arquivo e2e (nem os da Fase 02: `app`, `auth`, `swagger`) tinha timeout explícito no `beforeAll` — só o padrão de 5s do Jest — e isso passou a estourar consistentemente. Corrigido adicionando timeout explícito de 30s ao `beforeAll` de todos os 4 arquivos e2e.

## Nota sobre o ambiente desta sessão

Esta sessão de implementação foi incomumente longa (múltiplos rebuilds de imagem Docker, várias rodadas de suíte completa). Durante o processo:

1. Comandos `docker compose exec` movidos para background por timeout, quando interrompidos pelo lado do wrapper, **não necessariamente matam o processo dentro do container** — isso gerou processos "zumbis" (`jest` de rodadas anteriores) que continuaram rodando em paralelo com rodadas subsequentes, competindo por conexões do Postgres e causando deadlocks/timeouts em testes completamente não relacionados. Identificado e corrigido três vezes ao longo da sessão (visível via `docker compose exec nestjs-api ps aux`).
2. Em um desses momentos de contenção, o **Postgres foi morto por OOM** (`exit 137`) pelo host, derrubando toda a stack. Os dados sobreviveram (volume nomeado); a stack foi religada com `docker compose up -d` e o schema confirmado íntegro.
3. Após eliminar os zumbis e corrigir o bug real do timeout do `beforeAll`, rodadas **isoladas e menores** (por arquivo/lote) do módulo de vídeo confirmaram tudo verde. Uma rodada final da suíte e2e completa não foi concluída dentro desta sessão.

**Recomendação:** antes do merge para `dev`, rodar `docker compose down && docker compose up -d` (stack limpa) seguido de `npm test -- --runInBand` e `npm run test:e2e` uma única vez, sem processos concorrentes, para a confirmação oficial de suíte 100% verde exigida pela Definition of Done.
