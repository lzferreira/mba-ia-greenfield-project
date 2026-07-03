import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * Worker entrypoint (per phase-03-videos/TD-03). Boots a headless Nest context
 * — no HTTP server — that instantiates the BullMQ `VideoProcessor` and consumes
 * the `video-processing` queue. Used by the `video-worker` Compose service.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log(
    'Video worker started — consuming video-processing queue',
    'Worker',
  );
}
void bootstrap();
