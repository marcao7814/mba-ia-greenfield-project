import {
  UploadAlreadyCompletedException,
  UploadNotInProgressException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import type { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  STREAM_URL_TTL_SECONDS,
} from './videos.constants';
import { VideosService } from './videos.service';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    channel_id: 'channel-1',
    title: 'title',
    description: null,
    status: VideoStatus.DRAFT,
    slug: 'abc123def456',
    storage_key: 'video-1/source',
    thumbnail_key: null,
    upload_id: 'upload-1',
    declared_size_bytes: 1024,
    duration_seconds: null,
    metadata: null,
    error_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as unknown as Channel,
    ...overrides,
  };
}

describe('VideosService', () => {
  let service: VideosService;
  let videosRepository: {
    createDraftWithUniqueSlug: jest.Mock;
    findByIdScopedToChannel: jest.Mock;
    findByUploadIdScopedToChannel: jest.Mock;
    attachUpload: jest.Mock;
    markProcessingIfDraft: jest.Mock;
    revertToDraft: jest.Mock;
  };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
    createPresignedGetUrl: jest.Mock;
    sourceBucket: string;
  };
  let queue: { add: jest.Mock };

  beforeEach(() => {
    videosRepository = {
      createDraftWithUniqueSlug: jest.fn(),
      findByIdScopedToChannel: jest.fn(),
      findByUploadIdScopedToChannel: jest.fn(),
      attachUpload: jest.fn(),
      markProcessingIfDraft: jest.fn(),
      revertToDraft: jest.fn(),
    };
    storageService = {
      createMultipartUpload: jest.fn(),
      presignUploadPart: jest.fn(),
      completeMultipartUpload: jest.fn(),
      headObject: jest.fn(),
      createPresignedGetUrl: jest.fn(),
      sourceBucket: 'videos-source',
    };
    queue = { add: jest.fn() };

    service = new VideosService(
      videosRepository as any,
      storageService as any,
      queue as any,
    );
  });

  describe('initiateUpload', () => {
    it('builds the storage key from the video id, not the channel id', async () => {
      const video = makeVideo({ id: 'video-42', channel_id: 'channel-9' });
      videosRepository.createDraftWithUniqueSlug.mockResolvedValue(video);
      storageService.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-abc',
      });

      const result = await service.initiateUpload('channel-9', {
        title: 'title',
        fileSizeBytes: 1024,
        contentType: 'video/mp4',
      } as any);

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        'videos-source',
        'video-42/source',
      );
      expect(videosRepository.attachUpload).toHaveBeenCalledWith(
        'video-42',
        'video-42/source',
        'upload-abc',
      );
      expect(result).toEqual({
        videoId: 'video-42',
        slug: video.slug,
        uploadId: 'upload-abc',
      });
    });
  });

  describe('getUploadPartUrl', () => {
    it('throws UploadNotInProgressException when video status is not draft', async () => {
      videosRepository.findByUploadIdScopedToChannel.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getUploadPartUrl('channel-1', 'upload-1', 1),
      ).rejects.toThrow(UploadNotInProgressException);
    });

    it('throws VideoNotFoundException when no video matches the upload', async () => {
      videosRepository.findByUploadIdScopedToChannel.mockResolvedValue(null);

      await expect(
        service.getUploadPartUrl('channel-1', 'upload-1', 1),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('completeUpload', () => {
    const dto = { uploadId: 'upload-1', parts: [{ partNumber: 1, eTag: 'e' }] };

    it('rejects a second concurrent completion with UploadAlreadyCompletedException', async () => {
      videosRepository.findByIdScopedToChannel.mockResolvedValue(makeVideo());
      videosRepository.markProcessingIfDraft.mockResolvedValue(false);

      await expect(
        service.completeUpload('channel-1', 'video-1', dto as any),
      ).rejects.toThrow(UploadAlreadyCompletedException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('reverts to draft and throws UploadSizeMismatchException on size mismatch', async () => {
      videosRepository.findByIdScopedToChannel.mockResolvedValue(
        makeVideo({ declared_size_bytes: 2048 }),
      );
      videosRepository.markProcessingIfDraft.mockResolvedValue(true);
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.headObject.mockResolvedValue({ sizeBytes: 1024 });

      await expect(
        service.completeUpload('channel-1', 'video-1', dto as any),
      ).rejects.toThrow(UploadSizeMismatchException);
      expect(videosRepository.revertToDraft).toHaveBeenCalledWith('video-1');
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('enqueues the processing job when size matches', async () => {
      videosRepository.findByIdScopedToChannel.mockResolvedValue(
        makeVideo({ declared_size_bytes: 1024 }),
      );
      videosRepository.markProcessingIfDraft.mockResolvedValue(true);
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      storageService.headObject.mockResolvedValue({ sizeBytes: 1024 });

      const result = await service.completeUpload(
        'channel-1',
        'video-1',
        dto as any,
      );

      expect(queue.add).toHaveBeenCalledWith(
        'video.process',
        { videoId: 'video-1', storageKey: 'video-1/source' },
        expect.objectContaining({ jobId: 'video-1' }),
      );
      expect(result).toEqual({
        videoId: 'video-1',
        status: VideoStatus.PROCESSING,
      });
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    it('rejects with VideoNotReadyException when the video is not ready', async () => {
      videosRepository.findByIdScopedToChannel.mockResolvedValue(
        makeVideo({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.getStreamUrl('channel-1', 'video-1'),
      ).rejects.toThrow(VideoNotReadyException);
      await expect(
        service.getDownloadUrl('channel-1', 'video-1'),
      ).rejects.toThrow(VideoNotReadyException);
    });

    it('uses a shorter TTL for download than for streaming', async () => {
      videosRepository.findByIdScopedToChannel.mockResolvedValue(
        makeVideo({ status: VideoStatus.READY }),
      );
      storageService.createPresignedGetUrl.mockResolvedValue('https://x');

      const stream = await service.getStreamUrl('channel-1', 'video-1');
      const download = await service.getDownloadUrl('channel-1', 'video-1');

      expect(stream.expiresInSeconds).toBe(STREAM_URL_TTL_SECONDS);
      expect(download.expiresInSeconds).toBe(DOWNLOAD_URL_TTL_SECONDS);
      expect(download.expiresInSeconds).toBeLessThan(stream.expiresInSeconds);
    });
  });
});
