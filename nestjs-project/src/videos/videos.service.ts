import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import type { JwtPayload } from '../auth/auth.types';
import { ChannelsService } from '../channels/channels.service';
import { STORAGE } from '../storage/storage.constants';
import { StorageService } from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidContentTypeException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotUploadableException,
  VideoUploadTooLargeException,
} from './exceptions/video.exceptions';
import { PublicIdService } from './public-id.service';
import {
  ALLOWED_CONTENT_TYPES,
  VIDEO_JOB,
  VIDEO_QUEUE,
} from './videos.constants';
import { VideosRepository } from './videos.repository';

export interface UploadPartUrl {
  partNumber: number;
  url: string;
}

export interface InitiateUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
  uploadId: string;
  partSize: number;
  parts: UploadPartUrl[];
}

export interface CompleteUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
}

export interface PublicVideoView {
  publicId: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  metadata: Record<string, unknown> | null;
}

export type DeliveryKind = 'stream' | 'download';

// Attachment filename extension per accepted content type.
const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
};

@Injectable()
export class VideosService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly publicIdService: PublicIdService,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @InjectQueue(VIDEO_QUEUE)
    private readonly videoQueue: Queue,
  ) {}

  async initiateUpload(
    user: JwtPayload,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    if (dto.sizeBytes > STORAGE.MAX_UPLOAD_SIZE_BYTES) {
      throw new VideoUploadTooLargeException();
    }

    if (
      !(ALLOWED_CONTENT_TYPES as readonly string[]).includes(dto.contentType)
    ) {
      throw new InvalidContentTypeException();
    }

    const id = randomUUID();
    const storageKey = this.storageService.videoOriginalKey(id);
    const publicId = await this.publicIdService.generateUnique((candidate) =>
      this.videosRepository.existsByPublicId(candidate),
    );
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    const video = this.videosRepository.create({
      id,
      channel_id: channel.id,
      title: dto.title,
      content_type: dto.contentType,
      size_bytes: dto.sizeBytes,
      public_id: publicId,
      storage_key: storageKey,
      upload_id: uploadId,
      status: VideoStatus.DRAFT,
    });
    await this.videosRepository.save(video);

    const partCount = Math.ceil(
      dto.sizeBytes / STORAGE.MULTIPART_PART_SIZE_BYTES,
    );
    const parts: UploadPartUrl[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        partNumber,
        url: await this.storageService.presignUploadPart(
          storageKey,
          uploadId,
          partNumber,
        ),
      });
    }

    return {
      id,
      publicId,
      status: video.status,
      uploadId,
      partSize: STORAGE.MULTIPART_PART_SIZE_BYTES,
      parts,
    };
  }

  async completeUpload(
    user: JwtPayload,
    id: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.getUploadableOwned(user, id);

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id as string,
      dto.parts,
    );

    const realSize = await this.storageService.headObjectSize(
      video.storage_key,
    );
    if (realSize > STORAGE.MAX_UPLOAD_SIZE_BYTES) {
      throw new VideoUploadTooLargeException();
    }

    video.size_bytes = realSize;
    video.upload_id = null;
    video.status = VideoStatus.PROCESSING;
    await this.videosRepository.save(video);

    await this.videoQueue.add(VIDEO_JOB.PROCESS, { videoId: video.id });

    return { id: video.id, publicId: video.public_id, status: video.status };
  }

  async abortUpload(user: JwtPayload, id: string): Promise<void> {
    const video = await this.getUploadableOwned(user, id);
    await this.storageService.abortMultipartUpload(
      video.storage_key,
      video.upload_id as string,
    );
  }

  /**
   * Loads a video by internal id, enforcing owner access (any other id → 404
   * VIDEO_NOT_FOUND) and the `draft`/`uploading` precondition (409
   * VIDEO_NOT_UPLOADABLE) shared by complete and abort.
   */
  private async getUploadableOwned(
    user: JwtPayload,
    id: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(user.sub);
    const video = await this.videosRepository.findById(id);
    if (!video || !channel || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }
    if (
      video.status !== VideoStatus.DRAFT &&
      video.status !== VideoStatus.UPLOADING
    ) {
      throw new VideoNotUploadableException();
    }
    return video;
  }

  /**
   * Public metadata by URL identifier. `ready` videos are visible to anyone;
   * non-ready videos only to the authenticated owner, otherwise 404
   * VIDEO_NOT_FOUND (per phase-03-videos/TD-06 AMB-1).
   */
  async getPublicView(
    publicId: string,
    user?: JwtPayload,
  ): Promise<PublicVideoView> {
    const video = await this.videosRepository.findByPublicId(publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (
      video.status !== VideoStatus.READY &&
      !(await this.isOwner(video, user))
    ) {
      throw new VideoNotFoundException();
    }

    const thumbnailUrl =
      video.status === VideoStatus.READY && video.thumbnail_key
        ? await this.storageService.presignGet(video.thumbnail_key)
        : null;

    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      thumbnailUrl,
      metadata: video.metadata,
    };
  }

  /**
   * Resolves a presigned delivery URL for stream/download. `ready` videos are
   * delivered to anyone; the owner asking for a non-ready video gets 409
   * VIDEO_NOT_READY; everyone else gets 404 VIDEO_NOT_FOUND (per TD-06).
   */
  async resolveDeliveryUrl(
    publicId: string,
    kind: DeliveryKind,
    user?: JwtPayload,
  ): Promise<string> {
    const video = await this.videosRepository.findByPublicId(publicId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      if (await this.isOwner(video, user)) {
        throw new VideoNotReadyException();
      }
      throw new VideoNotFoundException();
    }

    if (kind === 'download') {
      const ext = CONTENT_TYPE_EXTENSION[video.content_type] ?? 'mp4';
      return this.storageService.presignGet(video.storage_key, {
        downloadFilename: `${video.title}.${ext}`,
      });
    }
    return this.storageService.presignGet(video.storage_key);
  }

  /**
   * Deletes a video owned by the caller: aborts any in-progress multipart,
   * removes the storage objects (original + thumbnail, best-effort) and the DB
   * row. A non-owner or unknown id → 404 VIDEO_NOT_FOUND (per TD-08,
   * `### Authorization Matrix`).
   */
  async deleteVideo(user: JwtPayload, id: string): Promise<void> {
    const channel = await this.channelsService.findByUserId(user.sub);
    const video = await this.videosRepository.findById(id);
    if (!video || !channel || video.channel_id !== channel.id) {
      throw new VideoNotFoundException();
    }

    if (video.upload_id) {
      await this.storageService.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }
    await this.storageService.deleteObject(video.storage_key);
    if (video.thumbnail_key) {
      await this.storageService.deleteObject(video.thumbnail_key);
    }

    await this.videosRepository.delete(video.id);
  }

  /** True when `user` is the authenticated owner of the video's channel. */
  private async isOwner(video: Video, user?: JwtPayload): Promise<boolean> {
    if (!user) {
      return false;
    }
    const channel = await this.channelsService.findByUserId(user.sub);
    return !!channel && channel.id === video.channel_id;
  }
}
