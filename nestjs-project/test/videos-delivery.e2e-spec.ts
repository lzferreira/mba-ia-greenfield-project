import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { MailService } from '../src/mail/mail.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

function bodyOf<T>(res: { body: unknown }): T {
  return res.body as T;
}

describe('Videos delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
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

  async function seedVideo(
    email: string,
    status: VideoStatus,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });
    const isReady = status === VideoStatus.READY;
    const repo = dataSource.getRepository(Video);
    const video = repo.create({
      channel_id: channel.id,
      title: 'Delivery Clip',
      public_id: `pub${Math.random().toString(36).slice(2, 10)}`.slice(0, 11),
      storage_key: `videos/${randomUUID()}/original`,
      thumbnail_key: isReady ? `videos/${randomUUID()}/thumbnail.jpg` : null,
      content_type: 'video/mp4',
      status,
      duration_seconds: isReady ? 42 : null,
      metadata: isReady ? { width: 1920, height: 1080 } : null,
      ...overrides,
    });
    return repo.save(video);
  }

  it('returns 200 metadata with a thumbnail URL for a ready video (anonymous)', async () => {
    const token = await registerConfirmAndLogin('ready-owner@example.com');
    const video = await seedVideo('ready-owner@example.com', VideoStatus.READY);

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .expect(200);

    const meta = bodyOf<{
      publicId: string;
      status: string;
      durationSeconds: number;
      thumbnailUrl: string;
      metadata: { width: number; height: number };
    }>(res);
    expect(meta.publicId).toBe(video.public_id);
    expect(meta.status).toBe('ready');
    expect(meta.durationSeconds).toBe(42);
    expect(typeof meta.thumbnailUrl).toBe('string');
    expect(meta.metadata).toMatchObject({ width: 1920 });
    expect(token).toBeTruthy();
  });

  it('returns 404 for a non-ready video requested by a third party, 200 for the owner', async () => {
    const ownerToken = await registerConfirmAndLogin('proc-owner@example.com');
    const video = await seedVideo(
      'proc-owner@example.com',
      VideoStatus.PROCESSING,
    );

    const anon = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .expect(404);
    expect(bodyOf<{ error: string }>(anon).error).toBe('VIDEO_NOT_FOUND');

    const asOwner = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(bodyOf<{ status: string }>(asOwner).status).toBe('processing');
  });

  it('redirects 302 to a presigned URL on stream and download of a ready video', async () => {
    await registerConfirmAndLogin('stream-owner@example.com');
    const video = await seedVideo(
      'stream-owner@example.com',
      VideoStatus.READY,
    );

    const stream = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .expect(302);
    expect(stream.headers.location).toContain(video.storage_key);

    const download = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .expect(302);
    expect(download.headers.location).toContain('attachment');
  });

  it('returns 409 VIDEO_NOT_READY when the owner requests stream of a processing video', async () => {
    const ownerToken = await registerConfirmAndLogin('notready@example.com');
    const video = await seedVideo(
      'notready@example.com',
      VideoStatus.PROCESSING,
    );

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(409);
    expect(bodyOf<{ error: string }>(res).error).toBe('VIDEO_NOT_READY');
  });

  it('returns 404 VIDEO_NOT_FOUND for an unknown publicId', async () => {
    await request(app.getHttpServer()).get('/videos/doesnotexist').expect(404);
  });

  it('deletes a video (204) and it disappears from queries', async () => {
    const token = await registerConfirmAndLogin('del-owner@example.com');
    const video = await seedVideo('del-owner@example.com', VideoStatus.READY);

    await request(app.getHttpServer())
      .delete(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .expect(404);
  });

  it('returns 404 VIDEO_NOT_FOUND deleting another owner’s video or an unknown id', async () => {
    await registerConfirmAndLogin('del-owner2@example.com');
    const video = await seedVideo('del-owner2@example.com', VideoStatus.READY);
    const stranger = await registerConfirmAndLogin('del-stranger@example.com');

    const other = await request(app.getHttpServer())
      .delete(`/videos/${video.id}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(404);
    expect(bodyOf<{ error: string }>(other).error).toBe('VIDEO_NOT_FOUND');

    await request(app.getHttpServer())
      .delete(`/videos/${randomUUID()}`)
      .set('Authorization', `Bearer ${stranger}`)
      .expect(404);
  });

  it('returns 401 deleting without an access token', async () => {
    await registerConfirmAndLogin('del-noauth@example.com');
    const video = await seedVideo('del-noauth@example.com', VideoStatus.READY);

    await request(app.getHttpServer())
      .delete(`/videos/${video.id}`)
      .expect(401);
  });
});
