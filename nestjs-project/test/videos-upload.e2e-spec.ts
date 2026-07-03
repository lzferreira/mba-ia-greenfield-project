import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_QUEUE } from '../src/videos/videos.constants';

const TEN_GIB = 10 * 1024 * 1024 * 1024;
const PART_SIZE = 100 * 1024 * 1024;

function bodyOf<T>(res: { body: unknown }): T {
  return res.body as T;
}

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoQueue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoQueue = moduleFixture.get<Queue>(getQueueToken(VIDEO_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await videoQueue.obliterate({ force: true });
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const mailService = app.get(MailService);
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        token = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return bodyOf<{ access_token: string }>(res).access_token;
  }

  it('returns 201 with the presigned multipart shape and creates a draft', async () => {
    const accessToken = await registerConfirmAndLogin('owner@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'My First Video',
        contentType: 'video/mp4',
        sizeBytes: 250 * 1024 * 1024, // 250 MiB → 3 parts
      })
      .expect(201);

    const b = bodyOf<{
      id: string;
      publicId: string;
      status: string;
      uploadId: string;
      partSize: number;
      parts: { partNumber: number; url: string }[];
    }>(res);
    expect(b.id).toBeDefined();
    expect(b.publicId).toHaveLength(11);
    expect(b.status).toBe('draft');
    expect(b.uploadId).toBeDefined();
    expect(b.partSize).toBe(PART_SIZE);
    expect(b.parts).toHaveLength(Math.ceil((250 * 1024 * 1024) / PART_SIZE));
    expect(b.parts[0]).toHaveProperty('partNumber', 1);
    expect(b.parts[0]).toHaveProperty('url');

    const stored = await dataSource
      .getRepository(Video)
      .findOneBy({ id: b.id });
    expect(stored?.status).toBe('draft');
  });

  it('returns 413 VIDEO_UPLOAD_TOO_LARGE and creates no row when over 10 GiB', async () => {
    const accessToken = await registerConfirmAndLogin('big@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Huge',
        contentType: 'video/mp4',
        sizeBytes: TEN_GIB + 1,
      })
      .expect(413);

    expect(bodyOf<{ error: string }>(res).error).toBe('VIDEO_UPLOAD_TOO_LARGE');
    expect(await dataSource.getRepository(Video).count()).toBe(0);
  });

  it('returns 400 INVALID_CONTENT_TYPE when contentType is not accepted', async () => {
    const accessToken = await registerConfirmAndLogin('badtype@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Wrong type',
        contentType: 'image/png',
        sizeBytes: 1024,
      })
      .expect(400);

    expect(bodyOf<{ error: string }>(res).error).toBe('INVALID_CONTENT_TYPE');
  });

  it('returns 400 on validation failure (missing title)', async () => {
    const accessToken = await registerConfirmAndLogin('novalid@example.com');

    await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ contentType: 'video/mp4', sizeBytes: 1024 })
      .expect(400);
  });

  it('returns 401 without an access token', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({
        title: 'No auth',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(401);
  });

  async function initiate(
    accessToken: string,
    sizeBytes = 1024,
  ): Promise<{ id: string; uploadId: string; parts: { url: string }[] }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Complete me', contentType: 'video/mp4', sizeBytes })
      .expect(201);
    return bodyOf<{ id: string; uploadId: string; parts: { url: string }[] }>(
      res,
    );
  }

  it('completes an upload: 200 → processing and enqueues the processing job', async () => {
    const accessToken = await registerConfirmAndLogin('complete@example.com');
    const draft = await initiate(accessToken);

    // Upload the single part directly to storage via its presigned URL.
    const body = Buffer.from('small video bytes');
    const put = await fetch(draft.parts[0].url, { method: 'PUT', body });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag') as string;

    const res = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);

    const completed = bodyOf<{ id: string; status: string }>(res);
    expect(completed.id).toBe(draft.id);
    expect(completed.status).toBe('processing');

    const stored = await dataSource
      .getRepository(Video)
      .findOneBy({ id: draft.id });
    expect(stored?.status).toBe('processing');
    expect(stored?.upload_id).toBeNull();
    expect(Number(stored?.size_bytes)).toBe(body.length);

    const jobs = await videoQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ videoId: draft.id });
  });

  it('returns 409 VIDEO_NOT_UPLOADABLE when the video is not draft/uploading', async () => {
    const accessToken = await registerConfirmAndLogin(
      'notuploadable@example.com',
    );
    const draft = await initiate(accessToken);

    await dataSource
      .getRepository(Video)
      .update({ id: draft.id }, { status: VideoStatus.PROCESSING });

    const res = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag: 'etag-1' }] })
      .expect(409);

    expect(bodyOf<{ error: string }>(res).error).toBe('VIDEO_NOT_UPLOADABLE');
  });

  it('returns 404 VIDEO_NOT_FOUND on complete/abort for another owner', async () => {
    const owner = await registerConfirmAndLogin('owner2@example.com');
    const draft = await initiate(owner);
    const stranger = await registerConfirmAndLogin('stranger@example.com');

    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${draft.id}/complete`)
      .set('Authorization', `Bearer ${stranger}`)
      .send({ parts: [{ partNumber: 1, etag: 'etag-1' }] })
      .expect(404);
    expect(bodyOf<{ error: string }>(completeRes).error).toBe(
      'VIDEO_NOT_FOUND',
    );

    await request(app.getHttpServer())
      .post(`/videos/${draft.id}/abort`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(404);
  });

  it('aborts an upload: 204 and the draft remains queryable', async () => {
    const accessToken = await registerConfirmAndLogin('abort@example.com');
    const draft = await initiate(accessToken);

    await request(app.getHttpServer())
      .post(`/videos/${draft.id}/abort`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    const stored = await dataSource
      .getRepository(Video)
      .findOneBy({ id: draft.id });
    expect(stored?.status).toBe('draft');
  });
});
