import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { OwnedChannelGuard } from '../channels/guards/owned-channel.guard';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@UseGuards(OwnedChannelGuard)
@Controller('channels/:channelId/videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Creates a draft video and starts an S3/MinIO multipart upload, returning the upload id used to request part URLs.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        uploadId: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @Param('channelId') channelId: string,
    @Body() dto: InitiateUploadDto,
  ): Promise<{ videoId: string; slug: string; uploadId: string }> {
    return this.videosService.initiateUpload(channelId, dto);
  }

  @Get('uploads/:uploadId/parts/:partNumber')
  @ApiOperation({
    summary: 'Get a presigned upload part URL',
    description:
      'Returns a presigned URL for uploading a specific multipart upload part directly to storage.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresInSeconds: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not in progress for this video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadPartUrl(
    @Param('channelId') channelId: string,
    @Param('uploadId') uploadId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.videosService.getUploadPartUrl(
      channelId,
      uploadId,
      partNumber,
    );
  }

  @Post(':videoId/uploads/complete')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload, validates the uploaded size, transitions the video to processing, and enqueues the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video is now processing',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Uploaded file size does not match the declared size',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('channelId') channelId: string,
    @Param('videoId') videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ videoId: string; status: VideoStatus }> {
    return this.videosService.completeUpload(channelId, videoId, dto);
  }

  @Get(':videoId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get video status',
    description:
      'Returns the current state of the video, safe to poll while processing runs in the background.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    type: VideoResponseDto,
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findById(
    @Param('channelId') channelId: string,
    @Param('videoId') videoId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.videosService.findById(channelId, videoId);
    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      description: video.description,
      status: video.status,
      durationSeconds: video.duration_seconds,
      errorReason: video.error_reason,
      createdAt: video.created_at,
    };
  }

  @Get(':videoId/stream')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get a streaming URL',
    description:
      'Returns a presigned URL that supports HTTP Range requests for playback without downloading the full file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned streaming URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresInSeconds: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStreamUrl(
    @Param('channelId') channelId: string,
    @Param('videoId') videoId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.videosService.getStreamUrl(channelId, videoId);
  }

  @Get(':videoId/download')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Get a download URL',
    description:
      'Returns a short-lived presigned URL for downloading the full video file.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned download URL',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresInSeconds: { type: 'number' },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Channel does not belong to this user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDownloadUrl(
    @Param('channelId') channelId: string,
    @Param('videoId') videoId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    return this.videosService.getDownloadUrl(channelId, videoId);
  }
}
