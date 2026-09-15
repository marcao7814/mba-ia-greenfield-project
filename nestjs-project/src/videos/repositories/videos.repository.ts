import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { DatabaseError } from 'pg-protocol/dist/messages';
import { QueryFailedError, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { customAlphabet } from 'nanoid';
import { Video, VideoStatus } from '../entities/video.entity';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const SLUG_LENGTH = 12;
const MAX_SLUG_RETRIES = 5;

// Lowercase alphanumeric only — URL-safe with no characters to escape,
// per docs/phases/phase-03-videos/library-refs.md's nanoid guidance.
const generateSlug = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyz',
  SLUG_LENGTH,
);

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as DatabaseError;
  return (
    driverError.code === PG_UNIQUE_VIOLATION &&
    typeof driverError.detail === 'string' &&
    driverError.detail.includes(column)
  );
}

export interface CreateDraftVideoInput {
  channel_id: string;
  title: string;
  description: string | null;
  declared_size_bytes: number;
}

export interface VideoProcessingResult {
  duration_seconds: number;
  metadata: Record<string, unknown>;
  thumbnail_key: string;
}

@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video)
    private readonly repository: Repository<Video>,
  ) {}

  async createDraftWithUniqueSlug(
    input: CreateDraftVideoInput,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_SLUG_RETRIES; attempt++) {
      const slug = generateSlug();
      try {
        return await this.repository.save(
          this.repository.create({
            ...input,
            slug,
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (err) {
        if (isPgUniqueViolationOnColumn(err, SLUG_COLUMN)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('Slug conflict could not be resolved after max retries');
  }

  async findByIdScopedToChannel(
    videoId: string,
    channelId: string,
  ): Promise<Video | null> {
    return this.repository.findOne({
      where: { id: videoId, channel_id: channelId },
    });
  }

  async findByUploadIdScopedToChannel(
    uploadId: string,
    channelId: string,
  ): Promise<Video | null> {
    return this.repository.findOne({
      where: { upload_id: uploadId, channel_id: channelId },
    });
  }

  async attachUpload(
    videoId: string,
    storageKey: string,
    uploadId: string,
  ): Promise<void> {
    await this.repository.update(videoId, {
      storage_key: storageKey,
      upload_id: uploadId,
    });
  }

  /**
   * Atomically transitions draft -> processing. Returns false when the video
   * was not in `draft` anymore (already completed / concurrent completion).
   */
  async markProcessingIfDraft(videoId: string): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(Video)
      .set({ status: VideoStatus.PROCESSING })
      .where('id = :id', { id: videoId })
      .andWhere('status = :status', { status: VideoStatus.DRAFT })
      .execute();
    return result.affected === 1;
  }

  async revertToDraft(videoId: string): Promise<void> {
    await this.repository.update(videoId, { status: VideoStatus.DRAFT });
  }

  async markReady(
    videoId: string,
    result: VideoProcessingResult,
  ): Promise<void> {
    // TypeORM's QueryDeepPartialEntity mistreats a plain Record<string, unknown>
    // jsonb value as a nested entity partial — cast just that field to the
    // exact type update() expects for it, instead of widening to `any`.
    const patch: QueryDeepPartialEntity<Video> = {
      status: VideoStatus.READY,
      duration_seconds: result.duration_seconds,
      metadata: result.metadata as QueryDeepPartialEntity<Video>['metadata'],
      thumbnail_key: result.thumbnail_key,
    };
    await this.repository.update(videoId, patch);
  }

  async markError(videoId: string, errorReason: string): Promise<void> {
    await this.repository.update(videoId, {
      status: VideoStatus.ERROR,
      error_reason: errorReason,
    });
  }
}
