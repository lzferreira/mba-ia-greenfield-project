---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-02T15:56:15-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-02T15:56:02-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T13:09:45-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-02T11:09:32-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver StreamTube's video upload and processing pipeline: object storage (MinIO/S3), a background queue (BullMQ + Redis) consumed by a separate FFmpeg worker, presigned multipart upload of files up to 10GB without blocking the API, automatic draft pre-registration at upload start, automatic duration/metadata + thumbnail extraction, a unique per-video URL, and streaming (HTTP Range) plus download delivery — with a `draft → uploading → processing → ready | failed` status lifecycle persisted on a video entity tied to a channel.

---

## Step Implementations

### SI-03.1 — Infra: object storage, fila e worker no Compose

**Description:** Subir a infraestrutura nova da fase — MinIO (storage S3), Redis (fila) e o container do worker de vídeo — junto com a stack existente, mais as variáveis de ambiente e sua validação.

**Technical actions:**

1. Adicionar serviço `minio` em `compose.yaml` (imagem `minio/minio`, portas API+console, volume, credenciais) — bucket único privado (per `phase-03-videos/TD-08`); hosts sempre pelo nome do serviço Compose, nunca `localhost`.
2. Adicionar serviço `redis` em `compose.yaml` (imagem `redis`, volume de persistência) — broker da fila BullMQ (per `phase-03-videos/TD-01`).
3. Adicionar serviço `video-worker` em `compose.yaml` — mesma codebase/imagem do `nestjs-api` com estágio Dockerfile que instala FFmpeg/ffprobe e entrypoint dedicado ao worker (per `phase-03-videos/TD-03`).
4. Declarar as env vars novas em `.env`/`.env.example` (`MINIO_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_BUCKET`, `S3_REGION`, `REDIS_HOST`, `REDIS_PORT`) e estendê-las no schema Joi de `src/config/env.validation.ts` (per `phase-01-configuracao-base/TD-02`).

**Tests:** _(empty — Infra; validado por `docker compose up -d` + `docker compose ps` mostrando `minio`, `redis`, `video-worker` running)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis` e `video-worker` além de `nestjs-api`, `db` e `mailpit`, todos em status `running`.
- A API sobe sem erro de validação de ambiente com as novas variáveis presentes, e falha no boot quando uma variável obrigatória nova está ausente.
- O container `video-worker` tem `ffmpeg` e `ffprobe` disponíveis no `PATH`.

---

### SI-03.2 — Config namespaces e StorageService (S3 client + bootstrap do bucket)

**Description:** Encapsular o acesso ao object storage num serviço tipado — client S3 apontando para o MinIO, geração de URLs pré-assinadas (multipart e GET), HeadObject e delete — e garantir bucket + regra de ciclo de vida no startup.

**Technical actions:**

1. Criar `src/config/storage.config.ts` (`registerAs('storage', ...)`) com `endpoint`, `region`, `bucket`, `credentials`, `forcePathStyle: true` (obrigatório para MinIO) e `src/config/redis.config.ts` com `host`/`port` (per `phase-03-videos/TD-08`, `phase-01-configuracao-base/TD-03`).
2. Criar `src/storage/storage.service.ts` envolvendo `S3Client` (`@aws-sdk/client-s3`) — métodos `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `presignGet`, `deleteObject`, usando `getSignedUrl` (`@aws-sdk/s3-request-presigner`) com `expiresIn: 3600` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`).
3. Criar `src/storage/storage.module.ts` e, no `OnModuleInit`, criar o bucket se ausente e aplicar `PutBucketLifecycleConfiguration` com `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }` (per `phase-03-videos/TD-02` AMB-2, `phase-03-videos/TD-08`).
4. Definir a convenção de chaves: `videos/{id}/original` e `videos/{id}/thumbnail.jpg` (per `phase-03-videos/TD-08`), exposta por helpers no `StorageService`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): presign UploadPart + PUT + complete roundtrip, `headObject` size, `presignGet` retorna URL que serve Range/206, lifecycle rule criada | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO e as env vars precisam existir.

**Acceptance criteria:**

- Um upload multipart pré-assinado emitido pelo `StorageService` conclui contra o MinIO e o objeto resultante é legível via `presignGet` respondendo `206 Partial Content` a requisições com header `Range`.
- Após o boot, o bucket configurado existe e possui a regra de ciclo de vida expirando uploads multipart incompletos em 7 dias.
- `headObject` de uma chave inexistente propaga erro distinto de "objeto vazio", permitindo o enforcement de tamanho no complete.

---

### SI-03.3 — Migration e entidade Video

**Description:** Persistência da fase — a entidade `Video` ligada ao canal e a migration que cria o tipo enum de status e a tabela `videos`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` conforme o Data Model (id, `channelId`, `title`, `status`, `publicId`, `storageKey`, `thumbnailKey`, `uploadId`, `contentType`, `sizeBytes`, `durationSeconds`, `metadata`, `failureReason`, timestamps) com `@ManyToOne` para `Channel` e enum `VideoStatus` (`draft|uploading|processing|ready|failed`) (per `phase-03-videos/TD-07`, `phase-03-videos/TD-05`, `phase-03-videos/TD-08`).
2. Adicionar o lado inverso `@OneToMany(() => Video, ...)` em `Channel` (relação com o canal dono).
3. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` — cria o tipo `video_status`, a tabela `videos`, a FK `channel_id → channels(id)` on delete cascade, o índice único em `public_id` e índices em `channel_id` e `status`; `down` reverte na ordem inversa (tabela antes do enum).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = draft`, unicidade de `public_id`, NOT NULL de `channel_id`/`title`/`storage_key`, cascade ao apagar o canal | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: up cria enum+tabela+índices; down remove tudo sem vazar o tipo enum | `src/database/migrations/create-videos.integration-spec.ts` |

