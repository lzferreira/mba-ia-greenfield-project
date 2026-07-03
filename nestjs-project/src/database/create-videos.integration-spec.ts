import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1783021883881 } from './migrations/1783021883881-CreateVideos';

// Ordered child → parent so sequential drops never deadlock. Concurrent
// DROP ... CASCADE across FK-linked tables (videos → channels) deadlocks.
const MANAGED_TABLES = [
  'videos',
  'refresh_tokens',
  'verification_tokens',
  'channels',
  'users',
  'migrations',
];

async function videoIndexDefs(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ indexdef: string }[]>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'videos'`,
  );
  return rows.map((r) => r.indexdef);
}

async function videoStatusEnumExists(dataSource: DataSource): Promise<boolean> {
  const rows = await dataSource.query<{ typname: string }[]>(
    `SELECT typname FROM pg_type WHERE typname = 'videos_status_enum'`,
  );
  return rows.length > 0;
}

async function tableExists(
  dataSource: DataSource,
  table: string,
): Promise<boolean> {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows.length > 0;
}

describe('CreateVideos migration (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1783021883881,
        ],
      },
    );

    await dataSource.initialize();

    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // DROP TABLE does not remove enum types; drop them so the next CREATE TYPE
    // (here or in a later Jest suite) does not fail on a leaked type.
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."verification_tokens_type_enum" CASCADE`,
    );
    await dataSource.query(
      `DROP TYPE IF EXISTS "public"."videos_status_enum" CASCADE`,
    );
  });

  afterAll(async () => {
    // Re-apply every migration so the shared DB is fully migrated for the
    // suites that run after this one.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('up should create the enum type, the videos table and its indexes', async () => {
    await dataSource.runMigrations();

    expect(await videoStatusEnumExists(dataSource)).toBe(true);
    expect(await tableExists(dataSource, 'videos')).toBe(true);

    const indexDefs = await videoIndexDefs(dataSource);
    expect(indexDefs.some((def) => def.includes('(public_id)'))).toBe(true);
    expect(indexDefs.some((def) => def.includes('(channel_id)'))).toBe(true);
    expect(indexDefs.some((def) => def.includes('(status)'))).toBe(true);
  });

  it('down should drop the videos table and its enum type without leaking it', async () => {
    await dataSource.undoLastMigration();

    expect(await tableExists(dataSource, 'videos')).toBe(false);
    expect(await videoStatusEnumExists(dataSource)).toBe(false);
  });
});
