import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import authConfig from '../config/auth.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { PublicIdService } from './public-id.service';
import { VIDEO_QUEUE } from './videos.constants';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('compiles and wires the queue, controller, repository and services', async () => {
    // Override the infra-backed tokens (repositories, queue, storage, channels)
    // so compile() resolves the DI graph without touching Postgres, Redis or MinIO.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [authConfig] }),
        VideosModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .overrideProvider(getRepositoryToken(Channel))
      .useValue({})
      .overrideProvider(getQueueToken(VIDEO_QUEUE))
      .useValue({})
      .overrideProvider(StorageService)
      .useValue({})
      .overrideProvider(ChannelsService)
      .useValue({})
      .compile();

    expect(moduleRef.get(VideosRepository)).toBeInstanceOf(VideosRepository);
    expect(moduleRef.get(PublicIdService)).toBeInstanceOf(PublicIdService);
    expect(moduleRef.get(VideosService)).toBeInstanceOf(VideosService);
    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(getQueueToken(VIDEO_QUEUE))).toBeDefined();

    await moduleRef.close();
  });
});
