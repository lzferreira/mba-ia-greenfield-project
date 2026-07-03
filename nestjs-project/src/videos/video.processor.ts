import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService } from '../storage/storage.service';
import { VideoStatus } from './entities/video.entity';
import { captureThumbnail, ffprobe } from './ffmpeg.util';
import { VIDEO_QUEUE } from './videos.constants';
import { VideosRepository } from './videos.repository';

interface ProcessVideoJob {
  videoId: string;
}

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/**
 * Queue consumer running in the dedicated worker container (per
 * phase-03-videos/TD-03). Downloads the original, extracts duration/metadata
 * (ffprobe), captures a thumbnail (ffmpeg), persists them and transitions the
 * video to `ready`. On retry exhaustion the `failed` event marks it `failed`
 * with a reason (per phase-03-videos/TD-07). Reprocessing is idempotent — it
 * re-derives everything and overwrites.
 */
@Processor(VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videos: VideosRepository,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJob>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videos.findById(videoId);
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }

    const workDir = await mkdtemp(join(tmpdir(), 'video-'));
    const srcPath = join(workDir, 'original');
    const thumbPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.storage.downloadToFile(video.storage_key, srcPath);

      const probe = await ffprobe(srcPath);
      const atSeconds = probe.durationSeconds > 1 ? 1 : 0;
      await captureThumbnail(srcPath, thumbPath, atSeconds);

      const thumbnailKey = this.storage.videoThumbnailKey(video.id);
      const thumbnail = await readFile(thumbPath);
      await this.storage.putObject(
        thumbnailKey,
        thumbnail,
        THUMBNAIL_CONTENT_TYPE,
      );

      video.duration_seconds = probe.durationSeconds;
      video.metadata = { ...probe.metadata };
      video.thumbnail_key = thumbnailKey;
      video.failure_reason = null;
      video.status = VideoStatus.READY;
      await this.videos.save(video);

      this.logger.log(`Video ${videoId} processed → ready`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJob>, err: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    // Only terminal once the queue has exhausted its retries (TD-07).
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {
      const video = await this.videos.findById(job.data.videoId);
      if (!video) {
        return;
      }
      video.status = VideoStatus.FAILED;
      video.failure_reason = err.message || 'video processing failed';
      await this.videos.save(video);
      this.logger.warn(
        `Video ${job.data.videoId} failed after ${job.attemptsMade} attempts: ${err.message}`,
      );
    } catch (persistErr) {
      // Background handler: log, never rethrow (would crash the worker).
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(persistErr)}`,
      );
    }
  }
}
