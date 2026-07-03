import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class InitiateUploadDto {
  /** Video title. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  /**
   * Declared MIME type. The accepted-set check runs in the service so the
   * rejection surfaces as INVALID_CONTENT_TYPE rather than a generic 400.
   */
  @IsString()
  @IsNotEmpty()
  contentType: string;

  /**
   * Declared file size in bytes. The 10 GiB cap is enforced in the service so
   * an oversize upload surfaces as 413 VIDEO_UPLOAD_TOO_LARGE.
   */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
