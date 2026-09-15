import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
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
        email: `video_entity_${++counter}@example.com`,
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

  it('defaults status to draft on creation', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My video',
        slug: 'slug00000001',
      }),
    );

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('populates created_at and updated_at automatically', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My video',
        slug: 'slug00000002',
      }),
    );

    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('enforces a unique constraint on slug', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Video 1',
        slug: 'duplicate001',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'Video 2',
          slug: 'duplicate001',
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects an invalid status enum value', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "title", "slug", "status") VALUES ($1, $2, $3, $4)`,
        [channel.id, 'Video', 'slug00000003', 'not-a-real-status'],
      ),
    ).rejects.toThrow();
  });

  it('requires a valid channel_id (foreign key)', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'Video',
          slug: 'slug00000004',
        }),
      ),
    ).rejects.toThrow();
  });
});
