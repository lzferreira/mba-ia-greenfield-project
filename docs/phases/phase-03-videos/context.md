---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-02T11:09:32-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T13:09:45-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-02T11:09:32-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-02T15:56:02-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-02T11:09:32-0300"
  docs/phases/phase-02-auth/context.md: "2026-07-02T11:09:32-0300"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-02T11:09:32-0300"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-02T11:09:32-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ Per the phase-03 decisions doc `_Subprojects in scope:_` note: the video UI is explicitly out of scope (backend-only phase; UI arrives in Phases 04–05).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (per the phase-03 decisions doc — module, storage service, queue producer, video worker; project-plan.md does not name subproject paths).

**Deferred subprojects:** `next-frontend/` — no video UI in this phase.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Background Processing Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-02 | phase | Cross-layer | 10GB Upload Strategy (no API bottleneck) | decided | A (Presigned multipart direct to storage) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| └─ Last revision: 2026-07-02 — Upload policy parameters fixed (part 100MB, expiry 1h, content types, 10GB enforcement) | | | | | | |
| phase-03-videos/TD-03 | phase | Backend | Video Worker Execution Model | decided | A (Separate container, same codebase) | — |
| phase-03-videos/TD-04 | phase | Backend | FFmpeg/ffprobe Invocation Strategy | decided | A (apt binaries + direct spawn) | — |
| phase-03-videos/TD-05 | phase | Backend | Unique Video URL Identifier | decided | A (nanoid v3, 11 chars, unique index + retry) | nanoid |
| phase-03-videos/TD-06 | phase | Cross-layer | Streaming and Download Delivery Strategy | decided | A (Presigned GET + 302 redirect) | — |
| └─ Last revision: 2026-07-02 — Streaming/download presigned GET URLs expire in 1h | | | | | | |
| phase-03-videos/TD-07 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (enum + queue-managed retries + terminal failed) | — |
| phase-03-videos/TD-08 | phase | Backend | Object Storage Layout and Access Policy (MinIO/S3 usage) | decided | A (single private bucket, prefixed keys) | — |

_`Renders in` column omitted: no TD in scope sets the field explicitly (all `—`)._

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-08 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** retry/backoff/concurrency semantics needed for heavy FFmpeg jobs come built-in, `@nestjs/bullmq@11` matches the installed NestJS 11, and Redis is one small Compose service; pg-boss's transactional enqueue is attractive but its manual NestJS wiring and polling model outweigh that for a video pipeline.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-videos/TD-02

**Recommendation:** it is the S3-native answer to both the 10GB limit and resumability, requires no additional service, and keeps the API as a thin control plane (pre-register draft → issue part URLs → complete → enqueue job).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
**Revisions:**
- 2026-07-02 — Abandoned-upload policy defined: explicit abort endpoint (AbortMultipartUpload) + bucket lifecycle rule expiring incomplete multipart uploads after 7 days; orphan drafts remain and the user may restart the upload or delete the video. Rationale: resolution of validation issue AMB-2 — storage-leak prevention.
- 2026-07-02 — Upload policy parameters fixed: part size 100MB (10GB ⇒ 100 parts), presigned upload-part URLs expire in 1h, accepted content types `video/mp4`, `video/webm`, `video/x-matroska`, `video/quicktime`; the 10GB limit is enforced at initiate (declared size) and at complete (HeadObject size check). Rationale: resolution of validation issue AMB-3 — cross-component contract parameters.

### phase-03-videos/TD-03

**Recommendation:** matches the C4 diagram, keeps single-source-of-truth for entities/config, and delivers real process isolation with one extra Compose service; use a dedicated Dockerfile stage adding FFmpeg only to the worker image if size matters.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** the two commands this phase needs (probe JSON, single-frame capture) don't justify a wrapper, and the only popular wrapper is archived; a small typed utility around `spawn` keeps everything testable and dependency-free.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** short non-enumerable ids match the "URL curta e única" attention point, and the CJS constraint of the installed toolchain rules the v3 line, not v5.
**Libraries:** nanoid

### phase-03-videos/TD-06

**Recommendation:** consistent with the upload decision (storage handles bytes, API handles control), Range/206 comes free and battle-tested from MinIO, and the only real cost is a public-endpoint config that the multipart upload flow (TD-02) already requires.
**Libraries:** —
**Revisions:**
- 2026-07-02 — Phase-03 access policy defined: `ready` videos stream/download publicly (routes marked public, anonymous access allowed — aligned with Fase 05's anonymous viewing); non-ready statuses (draft/uploading/processing/failed) return 404 to everyone except the authenticated owner. Fase 04 refines this with público/unlisted visibility. Rationale: resolution of validation issue AMB-1.
- 2026-07-02 — Streaming/download presigned GET URLs expire in 1h. Rationale: resolution of validation issue AMB-3 (parameter set shared with TD-02).

### phase-03-videos/TD-07

**Recommendation:** matches the graded lifecycle exactly, leans on BullMQ's native retry/backoff instead of hand-rolled logic, and keeps the schema lean; an event log (Option B) can be added in a future phase if operational need appears.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** smallest configuration surface for Compose/tests, fully consistent with the presigned-only access model, and nothing in Phase 03 needs public objects or per-type policies.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI).
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Native NestJS integration is decisive: the guard system allows scoping rate limiting via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`).
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** (1) Architectural fit: the strict-BFF model already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match. (2) Smaller blast radius: a ~50-LOC session helper is grep-friendly and test-friendly via the existing MSW+BFF pattern. (3) Compatibility with Next.js 16 / React 19 built-in `cookies()`.
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** (1) Defense in depth on the cookie content — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection. (2) Single cookie simplifies logout. (3) Room to carry minimal user metadata lets `app/layout.tsx` RSC render authenticated chrome without a per-render `/auth/me` round-trip.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Client-driven and pre-emptive-timer patterns rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** (1) Decoupled from TD-05 — works with Route Handlers OR Server Actions. (2) Aligned with shadcn's canonical form primitive (react-hook-form wrappers). (3) Zod-first ergonomics match the FE foundation.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** (1) Strict-BFF alignment: Route Handlers as the BFF surface keep every mutation visible under `app/api/**`. (2) Test scaffold already exists for Route-Handlers-as-functions. (3) Single mutation surface — uniformity beats per-mutation idiom-picking.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** (1) No first-render flicker, no round-trip — session delivered in the same response as the page HTML. (2) No new BFF endpoint — the cookie is the source of truth, RSC reads it, the Provider broadcasts it.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** (1) First-paint-correct. (2) Single integration pattern across both flows — "RSC owns the token, Client Component owns the input" split. (3) Email-prefetch behavior solved at the backend's idempotent-confirmation level.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Combinar (runtime UI + `openapi.json` exportado) é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Swagger UI apenas em dev/staging via env flag.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and the CLI. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships sending the e-mail; the reset-password destination screen is deferred — link destination remains a 404 until a later phase delivers the screen. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | Umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both deferred. The 3 shipped telas (signup, login, forgot-password) are covered by their own verbs. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Additional guidance for external systems (DB, storage, queue, email) lives in the testing-guide skill's `references/external-systems.md`; consult at implementation time._

### next-frontend

_Deferred subproject — no video UI in this phase; testing requirements will apply when the UI phase lands._
