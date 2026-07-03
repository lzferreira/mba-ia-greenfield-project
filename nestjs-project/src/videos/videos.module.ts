import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { ChannelsModule } from '../channels/channels.module';
import authConfig from '../config/auth.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import { VIDEO_QUEUE } from './videos.constants';
import { VideosController } from './videos.controller';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue({
      name: VIDEO_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    }),
    // Public delivery routes need to identify the owner without full AuthModule
    // coupling (which drags Mail/Users). Register just JwtModule for the
    // OptionalJwtAuthGuard, using the same secret as AuthModule.
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (cfg: ConfigType<typeof authConfig>) => ({
        secret: cfg.jwtSecret,
      }),
    }),
    StorageModule,
    ChannelsModule,
  ],
  controllers: [VideosController],
  providers: [
    VideosRepository,
    PublicIdService,
    VideosService,
    OptionalJwtAuthGuard,
  ],
  exports: [VideosRepository, PublicIdService],
})
export class VideosModule {}