**Dependencies:** none — depende apenas de `channels` (entregue na Fase 02).

**Acceptance criteria:**

- Após rodar a migration, inserir dois vídeos com o mesmo `public_id` viola a constraint de unicidade.
- Um `Video` recém-inserido sem `status` explícito persiste com `status = 'draft'`.
- Apagar o canal dono remove em cascata seus vídeos.

---

### SI-03.4 — Módulo de vídeos, fila e PublicId service

**Description:** Esqueleto do módulo `videos/` com o repository pattern, o registro da fila BullMQ (produtor) e o serviço de geração de identificador único de URL.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` registrando `TypeOrmModule.forFeature([Video])` e a fila via `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 100 } })` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-07`).
2. Registrar `BullModule.forRootAsync` no `AppModule` usando `redis.config` (`connection: { host, port }`) e importar `VideosModule` (per `phase-03-videos/TD-01`).
3. Criar `src/videos/videos.repository.ts` — wrapper de acesso a dados de `Video` (repository pattern, seguindo a forma dos módulos existentes).
4. Criar `src/videos/public-id.service.ts` — `customAlphabet`/`nanoid` de 11 chars com retry em violação de unicidade (per `phase-03-videos/TD-05`); pin `nanoid@^3` (CJS).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `PublicIdService` | Unit (nanoid real): comprimento 11, alfabeto URL-safe, retry gera id distinto ao colidir | `src/videos/public-id.service.spec.ts` |
| `VideosModule` | Unit: compilation test (fila e providers resolvem) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 (entidade) + SI-03.2 (redis.config) + SI-03.1 (Redis no Compose).

**Acceptance criteria:**

- `PublicIdService.generate()` retorna sempre 11 caracteres do alfabeto URL-safe.
- Diante de uma colisão simulada de `public_id`, o serviço tenta novamente e devolve um id distinto em vez de propagar o erro.
- O módulo compila com a fila `video-processing` injetável via `@InjectQueue`.

---

### SI-03.5 — Upload: iniciar (POST /videos, rascunho + multipart pré-assinado)

**Description:** Endpoint que pré-cadastra o vídeo como rascunho ao iniciar o upload e devolve as URLs pré-assinadas de multipart, sem passar os bytes pela API.

**Technical actions:**

