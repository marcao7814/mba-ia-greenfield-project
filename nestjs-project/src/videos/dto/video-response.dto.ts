import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ nullable: true, required: false })
  description: string | null;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ nullable: true, required: false })
  durationSeconds: number | null;

  @ApiProperty({ nullable: true, required: false })
  errorReason: string | null;

  @ApiProperty()
  createdAt: Date;
}
