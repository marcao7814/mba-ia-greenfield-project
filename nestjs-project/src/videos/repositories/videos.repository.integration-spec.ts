import { DataSource, Repository } from 'typeorm';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosRepository (integration)', () => {
  let dataSource: DataSource;
  let videosRepository: VideosRepository;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videosRepository = new VideosRepository(dataSource.getRepository(Video));
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_repo_${++counter}@example.com`,
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

  describe('createDraftWithUniqueSlug', () => {
    it('persists a draft video with a generated slug', async () => {
      const channel = await createChannel();

      const video = await videosRepository.createDraftWithUniqueSlug({
        channel_id: channel.id,
        title: 'My video',
        description: null,
        declared_size_bytes: 1024,
      });

      expect(video.id).toBeDefined();
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.slug).toHaveLength(12);
    });

    it('never returns the same slug twice, even under repeated calls', async () => {
      const channel = await createChannel();

      const videos = await Promise.all(
        Array.from({ length: 5 }, () =>
          videosRepository.createDraftWithUniqueSlug({
            channel_id: channel.id,
            title: 'video',
            description: null,
            declared_size_bytes: 1024,
          }),
        ),
      );

      const slugs = new Set(videos.map((v) => v.slug));
      expect(slugs.size).toBe(5);
    });
  });

  describe('findByIdScopedToChannel', () => {
    it('returns the video when it belongs to the given channel', async () => {
      const channel = await createChannel();
      const video = await videosRepository.createDraftWithUniqueSlug({
        channel_id: channel.id,
        title: 'video',
        description: null,
        declared_size_bytes: 1024,
      });

      const found = await videosRepository.findByIdScopedToChannel(
        video.id,
        channel.id,
      );

      expect(found?.id).toBe(video.id);
    });

    it('returns null when the video belongs to a different channel', async () => {
      const channel = await createChannel();
      const otherChannel = await createChannel();
      const video = await videosRepository.createDraftWithUniqueSlug({
        channel_id: channel.id,
        title: 'video',
        description: null,
        declared_size_bytes: 1024,
      });

      const found = await videosRepository.findByIdScopedToChannel(
        video.id,
        otherChannel.id,
      );

      expect(found).toBeNull();
    });
  });

  describe('markProcessingIfDraft', () => {
    it('transitions draft -> processing exactly once under concurrent calls', async () => {
      const channel = await createChannel();
      const video = await videosRepository.createDraftWithUniqueSlug({
        channel_id: channel.id,
        title: 'video',
        description: null,
        declared_size_bytes: 1024,
      });

      const results = await Promise.all([
        videosRepository.markProcessingIfDraft(video.id),
        videosRepository.markProcessingIfDraft(video.id),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
});
