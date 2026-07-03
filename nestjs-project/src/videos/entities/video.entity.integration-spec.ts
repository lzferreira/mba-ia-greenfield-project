import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter++;
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function newVideo(channel: Channel, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      channel_id: channel.id,
      title: 'A Video',
      public_id: `pub${counter}${Math.random().toString(36).slice(2, 8)}`.slice(
        0,
        11,
      ),
      storage_key: `videos/${counter}/original`,
      content_type: 'video/mp4',
      ...overrides,
    });
  }

  it('should default status to draft when not provided', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(newVideo(channel));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce unique public_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(newVideo(channel, { public_id: 'dupdupdup01' }));

    await expect(
      videoRepository.save(newVideo(channel, { public_id: 'dupdupdup01' })),
    ).rejects.toThrow();
  });

  it('should reject a null channel_id', async () => {
    const channel = await createChannel();
    const video = newVideo(channel);
    video.channel_id = null as unknown as string;

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should reject a null title', async () => {
    const channel = await createChannel();
    const video = newVideo(channel);
    video.title = null as unknown as string;

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should reject a null storage_key', async () => {
    const channel = await createChannel();
    const video = newVideo(channel);
    video.storage_key = null as unknown as string;

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should cascade-delete videos when the owning channel is removed', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(newVideo(channel));

    await channelRepository.delete(channel.id);

    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found).toBeNull();
  });
});
