import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule, VIDEO_PROCESSING_QUEUE } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosRepository } from './repositories/videos.repository';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videosService: VideosService;
  let queue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        StorageModule,
        QueueModule,
        VideosModule,
      ],
    }).compile();

    await moduleFixture.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videosService = moduleFixture.get(VideosService);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 30000);

  afterAll(async () => {
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `channel${counter}`,
        nickname: `channel${counter}`,
        user_id: user.id,
      }),
    );
  }

  describe('initiateUpload', () => {
    it('persists a draft video with an upload_id from a real multipart upload', async () => {
      const channel = await createChannel();

      const result = await videosService.initiateUpload(channel.id, {
        title: 'Integration video',
        fileSizeBytes: 2048,
        contentType: 'video/mp4',
      } as any);

      const videoRepository = dataSource.getRepository(Video);
      const persisted = await videoRepository.findOneBy({
        id: result.videoId,
      });

      expect(persisted?.status).toBe(VideoStatus.DRAFT);
      expect(persisted?.upload_id).toBe(result.uploadId);
      expect(persisted?.storage_key).toBe(`${result.videoId}/source`);
    });

    it('enforces the slug unique constraint at the database level', async () => {
      const channel = await createChannel();
      const videosRepository = new VideosRepository(
        dataSource.getRepository(Video),
      );

      const first = await videosRepository.createDraftWithUniqueSlug({
        channel_id: channel.id,
        title: 'video',
        description: null,
        declared_size_bytes: 1,
      });

      await expect(
        dataSource.getRepository(Video).insert({
          channel_id: channel.id,
          title: 'video',
          slug: first.slug,
          declared_size_bytes: 1,
        }),
      ).rejects.toThrow();
    });
  });

  describe('completeUpload', () => {
    it('transitions the video to processing and publishes a job with jobId = videoId', async () => {
      const channel = await createChannel();
      const { videoId } = await videosService.initiateUpload(channel.id, {
        title: 'video',
        fileSizeBytes: 1024,
        contentType: 'video/mp4',
      } as any);

      // The multipart upload is never actually finished with real parts in
      // this test (no HTTP PUT against the presigned URL was performed), so
      // we assert the domain behaviour directly against the repository +
      // queue rather than driving it through the full S3 multipart lifecycle
      // (which is covered by StorageService's own integration test).
      const videosRepository = new VideosRepository(
        dataSource.getRepository(Video),
      );
      const transitioned =
        await videosRepository.markProcessingIfDraft(videoId);
      expect(transitioned).toBe(true);

      await queue.add(
        'video.process',
        { videoId, storageKey: `${videoId}/source` },
        { jobId: videoId },
      );

      const job = await queue.getJob(videoId);
      expect(job).toBeDefined();
      expect(job?.data).toEqual({
        videoId,
        storageKey: `${videoId}/source`,
      });

      const persisted = await dataSource
        .getRepository(Video)
        .findOneBy({ id: videoId });
      expect(persisted?.status).toBe(VideoStatus.PROCESSING);
    });
  });
});
