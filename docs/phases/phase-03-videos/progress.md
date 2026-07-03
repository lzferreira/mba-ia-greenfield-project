# phase-03-videos — Progress

**Status:** completed
**SIs:** 9/9 completed
**DoD:** unit+integração 196/196 (33 suites), e2e 69/69 (5 suites), `tsc --noEmit` exit 0, `npm run lint` 0 erros (23 warnings `no-unsafe-argument`, regra `warn`) — tudo no container.

### SI-03.1 — Infra: object storage, fila e worker no Compose
- **Status:** completed
- **Tests:** no tests (infra) — verified via `docker compose up -d`
- **Observations:**
  - `docker compose ps`: db, mailpit, minio (healthy), nestjs-api, redis (healthy), video-worker todos up. ffprobe 5.1.9 + ffmpeg em `/usr/bin` no worker.
  - MinIO healthcheck usa `curl` (presente na imagem `minio/minio`); api/worker dependem de minio via `service_started` (não bloqueia em healthcheck).
  - `video-worker` idle (`tail -f /dev/null`, padrão dev do projeto); o entrypoint real do worker é montado em SI-03.7.
  - `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` consumidos pelo container minio (não pelo app → fora do Joi, passam por `allowUnknown`).

### SI-03.2 — Config namespaces e StorageService
- **Status:** completed
- **Tests:** 6 passing (storage.service.integration-spec 4 + abort/bootstrap, storage.module.spec 1) — real MinIO
- **Observations:**
  - **Limitação do MinIO (importante):** este build do MinIO **não suporta a lifecycle action `AbortIncompleteMultipartUpload`** — rejeita regra abort-only (`InvalidArgument: XML ... schema`) e, quando pareada com ação benigna, descarta o abort no GET. Diagnóstico: S3/MinIO real aceita abort-only; é lacuna do backend no ambiente. `applyLifecycleRule` ficou **best-effort** (warn + segue no boot). Mecanismo primário do AMB-2 (endpoint explícito de abort, SI-03.6) intacto. → possível item de fechamento: validar a regra contra S3/MinIO real.
  - `S3Client` com `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'` (compat MinIO + aws-sdk v3, que injeta CRC32 por padrão).
  - `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` `^3.1079.0` instalados no container.
  - `storageConfig`/`redisConfig` adicionados ao `load[]` do ConfigModule global; `StorageModule` importado no AppModule.

### SI-03.3 — Migration e entidade Video
- **Status:** completed
- **Tests:** 8 passing (video.entity.integration-spec 6 + create-videos.integration-spec 2) — real DB
- **Observations:**
  - Migration gerada via CLI (`migration:generate`) → `1783021883881-CreateVideos.ts`: enum-first up, unique em `public_id`, índices em `channel_id`/`status`, FK `channel_id → channels(id)` ON DELETE CASCADE; down reverte FK→índices→tabela→tipo enum (sem vazar `videos_status_enum`). Runtime `data-source.ts` usa glob, pega a migration sem edição.
  - **Desvio de path do spec da migration:** plano pedia `src/database/migrations/create-videos.integration-spec.ts`, mas o glob de migrations do `data-source.ts` (`src/database/migrations/*.ts`) carregaria o spec como migration e quebraria (`describe` fora do jest). Colocado em `src/database/create-videos.integration-spec.ts` (mesmo local do `migrations.integration-spec.ts` existente, que evita a colisão pelo mesmo motivo).
  - Entidade usa nomes de coluna snake_case como nome de propriedade (convenção do projeto — `Channel` faz igual, sem NamingStrategy). `size_bytes` (bigint) tem transformer bigint→number (driver pg retorna string por padrão).
  - Cleanup do spec da migration: drops **sequenciais** child→parent (não `Promise.all`) — DROP CASCADE concorrente em tabelas com FK (`videos → channels`) causava `deadlock detected`.
  - Lado inverso `@OneToMany(() => Video, ...)` adicionado em `Channel`.

