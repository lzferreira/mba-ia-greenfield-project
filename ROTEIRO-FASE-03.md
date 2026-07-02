# Roteiro — Fase 03: Upload e Processamento de Vídeos

Passo a passo para conduzir a Fase 03 seguindo o workflow do projeto (research → planejamento → implementação → fechamento). Marque cada item conforme avança.

---

## Etapa 0 — Setup e verificação da base

Objetivo: garantir que o ambiente está funcional e o Git Flow está preparado **antes** de qualquer trabalho.

- [x] **0.1 Confirmar que o repositório é um fork público** do `devfullcycle/mba-ia-greenfield-project`. ✓ `lzferreira/mba-ia-greenfield-project`, remote via SSH.
- [x] **0.2 Criar a branch `dev`** (ela ainda não existe no repositório):
  ```bash
  git checkout main
  git pull
  git checkout -b dev
  git push -u origin dev
  ```
- [x] **0.3 Subir a stack atual do backend** (runtime: Colima):
  ```bash
  cd nestjs-project
  docker compose up -d
  ```
- [x] **0.4 Instalar dependências e rodar migrations**. ⚠️ Sempre **dentro do container** (`docker compose exec nestjs-api npm install`) — instalar no host (macOS) quebra binários nativos e resolução do jest no container Linux.
- [x] **0.5 Confirmar a suíte atual verde** (baseline — se algo já estiver quebrado, resolver antes de começar):
  ```bash
  docker compose exec nestjs-api npm test -- --runInBand   # 144/144 ✓
  docker compose exec nestjs-api npm run test:e2e          # 52/52 ✓
  docker compose exec nestjs-api npx tsc --noEmit          # exit 0 ✓
  docker compose exec nestjs-api npm run lint              # ⚠️ 150 erros pré-existentes — ver pendência na Etapa 4
  ```
  Bugfix aplicado no baseline: `bugfix/migrations-test-enum-leak` → `dev` (teste de migrations vazava o tipo enum entre execuções da suíte).
- [x] **0.6 Criar a branch de trabalho da fase**, a partir de `dev`:
  ```bash
  git checkout dev
  git checkout -b feature/phase-03-videos
  ```

> ⚠️ Nunca commitar direto na `main`. Todo o trabalho da fase acontece em `feature/phase-03-videos`, que volta para `dev` ao final.

---

## Etapa 1 — Research (decisões técnicas)

Objetivo: fechar as decisões em aberto **antes** de planejar. Artefato: `docs/decisions/technical-decisions-phase-03-videos.md`.

- [x] **1.1 Rodar a skill `research`** cobrindo as cinco decisões em aberto. ✓ Documento gerado com **8 TDs** (fila, upload 10GB, worker, FFmpeg, URL única, streaming/download, ciclo de status, layout do storage), todos com recomendação = Opção A:
  1. **Tecnologia de fila** (a decisão de stack da fase — o projeto marca como "TBD"). Candidatas típicas: BullMQ + Redis, RabbitMQ, Kafka. Avaliar integração com NestJS 11, simplicidade operacional no Compose e adequação ao caso (jobs de processamento de vídeo).
  2. **Estratégia de upload de 10GB sem travar a API** — ex.: upload direto ao MinIO/S3 via URL pré-assinada (single PUT vs. multipart), com pré-cadastro do vídeo como rascunho ao iniciar.
  3. **Worker de vídeo** — processo/container separado, como consome a fila, como usa FFmpeg/ffprobe para metadados + thumbnail.
  4. **URL única e streaming** — estratégia de identificador (ex.: nanoid/slug) e streaming via HTTP Range / 206 Partial Content (direto do storage ou proxied).
  5. **Ciclo de status do vídeo** — rascunho → processando → pronto/erro; o que acontece em falha (retry? dead letter? status de erro?).
