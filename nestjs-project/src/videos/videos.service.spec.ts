import type { JwtPayload } from '../auth/auth.types';
import { STORAGE } from '../storage/storage.constants';
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
import { VIDEO_JOB } from './videos.constants';
import { VideosService } from './videos.service';

describe('VideosService.initiateUpload', () => {
  const user: JwtPayload = { sub: 'user-1', email: 'owner@example.com' };

  let videosRepository: {
    existsByPublicId: jest.Mock;
    create: jest.Mock;
    save: jest.Mock<Promise<Video>, [Video]>;
  };
  let publicIdService: { generateUnique: jest.Mock };
  let storageService: {
    videoOriginalKey: jest.Mock;
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let videoQueue: { add: jest.Mock };
  let service: VideosService;

  beforeEach(() => {
    videosRepository = {
      existsByPublicId: jest.fn().mockResolvedValue(false),
      create: jest.fn((data: Partial<Video>) => data),
      save: jest.fn((v) => Promise.resolve(v)),
    };
    publicIdService = {
      generateUnique: jest.fn().mockResolvedValue('publicId123'),
    };
    storageService = {
      videoOriginalKey: jest.fn((id: string) => `videos/${id}/original`),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id-1'),
      presignUploadPart: jest
        .fn()
        .mockImplementation((_key, _uploadId, partNumber: number) =>
          Promise.resolve(`https://signed/part-${partNumber}`),
        ),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    videoQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new VideosService(
      videosRepository as never,
      publicIdService as never,
      storageService as never,
      channelsService as never,
      videoQueue as never,
    );
  });

  function dto(overrides: Partial<InitiateUploadDto> = {}): InitiateUploadDto {
    return {
      title: 'My Video',
      contentType: 'video/mp4',
      sizeBytes: 250 * 1024 * 1024, // 250 MiB → 3 parts
      ...overrides,
    };
  }

  it('creates a draft and returns presigned parts on the happy path', async () => {
    const result = await service.initiateUpload(user, dto());

    expect(result.publicId).toBe('publicId123');
    expect(result.status).toBe(VideoStatus.DRAFT);
    expect(result.uploadId).toBe('upload-id-1');
    expect(result.partSize).toBe(STORAGE.MULTIPART_PART_SIZE_BYTES);
    expect(result.parts).toHaveLength(3);
    expect(result.parts[0]).toEqual({
      partNumber: 1,
      url: 'https://signed/part-1',
    });

    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${result.id}/original`,
      'video/mp4',
    );
    const saved = videosRepository.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      channel_id: 'channel-1',
      title: 'My Video',
      status: VideoStatus.DRAFT,
      upload_id: 'upload-id-1',
      public_id: 'publicId123',
    });
  });

  it('throws VIDEO_UPLOAD_TOO_LARGE when sizeBytes exceeds 10 GiB', async () => {
    await expect(
      service.initiateUpload(
        user,
        dto({ sizeBytes: STORAGE.MAX_UPLOAD_SIZE_BYTES + 1 }),
      ),
    ).rejects.toBeInstanceOf(VideoUploadTooLargeException);

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    expect(videosRepository.save).not.toHaveBeenCalled();
  });

  it('throws INVALID_CONTENT_TYPE when contentType is not accepted', async () => {
    await expect(
      service.initiateUpload(user, dto({ contentType: 'image/png' })),
    ).rejects.toBeInstanceOf(InvalidContentTypeException);

    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    expect(videosRepository.save).not.toHaveBeenCalled();
  });

  it('throws CHANNEL_NOT_FOUND when the user has no channel', async () => {
    channelsService.findByUserId.mockResolvedValue(null);

    await expect(service.initiateUpload(user, dto())).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });
});

describe('VideosService complete/abort upload', () => {
  const user: JwtPayload = { sub: 'user-1', email: 'owner@example.com' };
  const parts: CompleteUploadDto = {
    parts: [{ partNumber: 1, etag: 'etag-1' }],
  };

  let videosRepository: {
    findById: jest.Mock;
    save: jest.Mock<Promise<Video>, [Video]>;
  };
  let storageService: {
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    headObjectSize: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let videoQueue: { add: jest.Mock };
  let service: VideosService;

  function draft(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.DRAFT,
      public_id: 'publicId123',
      storage_key: 'videos/video-1/original',
      upload_id: 'upload-id-1',
      size_bytes: null,
      ...overrides,
    } as Video;
  }

  beforeEach(() => {
    videosRepository = {
      findById: jest.fn().mockResolvedValue(draft()),
      save: jest.fn((v) => Promise.resolve(v)),
    };
    storageService = {
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObjectSize: jest.fn().mockResolvedValue(1_000_000),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };
    videoQueue = { add: jest.fn().mockResolvedValue(undefined) };

    service = new VideosService(
      videosRepository as never,
      undefined as never,
      storageService as never,
      channelsService as never,
      videoQueue as never,
    );
  });

  it('completes: sets processing, persists real size and enqueues the job', async () => {
    const result = await service.completeUpload(user, 'video-1', parts);

    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-id-1',
      parts.parts,
    );
    const saved = videosRepository.save.mock.calls[0][0];
    expect(saved.status).toBe(VideoStatus.PROCESSING);
    expect(saved.size_bytes).toBe(1_000_000);
    expect(saved.upload_id).toBeNull();
    expect(videoQueue.add).toHaveBeenCalledWith(VIDEO_JOB.PROCESS, {
      videoId: 'video-1',
    });
    expect(result.status).toBe(VideoStatus.PROCESSING);
  });

  it('completes: throws VIDEO_UPLOAD_TOO_LARGE when the real object exceeds 10 GiB', async () => {
    storageService.headObjectSize.mockResolvedValue(
      STORAGE.MAX_UPLOAD_SIZE_BYTES + 1,
    );

    await expect(
      service.completeUpload(user, 'video-1', parts),
    ).rejects.toBeInstanceOf(VideoUploadTooLargeException);

    expect(videosRepository.save).not.toHaveBeenCalled();
    expect(videoQueue.add).not.toHaveBeenCalled();
  });

  it('completes: throws VIDEO_NOT_UPLOADABLE when not in draft/uploading', async () => {
    videosRepository.findById.mockResolvedValue(
      draft({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      service.completeUpload(user, 'video-1', parts),
    ).rejects.toBeInstanceOf(VideoNotUploadableException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    expect(videoQueue.add).not.toHaveBeenCalled();
  });

  it('completes: throws VIDEO_NOT_FOUND for a video owned by another channel', async () => {
    videosRepository.findById.mockResolvedValue(
      draft({ channel_id: 'other-channel' }),
    );

    await expect(
      service.completeUpload(user, 'video-1', parts),
    ).rejects.toBeInstanceOf(VideoNotFoundException);

    expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('aborts: calls abortMultipartUpload and keeps the draft', async () => {
    await service.abortUpload(user, 'video-1');

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-id-1',
    );
    expect(videosRepository.save).not.toHaveBeenCalled();
  });

  it('aborts: throws VIDEO_NOT_UPLOADABLE when not in draft/uploading', async () => {
    videosRepository.findById.mockResolvedValue(
      draft({ status: VideoStatus.READY }),
    );

    await expect(service.abortUpload(user, 'video-1')).rejects.toBeInstanceOf(
      VideoNotUploadableException,
    );
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });
});

describe('VideosService.deleteVideo', () => {
  const user: JwtPayload = { sub: 'user-1', email: 'owner@example.com' };

  let videosRepository: { findById: jest.Mock; delete: jest.Mock };
  let storageService: {
    abortMultipartUpload: jest.Mock;
    deleteObject: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let service: VideosService;

  function video(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.READY,
      storage_key: 'videos/video-1/original',
      thumbnail_key: 'videos/video-1/thumbnail.jpg',
      upload_id: null,
      ...overrides,
    } as Video;
  }

  beforeEach(() => {
    videosRepository = {
      findById: jest.fn().mockResolvedValue(video()),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    storageService = {
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    channelsService = {
      findByUserId: jest.fn().mockResolvedValue({ id: 'channel-1' }),
    };

    service = new VideosService(
      videosRepository as never,
      undefined as never,
      storageService as never,
      channelsService as never,
      undefined as never,
    );
  });

  it('deletes objects (original + thumbnail) and the row for the owner', async () => {
    await service.deleteVideo(user, 'video-1');

    expect(storageService.deleteObject).toHaveBeenCalledWith(
      'videos/video-1/original',
    );
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
    );
    expect(videosRepository.delete).toHaveBeenCalledWith('video-1');
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
  });

  it('aborts an in-progress multipart before deleting', async () => {
    videosRepository.findById.mockResolvedValue(
      video({ status: VideoStatus.UPLOADING, upload_id: 'upload-9' }),
    );

    await service.deleteVideo(user, 'video-1');

    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-9',
    );
    expect(videosRepository.delete).toHaveBeenCalledWith('video-1');
  });

  it('skips the thumbnail delete when there is none', async () => {
    videosRepository.findById.mockResolvedValue(video({ thumbnail_key: null }));

    await service.deleteVideo(user, 'video-1');

    expect(storageService.deleteObject).toHaveBeenCalledTimes(1);
    expect(storageService.deleteObject).toHaveBeenCalledWith(
      'videos/video-1/original',
    );
  });

  it('throws VIDEO_NOT_FOUND for a video owned by another channel', async () => {
    videosRepository.findById.mockResolvedValue(
      video({ channel_id: 'other-channel' }),
    );

    await expect(service.deleteVideo(user, 'video-1')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    expect(storageService.deleteObject).not.toHaveBeenCalled();
    expect(videosRepository.delete).not.toHaveBeenCalled();
  });

  it('throws VIDEO_NOT_FOUND for an unknown id', async () => {
    videosRepository.findById.mockResolvedValue(null);

    await expect(service.deleteVideo(user, 'missing')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
    expect(videosRepository.delete).not.toHaveBeenCalled();
  });
});

describe('VideosService delivery (getPublicView / resolveDeliveryUrl)', () => {
  const owner: JwtPayload = { sub: 'user-1', email: 'owner@example.com' };
  const stranger: JwtPayload = { sub: 'user-2', email: 'other@example.com' };

  let videosRepository: { findByPublicId: jest.Mock };
  let storageService: { presignGet: jest.Mock };
  let channelsService: { findByUserId: jest.Mock };
  let service: VideosService;

  function video(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      channel_id: 'channel-1',
      title: 'Clip',
      status: VideoStatus.READY,
      public_id: 'publicId123',
      storage_key: 'videos/video-1/original',
      thumbnail_key: 'videos/video-1/thumbnail.jpg',
      content_type: 'video/mp4',
      duration_seconds: 42,
      metadata: { width: 1920, height: 1080 },
      ...overrides,
    } as Video;
  }

  beforeEach(() => {
    videosRepository = {
      findByPublicId: jest.fn().mockResolvedValue(video()),
    };
    storageService = {
      presignGet: jest.fn().mockResolvedValue('https://signed/get'),
    };
    // Owner's channel is 'channel-1'.
    channelsService = {
      findByUserId: jest.fn((sub: string) =>
        Promise.resolve(
          sub === 'user-1' ? { id: 'channel-1' } : { id: 'channel-2' },
        ),
      ),
    };

    service = new VideosService(
      videosRepository as never,
      undefined as never,
      storageService as never,
      channelsService as never,
      undefined as never,
    );
  });

  it('getPublicView: returns metadata with a thumbnail URL for a ready video (anonymous)', async () => {
    const view = await service.getPublicView('publicId123');

    expect(view).toMatchObject({
      publicId: 'publicId123',
      title: 'Clip',
      status: VideoStatus.READY,
      durationSeconds: 42,
      thumbnailUrl: 'https://signed/get',
      metadata: { width: 1920, height: 1080 },
    });
    expect(storageService.presignGet).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
    );
  });

  it('getPublicView: 404 for a non-ready video requested by a non-owner', async () => {
    videosRepository.findByPublicId.mockResolvedValue(
      video({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      service.getPublicView('publicId123', stranger),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it('getPublicView: owner sees their own non-ready video (no thumbnail yet)', async () => {
    videosRepository.findByPublicId.mockResolvedValue(
      video({ status: VideoStatus.PROCESSING, thumbnail_key: null }),
    );

    const view = await service.getPublicView('publicId123', owner);

    expect(view.status).toBe(VideoStatus.PROCESSING);
    expect(view.thumbnailUrl).toBeNull();
  });

  it('getPublicView: 404 when the publicId does not exist', async () => {
    videosRepository.findByPublicId.mockResolvedValue(null);

    await expect(service.getPublicView('missing')).rejects.toBeInstanceOf(
      VideoNotFoundException,
    );
  });

  it('resolveDeliveryUrl: presigns a plain GET for a ready stream (anonymous)', async () => {
    const url = await service.resolveDeliveryUrl('publicId123', 'stream');

    expect(url).toBe('https://signed/get');
    expect(storageService.presignGet).toHaveBeenCalledWith(
      'videos/video-1/original',
    );
  });

  it('resolveDeliveryUrl: presigns an attachment download with a filename', async () => {
    await service.resolveDeliveryUrl('publicId123', 'download');

    expect(storageService.presignGet).toHaveBeenCalledWith(
      'videos/video-1/original',
      { downloadFilename: 'Clip.mp4' },
    );
  });

  it('resolveDeliveryUrl: owner requesting a non-ready video gets VIDEO_NOT_READY (409)', async () => {
    videosRepository.findByPublicId.mockResolvedValue(
      video({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      service.resolveDeliveryUrl('publicId123', 'stream', owner),
    ).rejects.toBeInstanceOf(VideoNotReadyException);
    expect(storageService.presignGet).not.toHaveBeenCalled();
  });

  it('resolveDeliveryUrl: non-owner requesting a non-ready video gets 404', async () => {
    videosRepository.findByPublicId.mockResolvedValue(
      video({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      service.resolveDeliveryUrl('publicId123', 'download', stranger),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
