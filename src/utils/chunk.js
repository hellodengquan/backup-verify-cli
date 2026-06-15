import { createHash } from 'crypto';
import { createReadStream, openSync, readSync, fstatSync, closeSync, writeSync } from 'fs';
import fs from 'fs-extra';
import path from 'path';
import logger from './logger.js';

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
const PROGRESS_FILE = 'chunk-progress.json';

export async function hashFileChunked(filePath, options = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    algorithm = 'sha256',
    onProgress = null
  } = options;

  const stat = await fs.stat(filePath);
  const fileSize = stat.size;

  if (fileSize <= chunkSize) {
    const hash = await simpleHashFile(filePath, algorithm);
    return {
      hash,
      chunks: [{ index: 0, offset: 0, size: fileSize, hash }],
      chunkSize,
      totalChunks: 1
    };
  }

  const totalChunks = Math.ceil(fileSize / chunkSize);
  logger.debug(`分块校验: ${filePath} (${formatSize(fileSize)}, ${totalChunks} 块)`);

  const chunks = [];

  for (let i = 0; i < totalChunks; i++) {
    const offset = i * chunkSize;
    const size = Math.min(chunkSize, fileSize - offset);

    const chunkHash = await hashChunk(filePath, offset, size, algorithm);
    chunks.push({ index: i, offset, size, hash: chunkHash });

    if (onProgress) {
      onProgress(i + 1, totalChunks, offset + size, fileSize);
    }
  }

  const fileHash = await simpleHashFile(filePath, algorithm);

  return {
    hash: fileHash,
    chunks,
    chunkSize,
    totalChunks
  };
}

async function hashChunk(filePath, offset, size, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath, { start: offset, end: offset + size - 1 });

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function simpleHashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function verifyChunked(backupDir, options = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    verbose = false,
    resume = true
  } = options;

  logger.section('分块校验开始');
  logger.info(`备份目录: ${backupDir}`);
  logger.info(`分块大小: ${formatSize(chunkSize)}`);

  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!await fs.pathExists(manifestPath)) {
    logger.error(`清单文件不存在: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = await fs.readJson(manifestPath);
  const filesDir = path.join(backupDir, 'files');
  const progressPath = path.join(backupDir, PROGRESS_FILE);

  let progress = null;
  if (resume && await fs.pathExists(progressPath)) {
    progress = await fs.readJson(progressPath);
    logger.info(`发现断点续传进度: 已完成 ${progress.completedCount}/${progress.totalFiles} 文件`);
  }

  const files = Object.entries(manifest.files);
  const results = {
    passed: [],
    failed: [],
    missing: [],
    skipped: []
  };

  const completedSet = new Set(progress?.completed || []);

  for (const [relPath, expected] of files) {
    if (completedSet.has(relPath)) {
      results.skipped.push(relPath);
      if (verbose) logger.debug(`跳过已完成: ${relPath}`);
      continue;
    }

    const filePath = path.join(filesDir, relPath);

    if (!await fs.pathExists(filePath)) {
      results.missing.push({ path: relPath, expected });
      logger.warn(`缺失文件: ${relPath}`);
      continue;
    }

    try {
      const chunkedResult = await hashFileChunked(filePath, {
        chunkSize,
        onProgress(current, total, bytesDone, bytesTotal) {
          if (verbose && current === total) {
            logger.debug(`分块完成: ${relPath} (${total} 块)`);
          }
        }
      });

      const isMatch = chunkedResult.hash === expected.hash;

      if (isMatch) {
        results.passed.push({
          path: relPath,
          hash: chunkedResult.hash,
          chunks: chunkedResult.chunks,
          totalChunks: chunkedResult.totalChunks
        });
        if (verbose) logger.info(`校验通过: ${relPath} (${chunkedResult.totalChunks} 块)`);
      } else {
        const mismatchedChunks = chunkedResult.chunks.filter((c, idx) => {
          if (expected.chunks && expected.chunks[idx]) {
            return c.hash !== expected.chunks[idx].hash;
          }
          return false;
        });

        results.failed.push({
          path: relPath,
          expected,
          actual: {
            hash: chunkedResult.hash,
            chunks: chunkedResult.chunks,
            totalChunks: chunkedResult.totalChunks
          },
          mismatchedChunks: mismatchedChunks.length > 0 ? mismatchedChunks : 'hash_mismatch'
        });
        logger.warn(`校验失败: ${relPath} - 哈希不匹配`);
      }

      completedSet.add(relPath);
      await saveProgress(progressPath, Array.from(completedSet), files.length);

    } catch (err) {
      results.failed.push({ path: relPath, error: err.message });
      logger.error(`读取失败: ${relPath} - ${err.message}`);
    }
  }

  const isOk = results.failed.length === 0 && results.missing.length === 0;

  logger.section('分块校验结果');
  logger.info(`总计: ${files.length} 个文件`);
  logger.info(`通过: ${results.passed.length}`);
  if (results.skipped.length) logger.info(`跳过（续传）: ${results.skipped.length}`);
  if (results.failed.length) logger.error(`失败: ${results.failed.length}`);
  if (results.missing.length) logger.error(`缺失: ${results.missing.length}`);

  if (isOk) {
    logger.success('✓ 分块校验通过');
    if (await fs.pathExists(progressPath)) await fs.remove(progressPath);
  } else {
    logger.error('✗ 分块校验失败');
  }

  return { results, isOk };
}

async function saveProgress(progressPath, completed, totalFiles) {
  await fs.writeJson(progressPath, {
    updatedAt: new Date().toISOString(),
    totalFiles,
    completedCount: completed.length,
    completed
  }, { spaces: 2 });
}

export async function copyWithResume(src, dest, options = {}) {
  const { chunkSize = DEFAULT_CHUNK_SIZE, onProgress = null } = options;

  await fs.ensureDir(path.dirname(dest));

  const srcStat = await fs.stat(src);
  const fileSize = srcStat.size;

  if (await fs.pathExists(dest)) {
    const destStat = await fs.stat(dest);
    if (destStat.size === fileSize) {
      const srcHash = await simpleHashFile(src);
      const destHash = await simpleHashFile(dest);
      if (srcHash === destHash) {
        logger.debug(`跳过已完成复制: ${path.basename(dest)}`);
        return { skipped: true };
      }
    }
  }

  const totalChunks = Math.ceil(fileSize / chunkSize);

  const fd = openSync(src, 'r');
  const wd = openSync(dest, 'w');

  try {
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const size = Math.min(chunkSize, fileSize - offset);
      const buf = Buffer.alloc(size);

      readSync(fd, buf, 0, size, offset);

      let writeOffset = offset;
      let bytesWritten = 0;
      while (bytesWritten < size) {
        const written = writeSync(wd, buf, bytesWritten, size - bytesWritten, writeOffset + bytesWritten);
        bytesWritten += written;
      }

      if (onProgress) {
        onProgress(i + 1, totalChunks, offset + size, fileSize);
      }
    }
  } finally {
    closeSync(fd);
    closeSync(wd);
  }

  return { skipped: false };
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
