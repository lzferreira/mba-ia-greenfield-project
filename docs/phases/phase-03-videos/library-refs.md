---
libs:
  "@nestjs/bullmq":
    version: "^11.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-07-02T15:55:20-0300"
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-02T15:55:20-0300"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-02T15:55:20-0300"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-02T15:55:20-0300"
  "nanoid":
    version: "^3.3.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-02T15:55:20-0300"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-02T13:09:45-0300"
---

# phase-03-videos — Library References

Cached docs for the libraries newly fixed by phase-03 decisions. Excerpts are
scoped to the surfaces this phase actually uses (see the referencing TD).
Version pins target the installed toolchain (NestJS 11, CommonJS build).

---

## @nestjs/bullmq  (TD-01 — queue technology)

NestJS 11 integration package for BullMQ. Pin `@nestjs/bullmq@^11` to match
`@nestjs/common@^11`. Coexists with `@nestjs/bull` — distinct metadata keys
(`PROCESSOR_METADATA` / `WORKER_METADATA`), so no conflict.

**Root config (API side) — `BullModule.forRootAsync` with ConfigService:**

```typescript
BullModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    connection: {
      host: config.get('redis.host'),   // Compose service name, e.g. 'redis' — never localhost
      port: config.get('redis.port'),
    },
  }),
  inject: [ConfigService],
})
```

**Register a queue (producer side):**

```typescript
BullModule.registerQueue({
  name: 'video-processing',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
})
```

**Enqueue a job (`@InjectQueue`):**

```typescript
@InjectQueue('video-processing') private readonly queue: Queue;
// ...
await this.queue.add('process-video', { videoId }); // BullMQ signature: add(name, data, opts?)
```

**Consumer / processor (`WorkerHost` + `@Processor`):** this is the worker
process' entry surface (TD-03 = separate container, same codebase).

```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // ffprobe metadata + ffmpeg thumbnail, update DB/storage
  }

  @OnWorkerEvent('completed')
  onCompleted() { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* mark video failed (TD-07) */ }
}
```

Concurrency is a `WorkerOptions` field passed alongside the processor registration.

---

## bullmq  (TD-01 — underlying queue engine)

The Redis-backed engine `@nestjs/bullmq` wraps. Relevant surfaces:

**Retry + exponential backoff** (feeds TD-07 failure handling — queue-managed
retries, terminal `failed` after attempts exhausted):

```typescript
import { Queue } from 'bullmq';

const queue = new Queue('video-processing', {
  connection: { host: 'redis', port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, // 1s, 2s, 4s
    removeOnComplete: true,
    removeOnFail: 100,
  },
});
```

- `attempts` — total tries before the job is moved to `failed`.
- `backoff: { type: 'exponential', delay }` — delay doubles each retry.
- `removeOnComplete: true` / `removeOnFail: N` — keep the queue lean, retain
  last N failures for inspection.
- Terminal `failed` event → set video status `failed` with reason (TD-07).

Worker connects to the same Redis by service name; a standalone worker process
just instantiates `Worker('video-processing', processor, { connection })`
(NestJS does this via `WorkerHost`).

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner  (TD-02, TD-06, TD-08)

S3 v3 client, S3-compatible → points at MinIO in Compose. **MinIO requires
`forcePathStyle: true` and an explicit `endpoint`** (service name host).

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: 'http://minio:9000',   // Compose service name — never localhost
  region: 'us-east-1',
  forcePathStyle: true,            // required for MinIO
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
});
```

**Presigned multipart upload (TD-02 — direct-to-storage 10GB, part 100MB, 1h expiry):**

```typescript
import {
  CreateMultipartUploadCommand, UploadPartCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 1. initiate → returns UploadId
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// 2. per part: presign an UploadPart URL (client PUTs the bytes directly)
const partUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },   // 1h (TD-02/AMB-3)
);

// 3. complete with the collected ETags
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, /* ... */] },
}));

// abort (AMB-2 abandoned-upload endpoint):
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));

// size enforcement at complete (AMB-3 — 10GB cap):
const head = await s3.send(new HeadObjectCommand({ Bucket, Key }));
// head.ContentLength must be <= 10 * 1024**3
```

**Presigned GET for streaming/download (TD-06 — Range/206 handled by MinIO, 1h expiry):**

```typescript
const url = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: 3600 },   // default is 900s if omitted
);
// API returns 302 redirect to this URL; client's Range requests hit MinIO directly.
```

**Bucket lifecycle — expire incomplete multipart uploads after 7 days (AMB-2):**

```typescript
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

await s3.send(new PutBucketLifecycleConfigurationCommand({
  Bucket,
  LifecycleConfiguration: {
    Rules: [{
      ID: 'abort-incomplete-multipart',
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
    }],
  },
}));
```

Notes: `getSignedUrl` default `expiresIn` is 900s — always pass 3600 explicitly.
For any signed `x-amz-*` header, add it to `unhoistableHeaders`.

---

## nanoid  (TD-05 — unique video URL id)

**Pin v3 (`^3.3.x`)** — v4+ is ESM-only and breaks the project's CommonJS
(`typeorm-ts-node-commonjs`) build. v3 ships CJS + ESM.

11-char URL-safe id, unique index + retry-on-collision (TD-05):

```typescript
const { nanoid } = require('nanoid');   // CJS import works on v3
const publicId = nanoid(11);            // e.g. "V1StGXR8_Z5" — [A-Za-z0-9_-]
```

Custom alphabet available if `_`/`-` are undesirable in URLs:

```typescript
import { customAlphabet } from 'nanoid';
const gen = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 11);
const publicId = gen();
```

Collision handling: DB unique index on the column; on unique-violation, regenerate
and retry (a handful of retries is astronomically sufficient at 11 chars).
