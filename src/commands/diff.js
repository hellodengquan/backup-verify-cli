import fs from 'fs-extra';
import path from 'path';
import { diffLines } from 'diff';
import chalk from 'chalk';
import logger from '../utils/logger.js';
import { formatSize } from '../utils/file.js';
import { exportReport } from '../utils/export.js';

export async function diffCommand(backup1, backup2, options) {
  const { verbose = false, content = false, export: exportPath = null } = options;

  logger.section('备份差异对比');
  logger.info(`备份 1: ${backup1}`);
  logger.info(`备份 2: ${backup2}`);

  const manifest1Path = path.join(backup1, 'manifest.json');
  const manifest2Path = path.join(backup2, 'manifest.json');

  if (!await fs.pathExists(manifest1Path)) {
    logger.error(`备份 1 清单文件不存在: ${manifest1Path}`);
    process.exit(1);
  }
  if (!await fs.pathExists(manifest2Path)) {
    logger.error(`备份 2 清单文件不存在: ${manifest2Path}`);
    process.exit(1);
  }

  const manifest1 = await fs.readJson(manifest1Path);
  const manifest2 = await fs.readJson(manifest2Path);

  const files1 = manifest1.files;
  const files2 = manifest2.files;

  const allPaths = new Set([...Object.keys(files1), ...Object.keys(files2)]);

  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];

  for (const relPath of allPaths) {
    const in1 = files1[relPath];
    const in2 = files2[relPath];

    if (!in1 && in2) {
      added.push({ path: relPath, info: in2 });
    } else if (in1 && !in2) {
      removed.push({ path: relPath, info: in1 });
    } else if (in1 && in2) {
      if (in1.hash !== in2.hash) {
        modified.push({ path: relPath, old: in1, new: in2 });
      } else {
        unchanged.push({ path: relPath, info: in1 });
      }
    }
  }

  logger.section('差异统计');
  logger.info(`备份 1 文件数: ${Object.keys(files1).length}`);
  logger.info(`备份 2 文件数: ${Object.keys(files2).length}`);
  logger.success(`新增文件: ${added.length}`);
  logger.error(`删除文件: ${removed.length}`);
  logger.warn(`修改文件: ${modified.length}`);
  logger.info(`未变化文件: ${unchanged.length}`);

  let sizeDiff = 0;
  for (const f of added) sizeDiff += f.info.size;
  for (const f of removed) sizeDiff -= f.info.size;
  for (const f of modified) sizeDiff += (f.new.size - f.old.size);

  if (sizeDiff > 0) {
    logger.info(`大小变化: +${formatSize(sizeDiff)}`);
  } else if (sizeDiff < 0) {
    logger.info(`大小变化: -${formatSize(Math.abs(sizeDiff))}`);
  } else {
    logger.info(`大小变化: 0 B`);
  }

  if (added.length > 0) {
    logger.section('新增文件');
    added.forEach((f) => {
      logger.listItem(`${chalk.green('+')} ${f.path} (${formatSize(f.info.size)})`);
    });
  }

  if (removed.length > 0) {
    logger.section('删除文件');
    removed.forEach((f) => {
      logger.listItem(`${chalk.red('-')} ${f.path} (${formatSize(f.info.size)})`);
    });
  }

  if (modified.length > 0) {
    logger.section('修改文件');
    modified.forEach((f) => {
      const sizeChange = f.new.size - f.old.size;
      const sizeStr = sizeChange >= 0 ? `+${formatSize(sizeChange)}` : `-${formatSize(Math.abs(sizeChange))}`;
      logger.listItem(`${chalk.yellow('~')} ${f.path} (${sizeStr})`);
    });
  }

  if (content && modified.length > 0) {
    logger.section('内容差异详情');
    const filesDir1 = path.join(backup1, 'files');
    const filesDir2 = path.join(backup2, 'files');

    for (const f of modified) {
      const file1Path = path.join(filesDir1, f.path);
      const file2Path = path.join(filesDir2, f.path);

      const isText = await isTextFile(file1Path) && await isTextFile(file2Path);

      if (isText) {
        console.log('');
        console.log(chalk.cyan.bold(`  ${f.path}`));
        console.log(chalk.gray('  ' + '─'.repeat(50)));

        const content1 = await fs.readFile(file1Path, 'utf-8');
        const content2 = await fs.readFile(file2Path, 'utf-8');

        const diff = diffLines(content1, content2);

        for (const part of diff) {
          if (part.added) {
            process.stdout.write(chalk.green(part.value.split('\n').map(l => `    + ${l}`).join('\n')));
          } else if (part.removed) {
            process.stdout.write(chalk.red(part.value.split('\n').map(l => `    - ${l}`).join('\n')));
          } else if (verbose) {
            process.stdout.write(chalk.gray(part.value.split('\n').map(l => `      ${l}`).join('\n')));
          }
        }
      } else {
        logger.listItem(`${f.path} - 二进制文件，跳过内容对比`);
      }
    }
  }

  const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0;

  if (hasChanges) {
    logger.warn('两个备份存在差异');
  } else {
    logger.success('两个备份完全一致');
  }

  const reportData = {
    generatedAt: new Date().toISOString(),
    backup1: { path: backup1, fileCount: Object.keys(files1).length, manifest: manifest1 },
    backup2: { path: backup2, fileCount: Object.keys(files2).length, manifest: manifest2 },
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      unchanged: unchanged.length
    },
    added,
    removed,
    modified,
    unchanged
  };

  if (exportPath) {
    await exportReport(reportData, exportPath);
  }

  return { added, removed, modified, unchanged, hasChanges };
}

async function isTextFile(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    let nullBytes = 0;
    for (let i = 0; i < Math.min(buf.length, 8192); i++) {
      if (buf[i] === 0) {
        nullBytes++;
        if (nullBytes > 32) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
