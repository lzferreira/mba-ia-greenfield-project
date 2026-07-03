import { randomUUID } from 'crypto';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

/**
 * Exercises the real MinIO service from compose.yaml (per phase-03-videos/TD-08 —
 * object storage is not mocked). Requires the `minio` container to be up.
 */
describe('StorageService (integration)', () => {
  const config = storageConfig();
  let service: StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    service = new StorageService(config);
    await service.onModuleInit(); // bootstraps bucket + best-effort lifecycle rule
  }, 30000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await service.deleteObject(key);
    }
  });

  it('completes a presigned multipart upload and confirms the object size via HeadObject', async () => {
    const key = `videos/${randomUUID()}/original`;
    createdKeys.push(key);
    const body = Buffer.from('the quick brown fox jumps over the lazy dog');

    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    const partUrl = await service.presignUploadPart(key, uploadId, 1);

    const putRes = await fetch(partUrl, { method: 'PUT', body });
    expect(putRes.status).toBe(200);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    const size = await service.headObjectSize(key);
    expect(size).toBe(body.length);
  }, 30000);

  it('serves a presigned GET that honors HTTP Range with 206 Partial Content', async () => {
    const key = `videos/${randomUUID()}/range`;
    createdKeys.push(key);
    const content = Buffer.from('0123456789abcdef');
    await service.putObject(key, content, 'application/octet-stream');

    const url = await service.presignGet(key);
    const res = await fetch(url, { headers: { Range: 'bytes=0-3' } });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe('0123');
  }, 30000);

  it('presigns a download URL with attachment content-disposition', async () => {
    const key = `videos/${randomUUID()}/download`;
    createdKeys.push(key);
    await service.putObject(
      key,
      Buffer.from('payload'),
      'application/octet-stream',
    );

    const url = await service.presignGet(key, { downloadFilename: 'clip.mp4' });
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('clip.mp4');
  }, 30000);

  it('aborts a multipart upload so it can be discarded', async () => {
    const key = `videos/${randomUUID()}/aborted`;
    const uploadId = await service.createMultipartUpload(key, 'video/mp4');
    // Abort must resolve without error; the incomplete upload is discarded.
    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  }, 30000);

  it('bootstraps the bucket resiliently and idempotently', async () => {
    // Re-running onModuleInit is safe: the bucket already exists and the
    // best-effort lifecycle call swallows backend limitations without throwing
    // (this MinIO build does not support the AbortIncompleteMultipartUpload
    // lifecycle action — the explicit abort endpoint is the primary mechanism).
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  }, 30000);
});
