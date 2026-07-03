import {
  buildFfprobeArgs,
  buildThumbnailArgs,
  parseFfprobeJson,
} from './ffmpeg.util';

describe('ffmpeg.util', () => {
  describe('parseFfprobeJson', () => {
    it('extracts duration and technical metadata from the video stream', () => {
      const stdout = JSON.stringify({
        streams: [
          { codec_type: 'audio', codec_name: 'aac', bit_rate: '128000' },
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            bit_rate: '4500000',
          },
        ],
        format: { duration: '12.34', bit_rate: '4628000' },
      });

      expect(parseFfprobeJson(stdout)).toEqual({
        durationSeconds: 12,
        metadata: {
          width: 1920,
          height: 1080,
          codec: 'h264',
          bitrate: 4500000,
        },
      });
    });

    it('falls back to format bitrate when the video stream has none', () => {
      const stdout = JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'vp9', width: 640, height: 360 },
        ],
        format: { duration: '5.9', bit_rate: '900000' },
      });

      const result = parseFfprobeJson(stdout);
      expect(result.durationSeconds).toBe(6);
      expect(result.metadata.bitrate).toBe(900000);
    });

    it('returns null metadata and zero duration when nothing is present', () => {
      const result = parseFfprobeJson(JSON.stringify({ streams: [] }));
      expect(result).toEqual({
        durationSeconds: 0,
        metadata: { width: null, height: null, codec: null, bitrate: null },
      });
    });
  });

  describe('buildFfprobeArgs', () => {
    it('requests JSON output with format and stream info', () => {
      expect(buildFfprobeArgs('/tmp/original')).toEqual([
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '/tmp/original',
      ]);
    });
  });

  describe('buildThumbnailArgs', () => {
    it('seeks to the requested second and captures a single frame', () => {
      expect(buildThumbnailArgs('/tmp/original', '/tmp/thumb.jpg', 1)).toEqual([
        '-ss',
        '1',
        '-i',
        '/tmp/original',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '-y',
        '/tmp/thumb.jpg',
      ]);
    });
  });
});
