import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import videoProcessingConfig from '../../config/video-processing.config';
import { VIDEO_PROCESSING_QUEUE } from '../../queue/queue.module';
import { StorageService } from '../../storage/storage.service';
import { VideosRepository } from '../repositories/videos.repository';
import type { VideoProcessingJobData } from '../videos.service';
import { VIDEO_ERROR_REASONS } from '../videos.constants';

interface ExtractedMetadata {
  durationSeconds: number;
  metadata: Record<string, unknown>;
}

const THUMBNAIL_FILENAME = 'thumbnail.jpg';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  constructor(
    private readonly storageService: StorageService,
    private readonly videosRepository: VideosRepository,
    @Inject(videoProcessingConfig.KEY)
    private readonly config: ConfigType<typeof videoProcessingConfig>,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId, storageKey } = job.data;
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'video-processing-'),
    );
    const sourcePath = path.join(tmpDir, 'source');

    try {
      await this.storageService.downloadObjectToFile(
        this.storageService.sourceBucket,
        storageKey,
        sourcePath,
      );

      const { durationSeconds, metadata } =
        await this.extractMetadata(sourcePath);
      const thumbnailPath = await this.generateThumbnail(sourcePath, tmpDir);

      const thumbnailKey = `${videoId}/thumbnail.jpg`;
      const thumbnailBuffer = await fs.promises.readFile(thumbnailPath);
      await this.storageService.uploadObject(
        this.storageService.thumbnailsBucket,
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      await this.videosRepository.markReady(videoId, {
        duration_seconds: durationSeconds,
        metadata,
        thumbnail_key: thumbnailKey,
      });
    } catch (error) {
      const errorReason =
        error instanceof UnrecoverableError
          ? VIDEO_ERROR_REASONS.TIMEOUT
          : VIDEO_ERROR_REASONS.PROCESSING_FAILED;
      await this.videosRepository.markError(videoId, errorReason);
      throw error;
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private extractMetadata(localPath: string): Promise<ExtractedMetadata> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new UnrecoverableError('ffprobe timed out'));
      }, this.config.ffmpegTimeoutMs);

      ffmpeg.ffprobe(localPath, (err, data) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }

        const videoStream = data.streams.find(
          (stream) => stream.codec_type === 'video',
        );

        resolve({
          durationSeconds: Math.round(data.format.duration ?? 0),
          metadata: {
            codec: videoStream?.codec_name ?? null,
            width: videoStream?.width ?? null,
            height: videoStream?.height ?? null,
            bitrate: data.format.bit_rate
              ? Number(data.format.bit_rate)
              : null,
          },
        });
      });
    });
  }

  private generateThumbnail(
    localPath: string,
    folder: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const command = ffmpeg(localPath);
      const timer = setTimeout(() => {
        command.kill('SIGKILL');
        reject(new UnrecoverableError('ffmpeg thumbnail generation timed out'));
      }, this.config.ffmpegTimeoutMs);

      command
        .on('end', () => {
          clearTimeout(timer);
          resolve(path.join(folder, THUMBNAIL_FILENAME));
        })
        .on('error', (err: Error) => {
          clearTimeout(timer);
          reject(err);
        })
        .screenshots({
          timestamps: ['10%'],
          filename: THUMBNAIL_FILENAME,
          folder,
        });
    });
  }
}
