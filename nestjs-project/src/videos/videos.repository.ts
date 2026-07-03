import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './entities/video.entity';

@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video)
    private readonly repository: Repository<Video>,
  ) {}

  async existsByPublicId(publicId: string): Promise<boolean> {
    return this.repository.existsBy({ public_id: publicId });
  }

  async findById(id: string): Promise<Video | null> {
    return this.repository.findOneBy({ id });
  }

  async findByPublicId(publicId: string): Promise<Video | null> {
    return this.repository.findOneBy({ public_id: publicId });
  }

  create(data: Partial<Video>): Video {
    return this.repository.create(data);
  }

  async save(video: Video): Promise<Video> {
    return this.repository.save(video);
  }

  async delete(id: string): Promise<void> {
    await this.repository.delete(id);
  }
}
