import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoUploadTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_TOO_LARGE',
      413,
      'The declared upload size exceeds the 10 GiB limit',
    );
  }
}

export class InvalidContentTypeException extends DomainException {
  constructor() {
    super(
      'INVALID_CONTENT_TYPE',
      400,
      'The provided content type is not an accepted video format',
    );
  }
}

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'The authenticated user has no channel to own the video',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotUploadableException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_UPLOADABLE',
      409,
      'The video is not in a state that accepts upload completion or abort',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'The video has not finished processing yet');
  }
}
