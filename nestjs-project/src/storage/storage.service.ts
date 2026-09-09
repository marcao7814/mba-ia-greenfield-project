import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface UploadPart {
  partNumber: number;
  eTag: string;
}

const PART_URL_EXPIRATION_SECONDS = 3600;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;
  private readonly bucketSource: string;
  private readonly bucketThumbnails: string;

  constructor(
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucketSource = config.bucketSource;
    this.bucketThumbnails = config.bucketThumbnails;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey!,
        secretAccessKey: config.secretKey!,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket(this.bucketSource);
    await this.ensureBucket(this.bucketThumbnails);
  }

  get sourceBucket(): string {
    return this.bucketSource;
  }

  get thumbnailsBucket(): string {
    return this.bucketThumbnails;
  }

  async createMultipartUpload(
    bucket: string,
    key: string,
  ): Promise<{ uploadId: string }> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    return { uploadId: result.UploadId! };
  }

  async presignUploadPart(
    bucket: string,
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const command = new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: PART_URL_EXPIRATION_SECONDS,
    });
    return { url, expiresInSeconds: PART_URL_EXPIRATION_SECONDS };
  }

  async completeMultipartUpload(
    bucket: string,
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.eTag,
            })),
        },
      }),
    );
  }

  async headObject(bucket: string, key: string): Promise<{ sizeBytes: number }> {
    const result = await this.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return { sizeBytes: result.ContentLength ?? 0 };
  }

  async createPresignedGetUrl(
    bucket: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async uploadObject(
    bucket: string,
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  private async ensureBucket(bucket: string): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  }
}
