import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let counter = 0;
  async function registerConfirmAndLogin(): Promise<{
    accessToken: string;
    channelId: string;
  }> {
    const email = `videos_e2e_${++counter}@example.com`;
    const password = 'password123';
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    const registerRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const channel = await channelRepository.findOneByOrFail({
      user_id: registerRes.body.id,
    });

    return {
      accessToken: loginRes.body.access_token,
      channelId: channel.id,
    };
  }

  async function uploadObjectViaPresignedPart(
    accessToken: string,
    channelId: string,
    body: Buffer,
    contentType = 'video/mp4',
  ): Promise<{ videoId: string; uploadId: string }> {
    const initiateRes = await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos/uploads`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'My video',
        fileSizeBytes: body.length,
        contentType,
      })
      .expect(201);

    const { videoId, uploadId } = initiateRes.body;

    const partRes = await request(app.getHttpServer())
      .get(`/channels/${channelId}/videos/uploads/${uploadId}/parts/1`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const putRes = await fetch(partRes.body.url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    const eTag = putRes.headers.get('etag')!.replace(/"/g, '');

    await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ uploadId, parts: [{ partNumber: 1, eTag }] })
      .expect(200);

    return { videoId, uploadId };
  }

  describe('POST /channels/:channelId/videos/uploads', () => {
    it('returns 201 with { videoId, slug, uploadId } and persists a draft video', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          fileSizeBytes: 1024,
          contentType: 'video/mp4',
        })
        .expect(201);

      expect(res.body.videoId).toBeDefined();
      expect(res.body.slug).toBeDefined();
      expect(res.body.uploadId).toBeDefined();

      const persisted = await videoRepository.findOneBy({
        id: res.body.videoId,
      });
      expect(persisted?.status).toBe(VideoStatus.DRAFT);
    });

    it('returns 400 VALIDATION_ERROR when fileSizeBytes exceeds 10GB', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          fileSizeBytes: 10737418241,
          contentType: 'video/mp4',
        })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 403 CHANNEL_NOT_OWNED when channelId belongs to another user', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { channelId: otherChannelId } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post(`/channels/${otherChannelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          fileSizeBytes: 1024,
          contentType: 'video/mp4',
        })
        .expect(403);

      expect(res.body.error).toBe('CHANNEL_NOT_OWNED');
    });

    it('returns 401 without an Authorization header', async () => {
      const { channelId } = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .send({
          title: 'My video',
          fileSizeBytes: 1024,
          contentType: 'video/mp4',
        })
        .expect(401);
    });
  });

  describe('GET /channels/:channelId/videos/uploads/:uploadId/parts/:partNumber', () => {
    it('returns 200 with a presigned URL', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const initiateRes = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'v', fileSizeBytes: 1024, contentType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .get(
          `/channels/${channelId}/videos/uploads/${initiateRes.body.uploadId}/parts/1`,
        )
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.url).toBeDefined();
      expect(res.body.expiresInSeconds).toBeGreaterThan(0);
    });

    it('returns 409 UPLOAD_NOT_IN_PROGRESS when the video is no longer draft', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const body = Buffer.from('payload');
      const { uploadId } = await uploadObjectViaPresignedPart(
        accessToken,
        channelId,
        body,
      );

      const res = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/uploads/${uploadId}/parts/1`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);

      expect(res.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');
    });
  });

  describe('POST /channels/:channelId/videos/:videoId/uploads/complete', () => {
    it('returns 200 and transitions the video to processing', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const body = Buffer.from('payload');
      const { videoId } = await uploadObjectViaPresignedPart(
        accessToken,
        channelId,
        body,
      );

      const persisted = await videoRepository.findOneBy({ id: videoId });
      expect(persisted?.status).toBe(VideoStatus.PROCESSING);
    });

    it('returns 409 UPLOAD_ALREADY_COMPLETED on a repeated call', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const body = Buffer.from('payload');
      const { videoId, uploadId } = await uploadObjectViaPresignedPart(
        accessToken,
        channelId,
        body,
      );

      const res = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ uploadId, parts: [{ partNumber: 1, eTag: 'irrelevant' }] })
        .expect(409);

      expect(res.body.error).toBe('UPLOAD_ALREADY_COMPLETED');
    });

    it('returns 422 UPLOAD_SIZE_MISMATCH and reverts the video to draft', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const declaredSize = 4096;
      const actualBody = Buffer.from('much shorter payload');

      const initiateRes = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'v',
          fileSizeBytes: declaredSize,
          contentType: 'video/mp4',
        });
      const { videoId, uploadId } = initiateRes.body;

      const partRes = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/uploads/${uploadId}/parts/1`)
        .set('Authorization', `Bearer ${accessToken}`);
      const putRes = await fetch(partRes.body.url, {
        method: 'PUT',
        body: new Uint8Array(actualBody),
      });
      const eTag = putRes.headers.get('etag')!.replace(/"/g, '');

      const res = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/${videoId}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ uploadId, parts: [{ partNumber: 1, eTag }] })
        .expect(422);

      expect(res.body.error).toBe('UPLOAD_SIZE_MISMATCH');

      const persisted = await videoRepository.findOneBy({ id: videoId });
      expect(persisted?.status).toBe(VideoStatus.DRAFT);
    });
  });

  describe('GET /channels/:channelId/videos/:videoId', () => {
    it('returns 200 with the current video status', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const initiateRes = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'v', fileSizeBytes: 1024, contentType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/${initiateRes.body.videoId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.status).toBe(VideoStatus.DRAFT);
      expect(res.body.slug).toBe(initiateRes.body.slug);
    });

    it('returns 404 VIDEO_NOT_FOUND for a video belonging to another channel', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const other = await registerConfirmAndLogin();
      const initiateRes = await request(app.getHttpServer())
        .post(`/channels/${other.channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ title: 'v', fileSizeBytes: 1024, contentType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/${initiateRes.body.videoId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /channels/:channelId/videos/:videoId/stream and /download', () => {
    it('returns 409 VIDEO_NOT_READY when the video is still processing', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const { videoId } = await uploadObjectViaPresignedPart(
        accessToken,
        channelId,
        Buffer.from('payload'),
      );

      const streamRes = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/${videoId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(streamRes.body.error).toBe('VIDEO_NOT_READY');

      const downloadRes = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/${videoId}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(downloadRes.body.error).toBe('VIDEO_NOT_READY');
    });

    it('returns 200 with a working Range-capable URL once the video is ready', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const body = Buffer.from('0123456789'.repeat(10));
      const { videoId } = await uploadObjectViaPresignedPart(
        accessToken,
        channelId,
        body,
      );
      await videoRepository.update(videoId, { status: VideoStatus.READY });

      const streamRes = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/${videoId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(streamRes.body.expiresInSeconds).toBe(3600);

      const rangeResponse = await fetch(streamRes.body.url, {
        headers: { Range: 'bytes=0-9' },
      });
      expect(rangeResponse.status).toBe(206);

      const downloadRes = await request(app.getHttpServer())
        .get(`/channels/${channelId}/videos/${videoId}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(downloadRes.body.expiresInSeconds).toBe(300);
      expect(downloadRes.body.expiresInSeconds).toBeLessThan(
        streamRes.body.expiresInSeconds,
      );
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 on the 11th upload-initiation request within 60s', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();

      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post(`/channels/${channelId}/videos/uploads`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({
            title: 'v',
            fileSizeBytes: 1024,
            contentType: 'video/mp4',
          })
          .expect(201);
      }

      await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'v', fileSizeBytes: 1024, contentType: 'video/mp4' })
        .expect(429);
    });

    it('does not rate-limit status polling at the upload-initiation limit', async () => {
      const { accessToken, channelId } = await registerConfirmAndLogin();
      const initiateRes = await request(app.getHttpServer())
        .post(`/channels/${channelId}/videos/uploads`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'v', fileSizeBytes: 1024, contentType: 'video/mp4' });

      for (let i = 0; i < 15; i++) {
        await request(app.getHttpServer())
          .get(`/channels/${channelId}/videos/${initiateRes.body.videoId}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);
      }
    });
  });
});