### SI-03.4 — Módulo de vídeos, fila e PublicId service
- **Status:** completed
- **Tests:** 5 passing (public-id.service.spec 4 + videos.module.spec 1)
- **Observations:**
  - Deps instaladas: `@nestjs/bullmq@^11.0.4`, `bullmq@^5.79.2`, `nanoid@^3.3.15` (v3 pin — CJS, compat com build commonjs).
  - `PublicIdService.generateUnique(exists)` recebe predicate de colisão (injeção de predicate em vez de acoplar ao repo) → unit test com nanoid real + colisão simulada. Alfabeto customAlphabet 62-char alfanumérico (sem `_`/`-`), 11 chars. Constantes em `videos.constants.ts` (`VIDEO_QUEUE`, `VIDEO_JOB`, alfabeto, retries).
  - `VideosModule` registra `TypeOrmModule.forFeature([Video])` + `BullModule.registerQueue({ name: 'video-processing', ... attempts:3, backoff exp, removeOnComplete, removeOnFail:100 })`; exporta `VideosRepository` + `PublicIdService`.
  - `BullModule.forRootAsync` no `AppModule` via `redisConfig.KEY` (ConfigType); `VideosModule` importado.
  - Module compilation spec (.spec.ts, unit): override de `getRepositoryToken(Video)` + `getQueueToken('video-processing')` com `{}` → `compile()` resolve DI sem tocar Postgres/Redis (mesma estratégia do storage.module.spec).

### SI-03.5 — Upload: iniciar (POST /videos)
- **Status:** completed
- **Tests:** 10 passing (videos.service.spec 4 + videos.module.spec 1 + videos-upload.e2e-spec 5)
- **Observations:**
  - Allowlist de content-type e cap de 10 GiB checados no **service** (não no DTO) → mapeiam para `INVALID_CONTENT_TYPE` (400) e `VIDEO_UPLOAD_TOO_LARGE` (413) via domain exceptions, não para o 400 genérico de validação. DTO valida `title` 1..255, `contentType` string não-vazia, `sizeBytes` int ≥ 1.
  - `id` (uuid) gerado com `randomUUID()` antes do save p/ compor `storage_key = videos/{id}/original` (NOT NULL). Reusa `STORAGE.MAX_UPLOAD_SIZE_BYTES` / `MULTIPART_PART_SIZE_BYTES` (sem duplicar constantes).
  - Exceptions novas em `src/videos/exceptions/video.exceptions.ts` (subclasses de `DomainException` da Fase 02) — mapeadas pelo `DomainExceptionFilter` global.
  - `ChannelsService.findByUserId(userId)` adicionado (resolve o canal 1:1 do usuário); `VideosModule` importa `ChannelsModule` + `StorageModule`. `VideosRepository` ganhou `create`/`save`.
  - Module compilation spec (.spec unit) faz override de `getRepositoryToken(Video)`, `getRepositoryToken(Channel)`, `getQueueToken`, `StorageService`, `ChannelsService` → compila sem tocar Postgres/Redis/MinIO.
  - E2E reusa fluxo register→confirm (spy em `MailService.sendConfirmationEmail`)→login p/ token do dono (canal criado no signup).

### SI-03.6 — Upload: concluir e abortar
- **Status:** completed
- **Tests:** unit 10 passing (videos.service.spec: +6 complete/abort) + e2e 9 passing (videos-upload.e2e-spec: +4 complete/abort, fila real)
- **Observations:**
  - Ownership + precondição compartilhadas em `getUploadableOwned(user, id)`: resolve canal do dono via `ChannelsService.findByUserId`, `findById`, e mapeia não-dono/inexistente → `VIDEO_NOT_FOUND` (404), estado ≠ `draft`/`uploading` → `VIDEO_NOT_UPLOADABLE` (409). Checagem de estado ANTES de tocar storage (409 não chama S3).
  - `completeUpload`: `completeMultipartUpload` → `headObjectSize` → rejeita > 10 GiB (`VIDEO_UPLOAD_TOO_LARGE`) → grava `size_bytes` real, zera `upload_id`, `status = processing`, enfileira `VIDEO_JOB.PROCESS` (`'process-video'`) com `{ videoId }`. `abortUpload`: `abortMultipartUpload` e mantém o draft (não salva).
  - Fila injetada com `@InjectQueue(VIDEO_QUEUE)`; `defaultJobOptions` (attempts/backoff) já no `registerQueue` (SI-03.4), `add()` sem opts.
  - Novas exceptions `VideoNotFoundException` / `VideoNotUploadableException` em `video.exceptions.ts` (mapeadas pelo `DomainExceptionFilter`).
  - Repo ganhou `findById(id)`. Novo DTO `CompleteUploadDto` (`parts[]` com `@ValidateNested`/`@Type` → nested `partNumber`/`etag`).
  - E2E do happy-path faz upload real de 1 part ao MinIO via `fetch` PUT na URL pré-assinada (etag do header) e confirma job enfileirado via `getQueueToken(VIDEO_QUEUE)` + `getJobs`; `beforeEach` limpa a fila com `obliterate({ force: true })` p/ isolamento.

