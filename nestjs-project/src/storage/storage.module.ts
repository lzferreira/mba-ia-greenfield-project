import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Shared object-storage infrastructure. `storageConfig` is loaded by the global
 * ConfigModule (see AppModule), so StorageService resolves its config without a
 * local ConfigModule.forFeature import.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