1. Criar `src/videos/dto/initiate-upload.dto.ts` — `title`, `contentType`, `sizeBytes` com as regras de `### API Contracts → Validation Rules` (class-validator) (per `phase-03-videos/TD-02`).
2. Implementar `VideosService.initiateUpload(user, dto)` — resolver o canal do usuário, validar `sizeBytes ≤ 10 GiB` (senão `VIDEO_UPLOAD_TOO_LARGE`) e `contentType` na allowlist (senão `INVALID_CONTENT_TYPE`), gerar `publicId`, persistir `Video` como `draft` com `storageKey = videos/{id}/original`, chamar `createMultipartUpload` e presign de `ceil(sizeBytes/100MiB)` part URLs (per `phase-03-videos/TD-02`).
3. Implementar `POST /videos` em `src/videos/videos.controller.ts` (guard JWT global, dono autenticado) retornando o corpo `201` de `### API Contracts` (`id`, `publicId`, `status`, `uploadId`, `partSize`, `parts[]`); documentar com decorators Swagger (per convenção herdada `openapi-docs-nestjs`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit (mock repo/storage): ramo tamanho > 10GB, ramo content-type inválido, caminho feliz cria draft + presign | `src/videos/videos.service.spec.ts` |
| `POST /videos` + DTO | E2E: `201` com shape esperado; `413 VIDEO_UPLOAD_TOO_LARGE`; `400 INVALID_CONTENT_TYPE`; `400` validação; `401` sem token | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.4 (módulo, repo, publicId) + SI-03.2 (StorageService).

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `publicId`, `uploadId` e um array `parts` de tamanho `ceil(sizeBytes/104857600)`, e cria uma linha `Video` com `status = draft`.
- `POST /videos` com `sizeBytes` acima de 10 GiB retorna `413` com `error: "VIDEO_UPLOAD_TOO_LARGE"` e não cria linha.
- `POST /videos` com `contentType` fora da allowlist retorna `400` com `error: "INVALID_CONTENT_TYPE"`.
- `POST /videos` sem token retorna `401`.

---

### SI-03.6 — Upload: concluir e abortar

**Description:** Fecha o multipart (com enforcement do teto de 10GB pelo tamanho real), transiciona o vídeo para `processing` e publica o job na fila; e o endpoint de abortar, que libera o multipart incompleto no storage.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` — `parts: { partNumber, etag }[]` (validação per `### API Contracts → Validation Rules`).
2. Implementar `VideosService.completeUpload(user, id, dto)` — exigir dono e estado `draft`/`uploading` (senão `VIDEO_NOT_FOUND`/`VIDEO_NOT_UPLOADABLE`), `completeMultipartUpload`, `headObject` e rejeitar se o tamanho real > 10 GiB (`VIDEO_UPLOAD_TOO_LARGE`), gravar `sizeBytes`, limpar `uploadId`, setar `status = processing` e enfileirar `video.process` com `{ videoId }` (per `phase-03-videos/TD-02`, `### Events/Messages`).
3. Implementar `VideosService.abortUpload(user, id)` — exigir dono e estado `draft`/`uploading`, `abortMultipartUpload` e manter o rascunho (per `phase-03-videos/TD-02` AMB-2).
4. Implementar `POST /videos/:id/complete` (200) e `POST /videos/:id/abort` (204) no controller (dono autenticado) (per `### API Contracts`, `### Authorization Matrix`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload/abortUpload` | Unit (mock repo/storage/queue): estado inválido, tamanho real > 10GB, caminho feliz enfileira job; abort chama `abortMultipartUpload` | `src/videos/videos.service.spec.ts` |
| `POST /videos/:id/complete` e `/abort` | E2E (fila real): `200`→`processing` e job enfileirado; `409 VIDEO_NOT_UPLOADABLE`; `404 VIDEO_NOT_FOUND` para não-dono; `204` no abort | `test/videos-upload.e2e-spec.ts` |

**Dependencies:** SI-03.5 (vídeo em `draft` com `uploadId`).

**Acceptance criteria:**

- `POST /videos/:id/complete` de um draft do dono retorna `200` com `status: "processing"`, grava `sizeBytes` e enfileira um job `video.process` com o `videoId` correto.
- `POST /videos/:id/complete` quando o objeto real excede 10 GiB retorna `413 VIDEO_UPLOAD_TOO_LARGE` e não enfileira job.
- `POST /videos/:id/complete` ou `/abort` sobre vídeo que não está em `draft`/`uploading` retorna `409 VIDEO_NOT_UPLOADABLE`.
- `POST /videos/:id/abort` do dono retorna `204` e o rascunho permanece consultável para reinício ou exclusão.
- Qualquer das rotas com `:id` de outro dono retorna `404 VIDEO_NOT_FOUND`.

---

### SI-03.7 — Worker de vídeo (ffprobe + thumbnail + ciclo de status)

**Description:** Processo consumidor que roda no container separado: consome o job, extrai duração/metadados, gera a thumbnail, grava as chaves e transiciona o vídeo para `ready` — ou `failed` com motivo ao esgotar as tentativas.

**Technical actions:**

1. Criar `src/videos/video.processor.ts` — `@Processor('video-processing')` estendendo `WorkerHost`; no `process(job)`, carregar o vídeo, obter o objeto original do storage e orquestrar as etapas (per `phase-03-videos/TD-03`, `### Events/Messages`).
2. Criar `src/videos/ffmpeg.util.ts` — utilitário tipado sobre `spawn` para `ffprobe` (JSON de duração/`width`/`height`/`codec`/`bitrate`) e `ffmpeg` (captura de 1 frame como `thumbnail.jpg`) (per `phase-03-videos/TD-04`).
3. Persistir `durationSeconds`, `metadata`, `thumbnailKey = videos/{id}/thumbnail.jpg` (após upload da thumbnail) e `status = ready`; idempotente ao reprocessar.
4. Tratar falha via `@OnWorkerEvent('failed')` — ao esgotar `attempts`, setar `status = failed` e `failureReason` (per `phase-03-videos/TD-07`).
5. Criar o entrypoint do worker (`src/worker.ts` ou bootstrap dedicado) usado pelo serviço `video-worker` do Compose (per `phase-03-videos/TD-03`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ffmpeg.util` | Unit: parse do JSON do ffprobe; montagem correta dos argumentos de captura de frame | `src/videos/ffmpeg.util.spec.ts` |
| `VideoProcessor` | Integration (MinIO + fila + ffmpeg reais, vídeo pequeno de fixture): job leva o vídeo a `ready` com `durationSeconds`, `metadata` e `thumbnailKey`; entrada inválida esgota retries e leva a `failed` com `failureReason` | `src/videos/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.6 (job enfileirado) + SI-03.2 (StorageService) + SI-03.1 (worker + FFmpeg no Compose).

**Acceptance criteria:**

- Ao processar um vídeo válido, o worker grava `durationSeconds` > 0, popula `metadata`, envia a thumbnail para `videos/{id}/thumbnail.jpg` e transiciona o vídeo para `ready`.
- Reexecutar o mesmo job sobre um vídeo já processado não corrompe o estado (idempotência) e o mantém `ready`.
- Um arquivo que o ffprobe não consegue ler leva o vídeo a `status = failed` com `failureReason` preenchido após esgotar as tentativas, sem travar a fila.

---

### SI-03.8 — Entrega: metadados, streaming e download

**Description:** Endpoints de consumo por URL única — metadados do vídeo, streaming via redirect a URL pré-assinada (Range/206 direto do storage) e download — respeitando a política de acesso por status.

**Technical actions:**

1. Implementar `VideosService.getPublicView(publicId, user?)` e a política de acesso: `ready` é público; status não-`ready` só é visível ao dono autenticado, senão `VIDEO_NOT_FOUND` (per `phase-03-videos/TD-06` AMB-1, `### Authorization Matrix`).
2. Implementar `GET /videos/:publicId` (metadados: `publicId`, `title`, `status`, `durationSeconds`, `thumbnailUrl` presign 1h quando `ready`, `metadata`) marcado como rota pública (decorator de rota pública herdado) (per `### API Contracts`).
3. Implementar `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` — resolver o vídeo pela política, presign GET (download com `response-content-disposition: attachment`) e responder `302` para a `Location`; dono pedindo vídeo não-`ready` recebe `409 VIDEO_NOT_READY` (per `phase-03-videos/TD-06`, `### Error Catalog`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPublicView` + resolução de entrega | Unit: `ready` visível a anônimo; não-`ready` 404 para não-dono; dono vê próprio; dono + não-`ready` → not-ready | `src/videos/videos.service.spec.ts` |
| `GET /videos/:publicId`, `/stream`, `/download` | E2E: `200` metadados de `ready` para anônimo; `404` para não-`ready` de terceiro; `302` com `Location` pré-assinada no stream/download; `409 VIDEO_NOT_READY` para dono de vídeo em processamento | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.7 (vídeo alcança `ready` com thumbnail/duração) + SI-03.2 (presign GET).

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `ready` retorna `200` com metadados e `thumbnailUrl` para um usuário anônimo.
- `GET /videos/:publicId` de um vídeo em `processing`/`failed` retorna `404` para qualquer um que não seja o dono, e `200` para o dono autenticado.
- `GET /videos/:publicId/stream` de um vídeo `ready` retorna `302` com `Location` apontando para uma URL pré-assinada que serve `206 Partial Content` a requisições `Range`.
- `GET /videos/:publicId/download` de um vídeo `ready` retorna `302` para uma URL pré-assinada com disposição de anexo.
- O dono pedindo stream/download de vídeo ainda não `ready` recebe `409 VIDEO_NOT_READY`.

---

### SI-03.9 — Exclusão de vídeo

**Description:** Endpoint para o dono apagar um vídeo — libera multipart em andamento, remove os objetos do storage (original + thumbnail) e a linha do banco.

**Technical actions:**

1. Implementar `VideosService.deleteVideo(user, id)` — exigir dono (senão `VIDEO_NOT_FOUND`); se houver `uploadId`, `abortMultipartUpload`; `deleteObject` de `storageKey` e `thumbnailKey` (best-effort) e remover a linha (per `### Authorization Matrix`, `phase-03-videos/TD-08`).
2. Implementar `DELETE /videos/:id` (204, dono autenticado) no controller (per `### API Contracts`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.deleteVideo` | Unit (mock repo/storage): não-dono → not found; aborta multipart pendente; remove objetos e linha | `src/videos/videos.service.spec.ts` |
| `DELETE /videos/:id` | E2E: `204` e vídeo some das consultas; `404 VIDEO_NOT_FOUND` para não-dono e para id inexistente | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.5 (existe vídeo criado) + SI-03.2 (StorageService).

**Acceptance criteria:**

- `DELETE /videos/:id` do dono retorna `204` e uma consulta subsequente por `publicId` retorna `404`.
- `DELETE /videos/:id` de outro dono ou de id inexistente retorna `404 VIDEO_NOT_FOUND`.
- Apagar um vídeo com multipart em andamento não deixa partes órfãs no storage.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → `channels.id`, not null, on delete cascade |
| title | varchar(255) | not null |
| status | enum `video_status` | not null, default `draft` — one of `draft`, `uploading`, `processing`, `ready`, `failed` (per phase-03-videos/TD-07) |
| public_id | varchar(11) | unique, not null — nanoid 11-char URL identifier (per phase-03-videos/TD-05) |
| storage_key | varchar(512) | not null — object key of the video file in the bucket (per phase-03-videos/TD-08, prefixed `videos/{id}/original`) |
| thumbnail_key | varchar(512) | nullable — object key of the generated thumbnail (per phase-03-videos/TD-08, prefixed `videos/{id}/thumbnail.jpg`); null until processing succeeds |
| upload_id | varchar(255) | nullable — S3/MinIO multipart `UploadId`, retained for abort/complete (per phase-03-videos/TD-02); null after complete or abort |
| content_type | varchar(100) | not null — declared MIME type; one of the accepted set (per phase-03-videos/TD-02) |
| size_bytes | bigint | nullable — object size confirmed at complete via HeadObject (per phase-03-videos/TD-02); null while draft |
| duration_seconds | integer | nullable — extracted by ffprobe (per phase-03-videos/TD-04); null until processing succeeds |
| metadata | jsonb | nullable — ffprobe technical metadata (width, height, codec, bitrate) (per phase-03-videos/TD-04); null until processing succeeds |
| failure_reason | text | nullable — set when `status = failed` (per phase-03-videos/TD-07) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now(), updated on change |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id` (the owning channel, delivered by Fase 02). A channel is created 1:1 with a user at signup, so ownership resolves transitively to the authenticated user.

**Indexes:**
- unique on `public_id` (enforces the collision-free unique URL; nanoid retry-on-violation per phase-03-videos/TD-05)
- index on `channel_id` (owner listing / ownership checks)
- index on `status` (worker/admin filtering)

**Migration:** `<timestamp>-CreateVideos.ts` creates the `video_status` Postgres enum type and the `videos` table with the FK to `channels`. Enum-first ordering matters (the enum type must exist before the column references it); drop order is the reverse.

### API Contracts

All routes are under the global JWT guard inherited from Fase 02. Delivery routes for `ready` videos are marked public via the inherited public-route decorator (per phase-03-videos/TD-06 access policy). Mutation routes require the authenticated owner of the video's channel. Error envelope follows the inherited Fase 02 format `{ statusCode, error, message }` with domain codes (phase-02-auth/TD-07).

#### POST /videos (SI-03.5)

Pre-registers the video as a `draft` and initiates the presigned multipart upload (per phase-03-videos/TD-02). The file bytes never pass through the API — the client PUTs each part directly to storage using the returned presigned URLs.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — 1..255 chars
- contentType: string, required — one of `video/mp4`, `video/webm`, `video/x-matroska`, `video/quicktime` (per phase-03-videos/TD-02)
- sizeBytes: number, required — declared file size in bytes; must be > 0 and ≤ 10737418240 (10 GiB) (per phase-03-videos/TD-02)

**Response 201:**
- id: string (uuid) — internal id used for complete/abort/delete
- publicId: string — 11-char unique URL identifier
- status: string — `draft`
- uploadId: string — S3/MinIO multipart UploadId
- partSize: number — 104857600 (100 MiB) (per phase-03-videos/TD-02)
- parts: array of `{ partNumber: number, url: string }` — presigned UploadPart URLs, one per 100 MiB chunk (`ceil(sizeBytes / partSize)` parts), each expiring in 1h (per phase-03-videos/TD-02)

**Error responses:**
- 413 VIDEO_UPLOAD_TOO_LARGE: when `sizeBytes` exceeds 10 GiB
- 400 INVALID_CONTENT_TYPE: when `contentType` is not in the accepted set
- 400 validation error: when the request body fails schema validation
- 404 CHANNEL_NOT_FOUND: when the authenticated user has no channel to own the video

---

#### POST /videos/:id/complete (SI-03.6)

Completes the multipart upload, enforces the 10GB cap against the real object size (HeadObject), transitions the video to `processing`, and enqueues the processing job (per phase-03-videos/TD-02, TD-07). `:id` is the internal uuid.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ partNumber: number, etag: string }`, required — the ETags returned by storage for each uploaded part, in order

**Response 200:**
- id: string (uuid)
- publicId: string
- status: string — `processing`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:id` is owned by the caller
- 409 VIDEO_NOT_UPLOADABLE: when the video is not in `draft`/`uploading` state
- 413 VIDEO_UPLOAD_TOO_LARGE: when the completed object size exceeds 10 GiB (HeadObject check)
- 400 validation error: when the parts list fails schema validation

---

#### POST /videos/:id/abort (SI-03.6)

Aborts an in-progress multipart upload (AbortMultipartUpload) so storage does not retain uncommitted parts, and leaves the `draft` row for the owner to restart or delete (per phase-03-videos/TD-02 abandoned-upload policy, AMB-2). `:id` is the internal uuid.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:id` is owned by the caller
- 409 VIDEO_NOT_UPLOADABLE: when the video is not in `draft`/`uploading` state

---

#### GET /videos/:publicId (SI-03.8)

Returns video metadata by public URL identifier. Public for `ready` videos; non-ready videos are visible only to the authenticated owner and return 404 to everyone else (per phase-03-videos/TD-06 access policy, AMB-1).

**Response 200:**
- publicId: string
- title: string
- status: string
- durationSeconds: number | null
- thumbnailUrl: string | null — presigned GET URL for the thumbnail (1h), when `ready`
- metadata: object | null — ffprobe technical metadata

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the publicId does not exist, or the video is non-ready and the caller is not the owner

---

#### GET /videos/:publicId/stream (SI-03.8)

Streaming playback without full download: responds `302 Found` redirecting to a presigned GET URL on storage; the client's HTTP Range requests hit MinIO/S3 directly and receive `206 Partial Content` (per phase-03-videos/TD-06). Public for `ready` videos.

**Response 302:**
- Location: presigned GET URL for `storage_key`, expiring in 1h (per phase-03-videos/TD-06)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the publicId does not exist, or the video is non-ready and the caller is not the owner
- 409 VIDEO_NOT_READY: when the owner requests stream/download for a video that has not finished processing

---

#### GET /videos/:publicId/download (SI-03.8)

Download of the original file: responds `302 Found` redirecting to a presigned GET URL carrying `response-content-disposition: attachment` (per phase-03-videos/TD-06). Public for `ready` videos.

**Response 302:**
- Location: presigned GET URL for `storage_key` with attachment disposition, expiring in 1h (per phase-03-videos/TD-06)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the publicId does not exist, or the video is non-ready and the caller is not the owner
- 409 VIDEO_NOT_READY: when the owner requests download for a video that has not finished processing

---

#### DELETE /videos/:id (SI-03.9)

Deletes a video owned by the caller: removes the storage objects (original + thumbnail, best-effort) and the DB row. Aborts any in-progress multipart first. `:id` is the internal uuid.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:id` is owned by the caller

---

#### Validation Rules — Videos

- `title`: required, string, 1..255 chars
- `contentType`: required, must be one of `video/mp4`, `video/webm`, `video/x-matroska`, `video/quicktime`
- `sizeBytes`: required, integer, > 0, ≤ 10737418240
- `parts[].partNumber`: required, integer, ≥ 1
- `parts[].etag`: required, non-empty string

### Authorization Matrix

Access policy per phase-03-videos/TD-06 (AMB-1): `ready` videos are delivered publicly; non-ready statuses (`draft`/`uploading`/`processing`/`failed`) are visible only to the authenticated owner and 404 to everyone else. "Owner" = the authenticated user whose 1:1 channel owns the video.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ (creates in own channel) | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| POST /videos/:id/abort | ✗ | ✗ | ✓ |
| DELETE /videos/:id | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ if `ready` (else 404) | ✓ if `ready` (else 404) | ✓ (any status) |
| GET /videos/:publicId/stream | ✓ if `ready` (else 404) | ✓ if `ready` (else 404) | ✓ if `ready` (else 409 VIDEO_NOT_READY) |
| GET /videos/:publicId/download | ✓ if `ready` (else 404) | ✓ if `ready` (else 404) | ✓ if `ready` (else 409 VIDEO_NOT_READY) |

### Error Catalog

Response shape inherited from phase-02-auth/TD-07: `{ statusCode, error, message }` with a machine-readable domain `error` code. Domain codes new to this phase:

| error code | HTTP | Trigger |
|------------|------|---------|
| VIDEO_NOT_FOUND | 404 | Video id/publicId not found, or a non-ready video accessed by a non-owner |
| CHANNEL_NOT_FOUND | 404 | Authenticated user has no channel to own the video (should not happen — channel is 1:1 at signup) |
| INVALID_CONTENT_TYPE | 400 | `contentType` not in the accepted set (`video/mp4`, `video/webm`, `video/x-matroska`, `video/quicktime`) |
| VIDEO_UPLOAD_TOO_LARGE | 413 | Declared `sizeBytes` (at initiate) or real object size (at complete, HeadObject) exceeds 10 GiB |
| VIDEO_NOT_UPLOADABLE | 409 | complete/abort called on a video not in `draft`/`uploading` state |
| VIDEO_NOT_READY | 409 | Owner requests stream/download for a video that has not finished processing (`status != ready`) |

**Non-HTTP terminal state:** processing failure does not surface as an HTTP error at delivery time — the worker sets `status = failed` and records `failure_reason` (per phase-03-videos/TD-07). Failed videos behave as non-ready for the access policy above.

### Events/Messages

Queue: **`video-processing`** on BullMQ + Redis (per phase-03-videos/TD-01). One job type. The API is the producer; a separate worker container is the consumer (per phase-03-videos/TD-03).

#### video.process

**Payload:**

```json
{ "videoId": "uuid" }
```

Only the id is carried — the worker loads the row and resolves `storage_key` itself (no large data on the queue).

**Producer:** `VideosService` (per phase-03-videos/TD-02) — enqueues on successful `POST /videos/:id/complete`, after the object-size check passes and status is set to `processing`.
**Consumer:** `VideoProcessor` worker, `@Processor('video-processing')` extending `WorkerHost`, running in the dedicated worker container (per phase-03-videos/TD-03). Steps: download/stream the original from storage → `ffprobe` for duration + technical metadata (per phase-03-videos/TD-04) → `ffmpeg` single-frame thumbnail → upload thumbnail to `thumbnail_key` → persist `duration_seconds`, `metadata`, `thumbnail_key`, `size_bytes` and set `status = ready`.
**Trigger:** multipart upload completed and confirmed within the 10GB cap.
**Delivery semantics:** at-least-once, `attempts: 3` with exponential backoff (`{ type: 'exponential', delay: 1000 }`) (per phase-03-videos/TD-01, TD-07). On exhaustion of retries the `failed` worker event sets `status = failed` and writes `failure_reason` — terminal, no dead-letter queue in this phase (per phase-03-videos/TD-07). The processor must be idempotent (a retried job re-derives metadata + thumbnail and overwrites, safe to repeat).

---

## Dependency Map

```
SI-03.1 (root — infra: MinIO, Redis, worker no Compose)
└── SI-03.2 — depends on SI-03.1 (storage precisa do MinIO + env)
    ├── SI-03.4 — depends on SI-03.3 + SI-03.2 + SI-03.1 (módulo + fila + publicId)
    │   └── SI-03.5 — depends on SI-03.4 + SI-03.2 (iniciar upload)
    │       ├── SI-03.6 — depends on SI-03.5 (concluir/abortar + enfileirar)
    │       │   └── SI-03.7 — depends on SI-03.6 + SI-03.2 + SI-03.1 (worker: ffprobe + thumbnail + status)
    │       │       └── SI-03.8 — depends on SI-03.7 + SI-03.2 (entrega: metadados, stream, download)
    │       └── SI-03.9 — depends on SI-03.5 + SI-03.2 (exclusão)

SI-03.3 (root — migration + entidade Video; depende só de channels da Fase 02)
    └── (consumido por SI-03.4)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, fila e worker no Compose
- [ ] SI-03.2 — Config namespaces e StorageService (S3 client + bootstrap do bucket)
- [ ] SI-03.3 — Migration e entidade Video
- [ ] SI-03.4 — Módulo de vídeos, fila e PublicId service
- [ ] SI-03.5 — Upload: iniciar (POST /videos, rascunho + multipart pré-assinado)
- [ ] SI-03.6 — Upload: concluir e abortar
- [ ] SI-03.7 — Worker de vídeo (ffprobe + thumbnail + ciclo de status)
- [ ] SI-03.8 — Entrega: metadados, streaming e download
- [ ] SI-03.9 — Exclusão de vídeo

**Capability deliverables** (do plano original):

- [ ] Upload de até 10GB funcional sem travar a API (multipart pré-assinado direto ao storage)
- [ ] Processamento automático do vídeo após o upload (duração + metadados via ffprobe)
- [ ] Thumbnail gerada automaticamente a partir de um frame (ffmpeg)
- [ ] URL única por vídeo, sem conflito (`public_id` nanoid com índice único)
- [ ] Streaming funcionando (HTTP Range / 206) sem exigir download completo
- [ ] Download do vídeo disponível
- [ ] Ciclo de status refletido no banco (`draft → uploading → processing → ready | failed`)

**Infra e serviços subindo no Compose:**

- [ ] `minio`, `redis` e `video-worker` sobem via `docker compose up -d` junto com `nestjs-api`, `db` e `mailpit`

**Full test suites** _(sempre dentro do container — per `nestjs-project/CLAUDE.md`)_:

- [ ] Testes unit + integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check limpo (`docker compose exec nestjs-api npx tsc --noEmit` sai com código 0)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
