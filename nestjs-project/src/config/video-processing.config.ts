import { registerAs } from '@nestjs/config';

export default registerAs('videoProcessing', () => ({
  ffmpegTimeoutMs: parseInt(process.env.FFMPEG_TIMEOUT_MS || '120000', 10),
}));
