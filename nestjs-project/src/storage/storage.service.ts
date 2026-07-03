import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';
import {
  STORAGE,
  videoOriginalKey,
  videoThumbnailKey,
} from './storage.constants';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/**
 * Thin control-plane wrapper over an S3-compatible object store (MinIO in dev).
 * The API never streams video bytes — clients PUT parts directly using the
 * presigned URLs this service issues (per phase-03-videos/TD-02, TD-06, TD-08).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      // aws-sdk-js-v3 ≥ 3.729 injects a CRC32 checksum via aws-chunked encoding
      // by default; MinIO reads the chunked trailer as body and rejects it as
      // malformed XML. Only checksum when the operation strictly requires it.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
    await this.applyLifecycleRule();
  }

  getBucket(): string {
    return this.bucket;
  }

  videoOriginalKey(videoId: string): string {
    return videoOriginalKey(videoId);
  }

  videoThumbnailKey(videoId: string): string {
    return videoThumbnailKey(videoId);
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error(
        'Storage did not return an UploadId for the multipart upload',
      );
    }
    return res.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: STORAGE.PRESIGN_EXPIRES_SECONDS },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /** Confirmed object size — used to enforce the 10GB cap at complete. */
  async headObjectSize(key: string): Promise<number> {
    const res = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return res.ContentLength ?? 0;
  }

  /**
   * Presigned GET. When `downloadFilename` is set, the object is served with an
   * attachment disposition (download); otherwise it streams inline (Range/206).
   */
  async presignGet(
    key: string,
    opts?: { downloadFilename?: string },
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: opts?.downloadFilename
          ? `attachment; filename="${opts.downloadFilename}"`
          : undefined,
      }),
      { expiresIn: STORAGE.PRESIGN_EXPIRES_SECONDS },
    );
  }

  /**
   * Stream an object's bytes to a local file — used by the worker to fetch the
   * original before probing/thumbnailing (per phase-03-videos/TD-03, TD-04).
   */
  async downloadToFile(key: string, destPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) {
      throw new Error(`Storage returned empty body for object ${key}`);
    }
    await pipeline(res.Body as Readable, createWriteStream(destPath));
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Best-effort delete — a missing object is not an error. */
  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      this.logger.warn(`Failed to delete object ${key}: ${String(err)}`);
    }
  }

  private async ensureBucket(): Promise<void> {
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return;
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        const name = (err as { name?: string }).name;
        if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
          await this.client.send(
            new CreateBucketCommand({ Bucket: this.bucket }),
          );
          this.logger.log(`Created bucket "${this.bucket}"`);
          return;
        }
        if (attempt === maxAttempts) {
          throw err;
        }
        // MinIO still warming up — back off and retry.
        await this.delay(1000);
      }
    }
  }

  /**
   * Defense-in-depth cleanup of abandoned uploads (per phase-03-videos/TD-02,
   * AMB-2): expire incomplete multipart uploads after 7 days. Best-effort — some
   * S3-compatible backends (notably certain MinIO builds) do not support the
   * `AbortIncompleteMultipartUpload` lifecycle action and reject/drop the rule.
   * The primary mechanism for abandoned uploads is the explicit abort endpoint
   * (POST /videos/:id/abort), so a rejected rule must not fail app boot.
   */
  private async applyLifecycleRule(): Promise<void> {
    try {
      await this.client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: this.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: 'abort-incomplete-multipart',
                Status: 'Enabled',
                Filter: {},
                AbortIncompleteMultipartUpload: {
                  DaysAfterInitiation: STORAGE.ABORT_INCOMPLETE_MULTIPART_DAYS,
                },
              },
            ],
          },
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Could not apply abort-incomplete-multipart lifecycle rule ` +
          `(backend may not support it): ${String(err)}. ` +
          `Abandoned uploads are still handled by the explicit abort endpoint.`,
      );
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
