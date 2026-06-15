#!/usr/bin/env node

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { backupCommand } from '../src/commands/backup.js';
import { verifyCommand } from '../src/commands/verify.js';
import { diffCommand } from '../src/commands/diff.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

const program = new Command();

program
  .name('backup-verify')
  .description('备份验证 CLI 工具 - 定期抽样备份、检查备份完整性及差异')
  .version(pkg.version);

program
  .command('backup <source>')
  .description('抽样备份指定目录的文件')
  .requiredOption('-o, --output <dir>', '备份输出目录')
  .option('-r, --sample-rate <rate>', '抽样比例 (0-1)', parseFloat, 0.1)
  .option('-e, --exclude <patterns>', '排除目录/文件，逗号分隔', (val) => val.split(','))
  .option('--extensions <exts>', '指定文件扩展名，逗号分隔')
  .option('-n, --name <name>', '备份名称，默认自动生成')
  .option('-v, --verbose', '显示详细信息')
  .action(async (source, options) => {
    try {
      await backupCommand(source, options);
    } catch (err) {
      console.error('备份失败:', err.message);
      process.exit(1);
    }
  });

program
  .command('verify <backup-dir>')
  .description('检查备份的完整性')
  .option('-v, --verbose', '显示详细信息')
  .option('-f, --full', '完整检查（包括多余文件检测）')
  .action(async (backupDir, options) => {
    try {
      const { isOk } = await verifyCommand(backupDir, options);
      process.exit(isOk ? 0 : 1);
    } catch (err) {
      console.error('验证失败:', err.message);
      process.exit(1);
    }
  });

program
  .command('diff <backup1> <backup2>')
  .description('对比两个备份之间的差异')
  .option('-v, --verbose', '显示详细信息')
  .option('-c, --content', '显示文件内容差异（仅文本文件）')
  .action(async (backup1, backup2, options) => {
    try {
      await diffCommand(backup1, backup2, options);
    } catch (err) {
      console.error('对比失败:', err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