- [x] **1.2 Revisar criticamente o documento** e **preencher os campos `Decision`** de cada TD. ✓ Todas as 8 recomendações aceitas (Opção A em todos); frontmatter `status: decided`.
- [x] **1.3 Lembrete de escopo**: object storage **não** é decisão aberta — respeitado: TD-08 decide apenas o *uso* (bucket único privado, chaves prefixadas, presigned).
- [ ] **1.4 Commit do artefato de research.**

> ✅ ~~Pendência de ferramenta~~: context7 configurado no `.mcp.json` (resolvido antes da Etapa 2).

---

## Etapa 2 — Planejamento (pipeline)

Objetivo: produzir a pasta `docs/phases/phase-03-videos/` completa, com validação fechando em **clean**. Referência de formato: `docs/phases/phase-02-auth/`.

- [ ] **2.1 `plan-context`** → gera `docs/phases/phase-03-videos/context.md` (consolida o contexto da fase a partir do project-plan + decisões).
- [ ] **2.2 `plan-validate`** → gera `validation.md` (aponta inconsistências, decisões faltando, gaps de dependência).
- [ ] **2.3 `plan-resolve`** → resolve as pendências apontadas, atualiza decisões/contexto e gera `library-refs.md` com as libs novas fixadas e confirmadas via **context7** (esperado nesta fase: SDK S3, lib de fila, FFmpeg/ffprobe wrappers etc.).
- [ ] **2.4 Iterar `plan-validate` ↔ `plan-resolve`** até o `validation.md` fechar com status **clean**. Não avançar antes disso — é critério de reprovação.
- [ ] **2.5 `plan-build`** → gera o plano `phase-03-videos.md`, contendo:
  - Step Implementations (**SI-03.1, SI-03.2, …**)
  - Technical Specifications: **Data Model** (tabela de vídeos ligada ao canal: id, canal dono, título, status, chaves de storage do arquivo e thumbnail, duração, metadados, identificador de URL única), **API Contracts**, **Authorization Matrix**, **Error Catalog** e **Events/Messages** (contratos da fila)
  - **Dependency Map** e **Deliverables**
- [ ] **2.6 (Opcional) `plan-test-specs`** → specs de teste da fase.
- [ ] **2.7 Revisão crítica do plano**: SIs bem fatiados? Contratos e eventos definidos? Rastreabilidade com as decisões? Plano frouxo gera implementação frouxa.
- [ ] **2.8 Commit dos artefatos de planejamento.**

---

## Etapa 3 — Implementação (SI a SI)

Objetivo: implementar conduzido pela skill `implement`, um SI por vez, com a suíte do SI verde antes de avançar. Artefatos: código + `progress.md`.

Ordem provável dos SIs (a ordem real é a do seu plano):

- [ ] **3.1 Infraestrutura no `compose.yaml`**: MinIO (storage), serviço de fila (ex.: Redis/RabbitMQ) e o container do worker, subindo junto com a stack. Hosts sempre pelo nome do serviço Compose (nunca `localhost`).
- [ ] **3.2 Migration** criando a tabela de vídeos (entidade ligada ao canal).
- [ ] **3.3 Módulo `videos/` no backend** (forma de referência: `auth/`): controller, service, repository, DTOs, entidade — respeitando guard JWT global, filtro de exceções, ValidationPipe, repository pattern.
- [ ] **3.4 Fluxo de upload**: endpoint que pré-cadastra o vídeo como rascunho e devolve a URL pré-assinada (ou equivalente da sua decisão); confirmação de upload publica job na fila.
- [ ] **3.5 Worker de vídeo**: consome a fila, extrai duração/metadados (ffprobe), gera thumbnail (FFmpeg), atualiza status e chaves de storage no banco. Tratar falha conforme o ciclo de status decidido.
- [ ] **3.6 Streaming e download**: reprodução via HTTP Range (206 Partial Content) sem download completo; endpoint/URL de download.
- [ ] **3.7 URL única**: identificador único por vídeo, sem conflito.
- [ ] **3.8 Validação manual do upload de 10GB**: gerar um arquivo de teste com `dd` e exercitar o fluxo completo de upload (pré-cadastro → URL pré-assinada/multipart → confirmação), observando que a API não trava durante o envio:
  ```bash
  # Gerar arquivo de 10GB (macOS usa bs=1m minúsculo; em Linux, bs=1M)
  dd if=/dev/zero of=/tmp/test-10gb.bin bs=1m count=10240

  # Alternativa instantânea (arquivo esparso — APFS/ext4 suportam):
  dd if=/dev/zero of=/tmp/test-10gb.bin bs=1 count=0 seek=10G
  ```
  > Nota: o arquivo de `dd` (zeros) valida **upload e multipart**, mas o ffprobe vai falhar no processamento — o que também é útil: exercita o caminho de erro do ciclo de status. Para validar o pipeline completo (metadados + thumbnail), usar um vídeo real; se precisar de um vídeo grande, concatenar um MP4 real várias vezes ou gerar com FFmpeg.
