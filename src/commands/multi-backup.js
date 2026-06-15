import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { walkDir, sampleFiles, buildManifest, formatSize } from '../utils/file.js';
import { ConcurrencyPool, retryWithBackoff } from '../utils/concurrency.js';
import { copyWithResume } from '../utils/chunk.js';

export async function multiBackupCommand(sources, options) {
  const {
    output,
    sampleRate = 0.1,
    exclude = ['node_modules', '.git', 'dist', 'build'],
    extensions = null,
    concurrency = 2,
    rateLimit = 0,
    retries = 2,
    verbose = false,
    resume = true
  } = options;

  logger.section('多源并发备份');
  logger.info(`源目录数: ${sources.length}`);
  logger.info(`输出目录: ${output}`);
  logger.info(`并发数: ${concurrency}`);
  logger.info(`重试次数: ${retries}`);

  const pool = new ConcurrencyPool(concurrency, rateLimit);
  const results = [];

  for (const source of sources) {
    pool.add(async () => {
      const sourceName = path.basename(source);
      logger.setCorrelationId(sourceName);

      try {
        const result = await retryWithBackoff(
          (attempt) => backupSingleSource(source, {
            output,
            sampleRate,
            exclude,
            extensions,
            name: sourceName,
            verbose,
            resume,
            attempt
          }),
          {
            maxRetries: retries,
            label: `backup-${sourceName}`,
            onRetry(attempt, err) {
              logger.warn(`源 ${sourceName} 备份重试 ${attempt}`, { error: err.message });
            }
          }
        );

        results.push({ source, status: 'success', ...result });
        logger.info(`源 ${sourceName} 备份完成`);
      } catch (err) {
        results.push({ source, status: 'failed', error: err.message });
        logger.error(`源 ${sourceName} 备份失败: ${err.message}`);
      }

      logger.setCorrelationId(null);
    }, `backup-${path.basename(source)}`);
  }

  while (pool.active > 0 || pool.pending > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.section('多源备份汇总');
  const succeeded = results.filter(r => r.status === 'success');
  const failed = results.filter(r => r.status === 'failed');

  logger.info(`成功: ${succeeded.length}`);
  if (failed.length > 0) {
    logger.error(`失败: ${failed.length}`);
    failed.forEach(f => logger.listItem(`${f.source}: ${f.error}`));
  }

  const allOk = failed.length === 0;
  return { results, succeeded, failed, allOk };
}

async function backupSingleSource(source, options) {
  const {
    output,
    sampleRate,
    exclude,
    extensions,
    name,
    verbose,
    resume,
    attempt = 0
  } = options;

  if (!await fs.pathExists(source)) {
    throw new Error(`源目录不存在: ${source}`);
  }

  const sourceStat = await fs.stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`源路径不是目录: ${source}`);
  }

  logger.info(`扫描源目录: ${source}`);

  const allFiles = await walkDir(source, {
    exclude,
    extensions: extensions ? extensions.split(',').map(e => e.trim().toLowerCase()) : null
  });

  if (allFiles.length === 0) {
    logger.warn(`${source}: 没有找到文件`);
    return { backupDir: null, fileCount: 0, totalSize: 0 };
  }

  const sampledFiles = sampleFiles(allFiles, sampleRate);

  const backupName = name || `backup-${Date.now()}`;
  const backupDir = path.join(output, backupName);
  const filesDir = path.join(backupDir, 'files');

  let totalSize = 0;
  let copiedCount = 0;

  for (const file of sampledFiles) {
    const destPath = path.join(filesDir, file.relativePath);

    const copyResult = await copyWithResume(file.path, destPath, {
      onProgress(current, total, bytesDone, bytesTotal) {
        if (verbose && current === total) {
          logger.debug(`已复制: ${file.relativePath}`);
        }
      }
    });

    const stats = await fs.stat(file.path);
    totalSize += stats.size;
    copiedCount++;
  }

  const manifest = await buildManifest(sampledFiles, source);
  manifest.backupName = backupName;
  manifest.sampleRate = sampleRate;
  manifest.totalFilesSampled = sampledFiles.length;
  manifest.totalFilesSource = allFiles.length;
  manifest.totalSize = totalSize;

  const manifestPath = path.join(backupDir, 'manifest.json');
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  logger.info(`备份完成: ${backupName} (${copiedCount} 文件, ${formatSize(totalSize)})`);

  return { backupDir, manifest, fileCount: copiedCount, totalSize };
}
