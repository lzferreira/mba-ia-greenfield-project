import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  VideosService,
  type CompleteUploadResult,
  type InitiateUploadResult,
  type PublicVideoView,
} from './videos.service';

@ApiTags('videos')
@ApiExtraModels(ApiErrorEnvelope)
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and returns presigned multipart upload URLs. The file bytes are PUT directly to storage, never through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        uploadId: { type: 'string' },
        partSize: { type: 'number', example: 104857600 },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error or INVALID_CONTENT_TYPE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'CHANNEL_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_UPLOAD_TOO_LARGE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid', description: 'Internal video id' })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, enforces the 10 GiB cap against the real object size, transitions the video to `processing`, and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing job enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        publicId: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation error (invalid parts list)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_UPLOADABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'VIDEO_UPLOAD_TOO_LARGE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user, id, dto);
  }

  @Post(':id/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid', description: 'Internal video id' })
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Aborts an in-progress multipart upload so storage does not retain uncommitted parts, and leaves the draft for the owner to restart or delete.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted; draft retained' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_UPLOADABLE',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.abortUpload(user, id);
  }

  @Get(':publicId')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiParam({ name: 'publicId', description: 'Public URL identifier' })
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns metadata by public URL id. `ready` videos are public; non-ready videos are visible only to the authenticated owner (404 otherwise).',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        publicId: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        durationSeconds: { type: 'number', nullable: true },
        thumbnailUrl: { type: 'string', nullable: true },
        metadata: { type: 'object', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getMetadata(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<PublicVideoView> {
    return this.videosService.getPublicView(publicId, user);
  }

  @Get(':publicId/stream')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiParam({ name: 'publicId', description: 'Public URL identifier' })
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a presigned GET URL; the client seeks via HTTP Range against storage (206 Partial Content). Public for `ready` videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned stream URL',
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.resolveDeliveryUrl(
      publicId,
      'stream',
      user,
    );
    res.redirect(HttpStatus.FOUND, url);
  }

  @Get(':publicId/download')
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiParam({ name: 'publicId', description: 'Public URL identifier' })
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects (302) to a presigned GET URL carrying an attachment content-disposition. Public for `ready` videos.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.resolveDeliveryUrl(
      publicId,
      'download',
      user,
    );
    res.redirect(HttpStatus.FOUND, url);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiParam({ name: 'id', format: 'uuid', description: 'Internal video id' })
  @ApiOperation({
    summary: 'Delete a video',
    description:
      'Removes a video owned by the caller: aborts any in-progress multipart, deletes the storage objects (original + thumbnail) and the DB row.',
  })
  @ApiResponse({ status: 204, description: 'Video deleted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async deleteVideo(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<void> {
    return this.videosService.deleteVideo(user, id);
  }
}
