import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { Video } from './entities/video.entity';
import { VideosRepository } from './repositories/videos.repository';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), ChannelsModule, QueueModule],
  controllers: [VideosController],
  providers: [VideosService, VideosRepository],
  exports: [TypeOrmModule, VideosRepository],
})
export class VideosModule {}