### SI-03.7 — Worker de vídeo (ffprobe + thumbnail + status)
- **Status:** completed
- **Tests:** 9 passing (ffmpeg.util.spec 5 + video.processor.integration-spec 4) — MinIO + ffmpeg + DB reais
- **Observations:**
  - Worker roda em processo separado via `src/worker.ts` (`NestFactory.createApplicationContext`) + `WorkerModule` dedicado (TD-03 Opção A). O `VideoProcessor` é registrado **só** no `WorkerModule` — nunca no `AppModule`/`VideosModule` — senão a API HTTP também instanciaria o `Worker` e consumiria jobs (quebraria a separação API/worker).
  - **Bug pego no boot ao vivo (corrigido):** `WorkerModule` com `autoLoadEntities: true` + `forFeature([Video])` falhava com `Entity metadata for Video#channel was not found` — `autoLoadEntities` só enxerga entidades de `forFeature` no grafo do módulo, e o `@ManyToOne(Channel)` do Video puxa `Channel → User`. Corrigido com `entities: [User, Channel, Video]` explícito no `forRootAsync` (grafo fechado; RefreshToken/VerificationToken não são referenciados). Worker sobe limpo: TypeORM conecta, todos os módulos inicializam, "Video worker started".
  - **ffmpeg adicionado ao `Dockerfile.dev` (nestjs-api):** o teste de integração do processor roda no container `nestjs-api` (harness padrão per `nestjs-project/CLAUDE.md`), que não tinha ffmpeg (só o worker tinha, via `Dockerfile.worker`). TD-03 mantém a imagem worker de produção enxuta; a imagem dev é compartilhada e roda os testes, então ffmpeg foi adicionado lá. Exigiu rebuild + recreate do `nestjs-api`.
  - `ffmpeg.util.ts` separa funções puras testáveis (`parseFfprobeJson`, `buildFfprobeArgs`, `buildThumbnailArgs`) dos orquestradores `spawn` (`ffprobe`/`captureThumbnail`) — unit testa parsing/args sem spawnar. Thumbnail capturada em `-ss 1` (ou 0 se duração ≤ 1s).
  - `StorageService.downloadToFile(key, destPath)` adicionado (stream GetObject → arquivo via `pipeline`) para o worker baixar o original antes de probe/thumbnail.
  - Idempotência: `process()` re-deriva tudo e sobrescreve (`status = ready`, zera `failure_reason`). `@OnWorkerEvent('failed')` só marca `failed` + `failure_reason` quando `attemptsMade >= opts.attempts` (retries esgotados, TD-07); handler de background faz catch-and-log sem rethrow (regra nestjs-services).
  - Fixture de vídeo do teste de integração é gerada em runtime com `ffmpeg -f lavfi -i testsrc` (mp4 2s 160x120); metadata assertada `width:160, height:120`.
  - Scripts adicionados: `start:worker`, `start:worker:dev` (`nest start --entryFile worker`), `start:worker:prod`. `compose.yaml` `video-worker` agora roda `npm run start:worker:dev` (antes idle `tail -f /dev/null`).

### SI-03.8 — Entrega: metadados, streaming e download
- **Status:** completed
- **Tests:** unit 18 passing (videos.service.spec: +8 delivery) + e2e 5 passing (test/videos-delivery.e2e-spec) — DB real
- **Observations:**
  - **Auth opcional (crux do AMB-1):** GET metadados/stream/download são `@Public()` (anônimo assiste `ready`), mas o dono precisa ser identificado p/ ver o próprio vídeo não-`ready`. `@Public()` sozinho faz o `JwtAuthGuard` global retornar `true` sem popular `request.user`. Criado `OptionalJwtAuthGuard` (auth/guards) — verifica o Bearer se presente, seta `request.user`, **nunca** rejeita. Aplicado com `@Public()` + `@UseGuards(OptionalJwtAuthGuard)`; `@CurrentUser()` devolve payload ou `undefined`.
  - `OptionalJwtAuthGuard` provido + exportado pelo `AuthModule` (precisa do `JwtService`); `VideosModule` passou a importar `AuthModule` (sem ciclo — AuthModule não importa VideosModule; APP_GUARD singleton não duplica).
  - Política de acesso (TD-06 AMB-1) centralizada no service: `getPublicView` e `resolveDeliveryUrl` resolvem `isOwner` via `channelsService.findByUserId(user.sub)`. `ready` → todos; não-`ready` + dono → visível (metadados 200) / `VIDEO_NOT_READY` 409 (stream/download); não-`ready` + não-dono → `VIDEO_NOT_FOUND` 404.
  - Nova exception `VideoNotReadyException` (409 `VIDEO_NOT_READY`) mapeada pelo `DomainExceptionFilter`. `VideosRepository.findByPublicId` adicionado.
  - Stream/download respondem `302` via `@Res() res: Response` + `res.redirect(302, presignedUrl)` (presign GET 1h; download com `downloadFilename = '{title}.{ext}'`, ext derivada do `content_type`). Rotas `:publicId` e `:publicId/stream|download` não colidem (paths distintos).
  - E2E seed direto via repo (User→Channel→Video); presign não exige objeto real no MinIO (só assina URL), então casos de status/302/404/409 rodam sem upload de bytes. `supertest` não segue redirect por padrão → `.expect(302)` + `headers.location`.
  - **Assumção do plano confirmada:** decorator de rota pública herdado da Fase 02 existe (`src/auth/decorators/public.decorator.ts`) — não precisou criar.

