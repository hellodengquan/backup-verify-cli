import logger from '../utils/logger.js';
import { verifyChunked } from '../utils/chunk.js';

const DEFAULT_CHUNK = 4 * 1024 * 1024;

export async function chunkedVerifyCommand(backupDir, options) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK;
  const verbose = options.verbose || false;
  const resume = options.resume !== false;

  const { isOk, results } = await verifyChunked(backupDir, {
    chunkSize,
    verbose,
    resume
  });

  process.exit(isOk ? 0 : 1);
}
