import { Injectable } from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_LENGTH,
  PUBLIC_ID_MAX_RETRIES,
} from './videos.constants';

/**
 * Generates the 11-char URL-safe `public_id` for a video (TD-05).
 * Uniqueness is enforced by a DB unique index; on a (astronomically rare)
 * collision the caller's `exists` predicate returns true and we regenerate.
 */
@Injectable()
export class PublicIdService {
  private readonly nano = customAlphabet(PUBLIC_ID_ALPHABET, PUBLIC_ID_LENGTH);

  generate(): string {
    return this.nano();
  }

  async generateUnique(
    exists: (publicId: string) => Promise<boolean>,
  ): Promise<string> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_RETRIES; attempt++) {
      const candidate = this.generate();
      if (!(await exists(candidate))) {
        return candidate;
      }
    }
    throw new Error(
      `Failed to generate a unique public_id after ${PUBLIC_ID_MAX_RETRIES} attempts`,
    );
  }
}