### SI-03.9 — Exclusão de vídeo
- **Status:** completed
- **Tests:** unit 23 passing (videos.service.spec: +5 deleteVideo) + e2e 8 passing (videos-delivery.e2e-spec: +3 delete) — DB real
- **Observations:**
  - `VideosService.deleteVideo(user, id)`: resolve dono via `channelsService.findByUserId`; não-dono/id inexistente → `VIDEO_NOT_FOUND` (404). Se `upload_id` presente → `abortMultipartUpload` antes; `deleteObject(storage_key)` + `deleteObject(thumbnail_key)` (best-effort, o `deleteObject` já engole erro); por fim `repository.delete(id)`.
  - Checagem de ownership inline (mesma forma `!video || !channel || channel_id !==` do `getUploadableOwned`) — não extraí helper compartilhado p/ não tocar código do SI-03.6 já fechado; delete não tem precondição de estado (apaga qualquer status).
  - `DELETE /videos/:id` (204, autenticado — sem `@Public`, guard global exige token → 401 sem auth). `VideosRepository.delete(id)` adicionado.
  - Sem conflito de rota: `DELETE :id` é método distinto dos `GET :publicId*`.

### Fechamento — Validação manual do upload de 10GB (ROTEIRO 3.8) + DoD

- **Bug de produção pego na validação manual (corrigido):** o `WorkerModule` registrava só a **conexão** do BullMQ (`BullModule.forRootAsync`), sem `BullModule.registerQueue({ name: VIDEO_QUEUE })`. No `@nestjs/bullmq`, um `@Processor(fila)` só vira um `Worker` ativo quando a fila é registrada no módulo — sem isso o processor era instanciado mas **nunca consumia**, e os jobs ficavam parados na lista `wait` da fila (status preso em `processing`). Os testes não pegaram porque `video.processor.integration-spec` chama `processor.process()` **direto**, sem passar pelo mecanismo de fila. Confirmado na doc oficial via context7. Correção: `registerQueue({ name: VIDEO_QUEUE })` adicionado ao `WorkerModule`.
- **Teste de regressão adicionado:** `src/worker.module.integration-spec.ts` sobe o `WorkerModule` real, enfileira um job pela fila de verdade e afirma que o worker o consome e leva o vídeo a `ready` (duração + thumbnail). Falha se a `registerQueue` for removida de novo. +1 teste → 196/196.
- **Validação manual executada** (script `test-10gb-upload.sh`, fluxo real contra o Compose): register → confirm (Mailpit) → login → `POST /videos` (rascunho + multipart pré-assinado, 103 partes) → PUT de 10 GiB **direto ao MinIO** (nunca pela API) → `POST /videos/:id/complete` (valida cap 10 GiB, `processing`, enfileira) → worker consome.
  - **API não trava:** probe `GET /` a cada 2s durante o envio → 33/33 amostras `200`, latência ~2-5ms (arquivo vai direto ao storage, não pela API).
  - **Caminho de erro:** arquivo de zeros (10 GiB) → ffprobe rejeita (`Invalid data`) → após 3 tentativas `status=failed` + `failure_reason`.
  - **Caminho de sucesso:** MP4 real → `status=ready`, `duration_seconds=3`, `metadata={codec:h264,width:320,height:240,bitrate}`, `thumbnail_key` gerado; `GET /videos/:publicId/stream` → `302` para URL pré-assinada (MinIO serve Range/206).
