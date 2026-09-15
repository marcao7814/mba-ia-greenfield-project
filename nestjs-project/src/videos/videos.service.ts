import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  UploadAlreadyCompletedException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosRepository } from './repositories/videos.repository';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  STREAM_URL_TTL_SECONDS,
  VIDEO_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_JOB_NAME,
} from './videos.constants';

export interface VideoProcessingJobData {
  videoId: string;
  storageKey: string;
}

@Injectable()
export class VideosService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue<VideoProcessingJobData>,
  ) {}

  async initiateUpload(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<{ videoId: string; slug: string; uploadId: string }> {
    const video = await this.videosRepository.createDraftWithUniqueSlug({
      channel_id: channelId,
      title: dto.title,
      description: dto.description ?? null,
      declared_size_bytes: dto.fileSizeBytes,
    });

    const storageKey = `${video.id}/source`;
    const { uploadId } = await this.storageService.createMultipartUpload(
      this.storageService.sourceBucket,
      storageKey,
    );
    await this.videosRepository.attachUpload(video.id, storageKey, uploadId);

    return { videoId: video.id, slug: video.slug, uploadId };
  }

  async getUploadPartUrl(
    channelId: string,
    uploadId: string,
    partNumber: number,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const video = await this.videosRepository.findByUploadIdScopedToChannel(
      uploadId,
      channelId,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.DRAFT || video.upload_id !== uploadId) {
      throw new UploadNotInProgressException();
    }

    return this.storageService.presignUploadPart(
      this.storageService.sourceBucket,
      video.storage_key!,
      uploadId,
      partNumber,
    );
  }

  async completeUpload(
    channelId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<{ videoId: string; status: VideoStatus }> {
    const video = await this.videosRepository.findByIdScopedToChannel(
      videoId,
      channelId,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }

    const transitioned =
      await this.videosRepository.markProcessingIfDraft(videoId);
    if (!transitioned) {
      throw new UploadAlreadyCompletedException();
    }

    await this.storageService.completeMultipartUpload(
      this.storageService.sourceBucket,
      video.storage_key!,
      dto.uploadId,
      dto.parts,
    );

    const { sizeBytes } = await this.storageService.headObject(
      this.storageService.sourceBucket,
      video.storage_key!,
    );
    if (sizeBytes !== video.declared_size_bytes) {
      await this.videosRepository.revertToDraft(videoId);
      throw new UploadSizeMismatchException();
    }

    await this.videoProcessingQueue.add(
      VIDEO_PROCESSING_JOB_NAME,
      { videoId: video.id, storageKey: video.storage_key! },
      {
        jobId: video.id,
        attempts: VIDEO_PROCESSING_ATTEMPTS,
        backoff: {
          type: 'exponential',
          delay: VIDEO_PROCESSING_BACKOFF_DELAY_MS,
        },
      },
    );

    return { videoId: video.id, status: VideoStatus.PROCESSING };
  }

  async findById(channelId: string, videoId: string): Promise<Video> {
    const video = await this.videosRepository.findByIdScopedToChannel(
      videoId,
      channelId,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getStreamUrl(
    channelId: string,
    videoId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const video = await this.assertReady(channelId, videoId);
    const url = await this.storageService.createPresignedGetUrl(
      this.storageService.sourceBucket,
      video.storage_key!,
      STREAM_URL_TTL_SECONDS,
    );
    return { url, expiresInSeconds: STREAM_URL_TTL_SECONDS };
  }

  async getDownloadUrl(
    channelId: string,
    videoId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const video = await this.assertReady(channelId, videoId);
    const url = await this.storageService.createPresignedGetUrl(
      this.storageService.sourceBucket,
      video.storage_key!,
      DOWNLOAD_URL_TTL_SECONDS,
    );
    return { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS };
  }

  private async assertReady(
    channelId: string,
    videoId: string,
  ): Promise<Video> {
    const video = await this.videosRepository.findByIdScopedToChannel(
      videoId,
      channelId,
    );
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }
}
