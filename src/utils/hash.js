import { createHash } from 'crypto';
import { createReadStream, readFileSync } from 'fs';

export function generateHash(content, algorithm = 'sha256') {
  return createHash(algorithm).update(content).digest('hex');
}

export function hashFile(filePath, algorithm = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function hashFileSync(filePath, algorithm = 'sha256') {
  const content = readFileSync(filePath);
  return generateHash(content, algorithm);
}
