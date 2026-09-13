import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

function randomKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function uploadSinglePartObject(
  storageService: StorageService,
  bucket: string,
  key: string,
  body: Buffer,
): Promise<void> {
  const { uploadId } = await storageService.createMultipartUpload(
    bucket,
    key,
  );
  const { url } = await storageService.presignUploadPart(
    bucket,
    key,
    uploadId,
    1,
  );

  const putResponse = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  const eTag = putResponse.headers.get('etag')!.replace(/"/g, '');

  await storageService.completeMultipartUpload(bucket, key, uploadId, [
    { partNumber: 1, eTag },
  ]);
}

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    await moduleFixture.init();
    storageService = moduleFixture.get(StorageService);
  }, 15000);

  it('completes a multipart upload and makes the object retrievable with the correct size', async () => {
    const bucket = storageService.sourceBucket;
    const key = randomKey('multipart-test');
    const body = Buffer.from('hello from the integration test payload');

    await uploadSinglePartObject(storageService, bucket, key, body);

    const { sizeBytes } = await storageService.headObject(bucket, key);
    expect(sizeBytes).toBe(body.length);
  });

  it('returns a presigned GET URL that serves 206 Partial Content on a Range request', async () => {
    const bucket = storageService.sourceBucket;
    const key = randomKey('range-test');
    const body = Buffer.from('0123456789'.repeat(10));

    await uploadSinglePartObject(storageService, bucket, key, body);

    const getUrl = await storageService.createPresignedGetUrl(bucket, key, 60);
    const rangeResponse = await fetch(getUrl, {
      headers: { Range: 'bytes=0-9' },
    });

    expect(rangeResponse.status).toBe(206);
    const text = await rangeResponse.text();
    expect(text).toBe('0123456789');
  });
});
