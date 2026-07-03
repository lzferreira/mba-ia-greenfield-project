import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Channel } from './channels/entities/channel.entity';
import { StorageService } from './storage/storage.service';
import { cleanAllTables } from './test/create-test-data-source';
import { User } from './users/entities/user.entity';
import { Video, VideoStatus } from './videos/entities/video.entity';
import { VIDEO_JOB, VIDEO_QUEUE } from './videos/videos.constants';
import { WorkerModule } from './worker.module';

/**
 * Regression guard for the queue→worker wiring (per phase-03-videos/TD-03).
 *
 * The `VideoProcessor` integration spec calls `processor.process()` directly, so
 * it never exercises BullMQ's consumption path. That left a gap: `WorkerModule`
 * registered the Bull *connection* (`forRootAsync`) but not the *queue*
 * (`registerQueue`), so `@Processor(VIDEO_QUEUE)` spawned no Worker and enqueued
 * jobs sat forever in the queue's `wait` list. This test boots the real
 * `WorkerModule`, enqueues a real job through the queue, and asserts the worker
 * actually consumes it and drives the video to `ready` — it fails if the queue
 * registration is ever dropped again.
 */
describe('WorkerModule (integration) — queue consumption', () => {
  let app: INestApplicationContext;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue<{ videoId: string }>;
  let fixtureDir: string;
  let validVideo: Buffer;
  const createdKeys: string[] = [];

  function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args);
      let stderr = '';
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${command} failed (${code}): ${stderr}`)),
      );
    });
  }

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    queue = app.get<Queue<{ videoId: string }>>(getQueueToken(VIDEO_QUEUE));

    fixtureDir = await mkdtemp(join(tmpdir(), 'worker-mod-fixture-'));
    const fixturePath = join(fixtureDir, 'sample.mp4');
    await run('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=160x120:rate=15',
      '-pix_fmt',
      'yuv420p',
      '-y',
      fixturePath,
    ]);
    validVideo = await readFile(fixturePath);
  }, 60000);

  afterAll(async () => {
    for (const key of createdKeys) {
      await storage.deleteObject(key);
    }
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    await rm(fixtureDir, { recursive: true, force: true });
    await app.close();
  });

  it('consumes a job from the queue and drives the video to ready', async () => {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `worker_mod_${Date.now()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Worker Module Channel',
        nickname: `workermod_${Date.now()}`,
        user_id: user.id,
      }),
    );
    const videoRepo = dataSource.getRepository(Video);
    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        title: 'Queue consumption video',
        public_id: `wm${Date.now().toString(36)}`.slice(0, 11),
        storage_key: storage.videoOriginalKey(`wm-${Date.now()}`),
        content_type: 'video/mp4',
        status: VideoStatus.PROCESSING,
      }),
    );
    createdKeys.push(video.storage_key, storage.videoThumbnailKey(video.id));
    await storage.putObject(video.storage_key, validVideo, 'video/mp4');

    // Enqueue through the real queue — a Worker must exist to pick this up.
    await queue.add(
      VIDEO_JOB.PROCESS,
      { videoId: video.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: true },
    );

    // Poll the DB until the worker finishes (proves the job was consumed).
    const deadline = Date.now() + 30000;
    let status = VideoStatus.PROCESSING;
    while (Date.now() < deadline) {
      const row = await videoRepo.findOneByOrFail({ id: video.id });
      status = row.status;
      if (status === VideoStatus.READY || status === VideoStatus.FAILED) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const updated = await videoRepo.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeGreaterThan(0);
    expect(updated.thumbnail_key).toBe(storage.videoThumbnailKey(video.id));
  }, 45000);
});
