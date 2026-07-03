import { PublicIdService } from './public-id.service';

describe('PublicIdService', () => {
  let service: PublicIdService;

  beforeEach(() => {
    service = new PublicIdService();
  });

  it('generates an 11-char id from the URL-safe alphabet', () => {
    for (let i = 0; i < 100; i++) {
      const id = service.generate();
      expect(id).toHaveLength(11);
      expect(id).toMatch(/^[0-9a-zA-Z]{11}$/);
    }
  });

  it('returns the first candidate when there is no collision', async () => {
    const exists = jest.fn().mockResolvedValue(false);

    const id = await service.generateUnique(exists);

    expect(id).toHaveLength(11);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith(id);
  });

  it('retries on collision and returns a distinct id', async () => {
    const seen: string[] = [];
    // First candidate collides, second is free.
    const exists = jest.fn((candidate: string) => {
      seen.push(candidate);
      return Promise.resolve(seen.length === 1);
    });

    const id = await service.generateUnique(exists);

    expect(exists).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    expect(id).toBe(seen[1]);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('throws after exhausting retries when every candidate collides', async () => {
    const exists = jest.fn().mockResolvedValue(true);

    await expect(service.generateUnique(exists)).rejects.toThrow(
      /unique public_id/,
    );
  });
});
