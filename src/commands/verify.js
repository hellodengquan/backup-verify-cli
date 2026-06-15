import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { hashFile } from '../utils/hash.js';
import { getFileInfo, formatSize } from '../utils/file.js';

export async function verifyCommand(backupDir, options) {
  const { verbose = false, full = false } = options;

  logger.section('完整性检查开始');
  logger.info(`备份目录: ${backupDir}`);

  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!await fs.pathExists(manifestPath)) {
    logger.error(`清单文件不存在: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = await fs.readJson(manifestPath);
  const filesDir = path.join(backupDir, 'files');
  const files = Object.entries(manifest.files);

  logger.info(`备份名称: ${manifest.backupName || '未知'}`);
  logger.info(`清单文件数: ${files.length}`);
  logger.info(`创建时间: ${manifest.createdAt}`);

  const results = {
    passed: [],
    failed: [],
    missing: [],
    extra: []
  };

  logger.info('正在校验文件完整性...');

  for (const [relPath, expected] of files) {
    const filePath = path.join(filesDir, relPath);

    if (!await fs.pathExists(filePath)) {
      results.missing.push({ path: relPath, expected });
      if (verbose) logger.warn(`缺失文件: ${relPath}`);
      continue;
    }

    try {
      const actualHash = await hashFile(filePath);
      const actualInfo = await getFileInfo(filePath);

      const isHashMatch = actualHash === expected.hash;
      const isSizeMatch = actualInfo.size === expected.size;

      if (isHashMatch && isSizeMatch) {
        results.passed.push({
          path: relPath,
          hash: actualHash,
          size: actualInfo.size
        });
        if (verbose) logger.success(`校验通过: ${relPath}`);
      } else {
        const issues = [];
        if (!isHashMatch) issues.push('哈希不匹配');
        if (!isSizeMatch) issues.push('大小不匹配');
        results.failed.push({
          path: relPath,
          expected,
          actual: { hash: actualHash, size: actualInfo.size },
          issues
        });
        logger.warn(`校验失败: ${relPath} - ${issues.join(', ')}`);
      }
    } catch (err) {
      results.failed.push({
        path: relPath,
        error: err.message
      });
      logger.error(`读取失败: ${relPath} - ${err.message}`);
    }
  }

  if (full) {
    logger.info('正在检查多余文件...');
    const allFiles = await walkBackupDir(filesDir);
    const manifestPaths = new Set(files.map(([p]) => p));

    for (const relPath of allFiles) {
      if (!manifestPaths.has(relPath)) {
        results.extra.push(relPath);
        if (verbose) logger.warn(`多余文件: ${relPath}`);
      }
    }
  }

  const total = files.length;
  const passedCount = results.passed.length;
  const failedCount = results.failed.length;
  const missingCount = results.missing.length;
  const extraCount = results.extra.length;

  logger.section('检查结果');
  logger.info(`总计: ${total} 个文件`);
  logger.success(`通过: ${passedCount} 个`);

  if (failedCount > 0) logger.error(`损坏: ${failedCount} 个`);
  if (missingCount > 0) logger.error(`缺失: ${missingCount} 个`);
  if (extraCount > 0) logger.warn(`多余: ${extraCount} 个`);

  const isOk = failedCount === 0 && missingCount === 0;

  if (isOk) {
    logger.success('✓ 备份完整性校验通过');
  } else {
    logger.error('✗ 备份完整性校验失败');
  }

  if (results.failed.length > 0 && verbose) {
    logger.section('损坏文件详情');
    results.failed.forEach((f) => {
      logger.listItem(`${f.path}`);
      if (f.expected && f.actual) {
        console.log(`     期望哈希: ${f.expected.hash}`);
        console.log(`     实际哈希: ${f.actual.hash}`);
        console.log(`     期望大小: ${formatSize(f.expected.size)}`);
        console.log(`     实际大小: ${formatSize(f.actual.size)}`);
      }
      if (f.error) {
        console.log(`     错误: ${f.error}`);
      }
    });
  }

  if (results.missing.length > 0 && verbose) {
    logger.section('缺失文件列表');
    results.missing.forEach((f) => logger.listItem(f.path));
  }

  return { results, isOk, manifest };
}

async function walkBackupDir(dir, base = dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);

    if (entry.isDirectory()) {
      const sub = await walkBackupDir(fullPath, base);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}
