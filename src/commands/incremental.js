import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { hashFile } from '../utils/hash.js';
import { getFileInfo, formatSize } from '../utils/file.js';

const SNAPSHOT_FILE = 'verify-snapshot.json';

export async function incrementalVerifyCommand(backupDir, options) {
  const { verbose = false, full = false } = options;

  logger.section('增量哈希校验开始');
  logger.info(`备份目录: ${backupDir}`);

  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!await fs.pathExists(manifestPath)) {
    logger.error(`清单文件不存在: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = await fs.readJson(manifestPath);
  const filesDir = path.join(backupDir, 'files');
  const snapshotPath = path.join(backupDir, SNAPSHOT_FILE);

  let previousSnapshot = null;
  if (await fs.pathExists(snapshotPath)) {
    previousSnapshot = await fs.readJson(snapshotPath);
    logger.info(`发现上次校验快照: ${previousSnapshot.verifiedAt}`);
  } else {
    logger.info('未发现上次校验快照，将执行全量校验');
  }

  const files = Object.entries(manifest.files);
  logger.info(`清单文件数: ${files.length}`);

  const toVerify = [];
  const skipped = [];

  for (const [relPath, expected] of files) {
    const filePath = path.join(filesDir, relPath);

    if (!await fs.pathExists(filePath)) {
      toVerify.push({ relPath, expected, filePath, reason: 'missing' });
      continue;
    }

    if (previousSnapshot && previousSnapshot.files[relPath]) {
      const prev = previousSnapshot.files[relPath];
      const currentInfo = await getFileInfo(filePath);

      if (prev.hash === expected.hash && prev.mtime === currentInfo.mtime && prev.passed) {
        skipped.push(relPath);
        continue;
      }
    }

    toVerify.push({ relPath, expected, filePath, reason: 'changed_or_new' });
  }

  logger.info(`需要校验: ${toVerify.length} 个文件`);
  logger.info(`跳过（未变更）: ${skipped.length} 个文件`);

  if (verbose && skipped.length > 0) {
    logger.section('跳过文件');
    skipped.forEach((p) => logger.listItem(`${p} (未变更)`));
  }

  const results = {
    passed: [],
    failed: [],
    missing: [],
    skipped
  };

  for (const item of toVerify) {
    const { relPath, expected, filePath, reason } = item;

    if (reason === 'missing') {
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
          size: actualInfo.size,
          mtime: actualInfo.mtime
        });
        if (verbose) logger.success(`校验通过: ${relPath}`);
      } else {
        const issues = [];
        if (!isHashMatch) issues.push('哈希不匹配');
        if (!isSizeMatch) issues.push('大小不匹配');
        results.failed.push({
          path: relPath,
          expected,
          actual: { hash: actualHash, size: actualInfo.size, mtime: actualInfo.mtime },
          issues
        });
        logger.warn(`校验失败: ${relPath} - ${issues.join(', ')}`);
      }
    } catch (err) {
      results.failed.push({ path: relPath, error: err.message });
      logger.error(`读取失败: ${relPath} - ${err.message}`);
    }
  }

  if (full) {
    logger.info('正在检查多余文件...');
    const allLocalFiles = await walkBackupDir(filesDir);
    const manifestPaths = new Set(files.map(([p]) => p));

    const extra = [];
    for (const relPath of allLocalFiles) {
      if (!manifestPaths.has(relPath)) {
        extra.push(relPath);
        if (verbose) logger.warn(`多余文件: ${relPath}`);
      }
    }
    results.extra = extra;
  }

  const newSnapshot = {
    verifiedAt: new Date().toISOString(),
    backupDir,
    totalFiles: files.length,
    verifiedFiles: toVerify.length,
    skippedFiles: skipped.length,
    passedCount: results.passed.length,
    failedCount: results.failed.length,
    missingCount: results.missing.length,
    files: {}
  };

  for (const [relPath, info] of files) {
    const passedEntry = results.passed.find(p => p.path === relPath);
    if (passedEntry) {
      newSnapshot.files[relPath] = {
        hash: passedEntry.hash,
        size: passedEntry.size,
        mtime: passedEntry.mtime,
        passed: true,
        verifiedAt: newSnapshot.verifiedAt
      };
    } else if (previousSnapshot && previousSnapshot.files[relPath] && skipped.includes(relPath)) {
      newSnapshot.files[relPath] = { ...previousSnapshot.files[relPath] };
    } else {
      newSnapshot.files[relPath] = {
        hash: info.hash,
        size: info.size,
        mtime: info.mtime,
        passed: false,
        verifiedAt: newSnapshot.verifiedAt
      };
    }
  }

  await fs.writeJson(snapshotPath, newSnapshot, { spaces: 2 });
  logger.info(`校验快照已保存: ${snapshotPath}`);

  const failedCount = results.failed.length;
  const missingCount = results.missing.length;
  const extraCount = results.extra?.length || 0;

  logger.section('增量校验结果');
  logger.info(`总计: ${files.length} 个文件`);
  logger.info(`本次校验: ${toVerify.length} 个`);
  logger.info(`跳过: ${skipped.length} 个`);
  logger.success(`通过: ${results.passed.length} 个`);

  if (failedCount > 0) logger.error(`损坏: ${failedCount} 个`);
  if (missingCount > 0) logger.error(`缺失: ${missingCount} 个`);
  if (extraCount > 0) logger.warn(`多余: ${extraCount} 个`);

  const isOk = failedCount === 0 && missingCount === 0;

  if (isOk) {
    logger.success('✓ 增量校验通过');
  } else {
    logger.error('✗ 增量校验失败');
  }

  if (results.failed.length > 0 && verbose) {
    logger.section('损坏文件详情');
    results.failed.forEach((f) => {
      logger.listItem(`${f.path}`);
      if (f.expected && f.actual) {
        console.log(`     期望哈希: ${f.expected.hash}`);
        console.log(`     实际哈希: ${f.actual.hash}`);
      }
      if (f.error) {
        console.log(`     错误: ${f.error}`);
      }
    });
  }

  return { results, isOk, snapshot: newSnapshot };
}

async function walkBackupDir(dir, base = dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath);

    if (entry.name === SNAPSHOT_FILE) continue;

    if (entry.isDirectory()) {
      const sub = await walkBackupDir(fullPath, base);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }

  return results;
}
