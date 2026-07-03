import { spawn } from 'node:child_process';

/**
 * Typed helpers over the `ffprobe`/`ffmpeg` system binaries (per
 * phase-03-videos/TD-04 — apt binaries + direct `spawn`, no wrapper library).
 * The pure functions (`parseFfprobeJson`, `buildFfprobeArgs`,
 * `buildThumbnailArgs`) are unit-tested; the spawn orchestrators wrap them.
 */

export interface VideoTechnicalMetadata {
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
}

export interface FfprobeResult {
  durationSeconds: number;
  metadata: VideoTechnicalMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string };
}

/** ffprobe args: emit JSON with format + stream info for `filePath`. */
export function buildFfprobeArgs(filePath: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
}

/**
 * ffmpeg args to capture a single frame as a JPEG thumbnail. `-ss` before `-i`
 * seeks fast; `-frames:v 1` grabs one frame; `-y` overwrites (idempotent).
 */
export function buildThumbnailArgs(
  filePath: string,
  outPath: string,
  atSeconds: number,
): string[] {
  return [
    '-ss',
    String(atSeconds),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    outPath,
  ];
}

/** Parse the JSON emitted by `ffprobe -print_format json`. */
export function parseFfprobeJson(stdout: string): FfprobeResult {
  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');

  const rawDuration = parsed.format?.duration;
  const durationSeconds = rawDuration ? Math.round(Number(rawDuration)) : 0;

  const rawBitrate = videoStream?.bit_rate ?? parsed.format?.bit_rate;

  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    metadata: {
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      codec: videoStream?.codec_name ?? null,
      bitrate: rawBitrate ? Number(rawBitrate) : null,
    },
  };
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}: ${stderr.trim() || 'no stderr'}`,
          ),
        );
      }
    });
  });
}

/** Probe duration + technical metadata of the video at `filePath`. */
export async function ffprobe(filePath: string): Promise<FfprobeResult> {
  const stdout = await run('ffprobe', buildFfprobeArgs(filePath));
  return parseFfprobeJson(stdout);
}

/** Capture a single frame from `filePath` at `atSeconds` into `outPath`. */
export async function captureThumbnail(
  filePath: string,
  outPath: string,
  atSeconds: number,
): Promise<void> {
  await run('ffmpeg', buildThumbnailArgs(filePath, outPath, atSeconds));
}
