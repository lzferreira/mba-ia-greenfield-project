import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { Channel } from './channels/entities/channel.entity';
import { StorageModule } from './storage/storage.module';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { VideoProcessor } from './videos/video.processor';
import { VIDEO_QUEUE } from './videos/videos.constants';
import { VideosRepository } from './videos/videos.repository';

/**
 * Dedicated root module for the worker container (per phase-03-videos/TD-03,
 * Option A). Loads only the infrastructure the processing pipeline needs —
 * config, DB, Redis/BullMQ and storage — plus the `VideoProcessor`. The HTTP
 * API (AppModule) never registers the processor, so job consumption happens
 * exclusively in this process.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, redisConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        // Video's ManyToOne(Channel) pulls Channel → User into the metadata
        // graph; list them explicitly (no autoLoadEntities here, since the
        // worker registers only Video via forFeature).
        entities: [User, Channel, Video],
        synchronize: false,
      }),
    }),
    BullModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) => ({
        connection: {
          host: config.host,
          port: config.port,
        },
      }),
    }),
    // Registering the queue here is what makes @nestjs/bullmq attach a BullMQ
    // Worker to the `@Processor(VIDEO_QUEUE)` provider. With only forRootAsync
    // (connection) the processor is instantiated but never consumes — jobs pile
    // up in the queue's `wait` list. Job options live on the producer side.
    BullModule.registerQueue({ name: VIDEO_QUEUE }),
    TypeOrmModule.forFeature([Video]),
    StorageModule,
  ],
  providers: [VideosRepository, VideoProcessor],
})
export class WorkerModule {}
