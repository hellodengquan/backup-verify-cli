import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { walkDir, sampleFiles, buildManifest, formatSize } from '../utils/file.js';

export async function backupCommand(source, options) {
  const {
    output,
    sampleRate = 0.1,
    exclude = ['node_modules', '.git', 'dist', 'build'],
    extensions = null,
    name = null,
    verbose = false
  } = options;

  logger.section('备份任务开始');
  logger.info(`源目录: ${source}`);
  logger.info(`输出目录: ${output}`);
  logger.info(`抽样比例: ${(sampleRate * 100).toFixed(1)}%`);

  if (!await fs.pathExists(source)) {
    logger.error(`源目录不存在: ${source}`);
    process.exit(1);
  }

  const sourceStat = await fs.stat(source);
  if (!sourceStat.isDirectory()) {
    logger.error(`源路径不是目录: ${source}`);
    process.exit(1);
  }

  logger.info('正在扫描文件...');
  const allFiles = await walkDir(source, {
    exclude,
    extensions: extensions ? extensions.split(',').map(e => e.trim().toLowerCase()) : null
  });

  logger.info(`发现文件总数: ${allFiles.length}`);

  if (allFiles.length === 0) {
    logger.warn('没有找到任何文件，备份取消');
    process.exit(0);
  }

  logger.info('正在随机抽样...');
  const sampledFiles = sampleFiles(allFiles, sampleRate);
  logger.info(`抽样文件数: ${sampledFiles.length}`);

  if (verbose) {
    logger.section('抽样文件列表');
    sampledFiles.forEach((f) => logger.listItem(f.relativePath));
  }

  const backupName = name || `backup-${Date.now()}`;
  const backupDir = path.join(output, backupName);
  const filesDir = path.join(backupDir, 'files');

  logger.info(`备份目录: ${backupDir}`);
  logger.info('正在复制文件...');

  let totalSize = 0;
  let copiedCount = 0;

  for (const file of sampledFiles) {
    const destPath = path.join(filesDir, file.relativePath);
    await fs.ensureDir(path.dirname(destPath));
    await fs.copy(file.path, destPath);

    const stats = await fs.stat(file.path);
    totalSize += stats.size;
    copiedCount++;

    if (verbose) {
      logger.debug(`已复制: ${file.relativePath} (${formatSize(stats.size)})`, true);
    }
  }

  logger.info('正在生成文件清单...');
  const manifest = await buildManifest(sampledFiles, source);
  manifest.backupName = backupName;
  manifest.sampleRate = sampleRate;
  manifest.totalFilesSampled = sampledFiles.length;
  manifest.totalFilesSource = allFiles.length;
  manifest.totalSize = totalSize;

  const manifestPath = path.join(backupDir, 'manifest.json');
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  logger.section('备份完成');
  logger.success(`备份名称: ${backupName}`);
  logger.success(`复制文件数: ${copiedCount}`);
  logger.success(`总大小: ${formatSize(totalSize)}`);
  logger.success(`备份位置: ${backupDir}`);
  logger.success(`清单文件: ${manifestPath}`);

  return { backupDir, manifest, sampledFiles };
}
