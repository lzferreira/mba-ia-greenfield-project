import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import type { Job } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessor } from './video.processor';
import { VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

/**
 * Exercises the real worker pipeline: real MinIO (storage), real ffmpeg/ffprobe
 * (spawned) and the real DB (per phase-03-videos/TD-03, TD-04). Requires the
 * `minio` and `db` containers up and ffmpeg present in the image.
 */
describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let processor: VideoProcessor;
  let fixtureDir: string;
  let validVideo: Buffer;
  const createdKeys: string[] = [];
  let counter = 0;

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
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    storage = new StorageService(storageConfig());
    await storage.onModuleInit();
    processor = new VideoProcessor(
      new VideosRepository(videoRepository),
      storage,
    );

    // Generate a tiny real MP4 fixture with ffmpeg (2s, 160x120).
    fixtureDir = await mkdtemp(join(tmpdir(), 'video-fixture-'));
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
    await rm(fixtureDir, { recursive: true, force: true });
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  async function createVideoRow(originalBody: Buffer): Promise<Video> {
    counter++;
    const user = await userRepository.save(
      userRepository.create({
        email: `proc_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `procchan_${counter}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Processing Video',
        public_id:
          `proc${counter}${Math.random().toString(36).slice(2, 8)}`.slice(
            0,
            11,
          ),
        storage_key: storage.videoOriginalKey(`vid-${counter}-${Date.now()}`),
        content_type: 'video/mp4',
        status: VideoStatus.PROCESSING,
      }),
    );
    createdKeys.push(video.storage_key, storage.videoThumbnailKey(video.id));
    await storage.putObject(video.storage_key, originalBody, 'video/mp4');
    return video;
  }

  function jobFor(videoId: string, attemptsMade = 0): Job<{ videoId: string }> {
    return {
      data: { videoId },
      attemptsMade,
      opts: { attempts: 3 },
    } as unknown as Job<{ videoId: string }>;
  }

  it('takes a valid video to ready with duration, metadata and a thumbnail', async () => {
    const video = await createVideoRow(validVideo);

    await processor.process(jobFor(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeGreaterThan(0);
    expect(updated.thumbnail_key).toBe(storage.videoThumbnailKey(video.id));
    expect(updated.metadata).toMatchObject({ width: 160, height: 120 });
    expect(updated.failure_reason).toBeNull();

    const thumbSize = await storage.headObjectSize(updated.thumbnail_key!);
    expect(thumbSize).toBeGreaterThan(0);
  }, 60000);

  it('is idempotent — reprocessing a ready video keeps it ready', async () => {
    const video = await createVideoRow(validVideo);

    await processor.process(jobFor(video.id));
    await processor.process(jobFor(video.id));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.duration_seconds).toBeGreaterThan(0);
  }, 60000);

  it('marks the video failed with a reason once retries are exhausted on unreadable input', async () => {
    const video = await createVideoRow(Buffer.from('this is not a video'));

    // ffprobe cannot read the garbage object → process throws (job would retry).
    await expect(processor.process(jobFor(video.id))).rejects.toThrow();

    // Simulate the queue exhausting its attempts and emitting `failed`.
    await processor.onFailed(
      jobFor(video.id, 3),
      new Error('ffprobe exited with code 1'),
    );

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.FAILED);
    expect(updated.failure_reason).toContain('ffprobe');
  }, 60000);

  it('does not mark failed while attempts remain', async () => {
    const video = await createVideoRow(validVideo);

    await processor.onFailed(jobFor(video.id, 1), new Error('transient'));

    const updated = await videoRepository.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.PROCESSING);
    expect(updated.failure_reason).toBeNull();
  }, 60000);
});
