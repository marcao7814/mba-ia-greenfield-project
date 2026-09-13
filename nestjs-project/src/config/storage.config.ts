import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT,
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY,
  secretKey: process.env.STORAGE_SECRET_KEY,
  bucketSource: process.env.STORAGE_BUCKET_SOURCE || 'videos-source',
  bucketThumbnails:
    process.env.STORAGE_BUCKET_THUMBNAILS || 'videos-thumbnails',
}));