- [ ] **3.9 Testes em cada SI**: unit (`*.spec.ts`), integração com infra real do Compose (`*.integration-spec.ts` — banco, MinIO, fila de verdade, sem mockar o que dá para rodar), e2e (`*.e2e-spec.ts` via supertest).
- [ ] **3.10 Atualizar `progress.md`** a cada SI (status + testes), como na Fase 02.
- [ ] **3.11 Commits pequenos e descritivos por SI**, sempre na branch `feature/phase-03-videos`.

> ⚠️ Reprova automática: passar o arquivo de 10GB pela API travando o sistema; fila/worker/storage simulados em vez de reais no Compose.

---

## Etapa 4 — Fechamento

Objetivo: Definition of Done completa + documentação coerente + Git Flow fechado.

> 📌 **Pendência herdada (resolver antes do push final):** `npm run lint` tem **150 erros pré-existentes** das fases 01–02, quase todos em arquivos de teste (`no-unsafe-*`, `unbound-method` em mocks). Decisão: lint verde só é exigido no fechamento da fase (DoD). Abordagem sugerida: override no `eslint.config.mjs` relaxando regras type-checked apenas para arquivos `*.spec.ts`/`*-spec.ts`, mantendo código de produção estrito.

- [ ] **4.1 Definition of Done inteira**:
  ```bash
  cd nestjs-project
  npm test
  npm run test:e2e
  npx tsc --noEmit   # precisa sair com código 0
  npm run lint
  ```
- [ ] **4.2 Atualizar o `CLAUDE.md`** (raiz e/ou `nestjs-project/`) com a seção de vídeos: módulo, endpoints, fila/worker, storage — refletindo o **estado real do código** (documentação citando arquivo inexistente reprova).
- [ ] **4.3 Revisar os Critérios de Aceite item a item** (lista do enunciado) antes do push.
- [ ] **4.4 Merge `feature/phase-03-videos` → `dev`**; quando estável, `dev` → `main`.
- [ ] **4.5 Push do fork** e conferência final no GitHub (artefatos, código, branches).

---

## Mapa de artefatos entregáveis

| Artefato | Caminho | Gerado por |
|---|---|---|
| Decisões técnicas | `docs/decisions/technical-decisions-phase-03-videos.md` | `research` |
| Contexto da fase | `docs/phases/phase-03-videos/context.md` | `plan-context` |
| Validação (clean) | `docs/phases/phase-03-videos/validation.md` | `plan-validate` |
| Libs fixadas | `docs/phases/phase-03-videos/library-refs.md` | `plan-resolve` |
| Plano executável | `docs/phases/phase-03-videos/phase-03-videos.md` | `plan-build` |
| Progresso | `docs/phases/phase-03-videos/progress.md` | `implement` |
| Módulo de vídeos | `nestjs-project/src/videos/` + migration + worker | `implement` |
| Infra nova | `nestjs-project/compose.yaml` (storage + fila + worker) | `implement` |
| Doc de IA | `CLAUDE.md` atualizado | fechamento |
