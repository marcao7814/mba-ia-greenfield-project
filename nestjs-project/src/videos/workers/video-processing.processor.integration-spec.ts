import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import storageConfig from '../../config/storage.config';
import videoProcessingConfig from '../../config/video-processing.config';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from '../entities/video.entity';
import { VideosRepository } from '../repositories/videos.repository';
import type { VideoProcessingJobData } from '../videos.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

function makeJob(data: VideoProcessingJobData): Job<VideoProcessingJobData> {
  return { data } as Job<VideoProcessingJobData>;
}

describe('VideoProcessingProcessor (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videosRepository: VideosRepository;
  let storageService: StorageService;
  let processor: VideoProcessingProcessor;
  let fixturesDir: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoProcessingConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideosRepository, VideoProcessingProcessor],
    }).compile();

    await moduleFixture.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    videosRepository = moduleFixture.get(VideosRepository);
    storageService = moduleFixture.get(StorageService);
    processor = moduleFixture.get(VideoProcessingProcessor);

    fixturesDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'video-fixture-'),
    );
  }, 30000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    if (fixturesDir) {
      await fs.promises.rm(fixturesDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `c${counter}`,
        nickname: `c${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function createProcessingVideo(): Promise<Video> {
    const channel = await createChannel();
    const draft = await videosRepository.createDraftWithUniqueSlug({
      channel_id: channel.id,
      title: 'video',
      description: null,
      declared_size_bytes: 0,
    });
    await videosRepository.attachUpload(
      draft.id,
      `${draft.id}/source`,
      'upload-x',
    );
    await videosRepository.markProcessingIfDraft(draft.id);
    return videoRepository.findOneByOrFail({ id: draft.id });
  }

  async function generateSyntheticVideo(filename: string): Promise<string> {
    const outputPath = path.join(fixturesDir, filename);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:d=2:r=10',
      '-pix_fmt',
      'yuv420p',
      outputPath,
    ]);
    return outputPath;
  }

  it('extracts metadata, generates a thumbnail, and marks the video ready', async () => {
    const video = await createProcessingVideo();
    const localPath = await generateSyntheticVideo(`${video.id}.mp4`);
    const fileBuffer = await fs.promises.readFile(localPath);
    await storageService.uploadObject(
      storageService.sourceBucket,
      video.storage_key!,
      fileBuffer,
      'video/mp4',
    );

    await processor.process(
      makeJob({ videoId: video.id, storageKey: video.storage_key! }),
    );

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted?.status).toBe(VideoStatus.READY);
    expect(persisted?.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(persisted?.thumbnail_key).toBe(`${video.id}/thumbnail.jpg`);
    expect(persisted?.metadata).toMatchObject({ width: 64, height: 64 });

    const { sizeBytes } = await storageService.headObject(
      storageService.thumbnailsBucket,
      persisted!.thumbnail_key!,
    );
    expect(sizeBytes).toBeGreaterThan(0);
  }, 30000);

  it('marks the video as error with a closed error code when the file is not a valid video', async () => {
    const video = await createProcessingVideo();
    const corruptBuffer = Buffer.from('this is not a real video file');
    await storageService.uploadObject(
      storageService.sourceBucket,
      video.storage_key!,
      corruptBuffer,
      'video/mp4',
    );

    await expect(
      processor.process(
        makeJob({ videoId: video.id, storageKey: video.storage_key! }),
      ),
    ).rejects.toThrow();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted?.status).toBe(VideoStatus.ERROR);
    expect(persisted?.error_reason).toBe('PROCESSING_FAILED');
  }, 30000);
});
