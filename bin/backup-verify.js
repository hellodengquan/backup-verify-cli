#!/usr/bin/env node

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { backupCommand } from '../src/commands/backup.js';
import { verifyCommand } from '../src/commands/verify.js';
import { diffCommand } from '../src/commands/diff.js';
import { incrementalVerifyCommand } from '../src/commands/incremental.js';
import { remotePullCommand, remoteManifestCommand } from '../src/commands/remote.js';
import { scheduleStartCommand, scheduleListCommand, scheduleRemoveCommand } from '../src/commands/schedule.js';

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
  .option('--export <path>', '导出差异报告（支持 .json 和 .csv 格式）')
  .action(async (backup1, backup2, options) => {
    try {
      await diffCommand(backup1, backup2, options);
    } catch (err) {
      console.error('对比失败:', err.message);
      process.exit(1);
    }
  });

program
  .command('incremental <backup-dir>')
  .description('增量哈希校验（仅校验变更文件）')
  .option('-v, --verbose', '显示详细信息')
  .option('-f, --full', '完整检查（包括多余文件检测）')
  .action(async (backupDir, options) => {
    try {
      const { isOk } = await incrementalVerifyCommand(backupDir, options);
      process.exit(isOk ? 0 : 1);
    } catch (err) {
      console.error('增量校验失败:', err.message);
      process.exit(1);
    }
  });

const remoteCmd = program.command('remote').description('远端备份操作');

remoteCmd
  .command('pull')
  .description('从远端拉取备份到本地')
  .requiredOption('-t, --type <type>', '远端类型: s3 或 sftp')
  .requiredOption('-o, --output <dir>', '本地输出目录')
  .requiredOption('-n, --name <name>', '远端备份名称')
  .option('-c, --config <path>', '配置文件路径')
  .option('-v, --verbose', '显示详细信息')
  .action(async (options) => {
    try {
      await remotePullCommand(options);
    } catch (err) {
      console.error('拉取失败:', err.message);
      process.exit(1);
    }
  });

remoteCmd
  .command('manifest')
  .description('读取远端备份清单')
  .requiredOption('-t, --type <type>', '远端类型: s3 或 sftp')
  .requiredOption('-n, --name <name>', '远端备份名称')
  .option('-c, --config <path>', '配置文件路径')
  .action(async (options) => {
    try {
      await remoteManifestCommand(options);
    } catch (err) {
      console.error('读取清单失败:', err.message);
      process.exit(1);
    }
  });

const scheduleCmd = program.command('schedule').description('定时任务调度');

scheduleCmd
  .command('start')
  .description('启动定时任务')
  .requiredOption('-a, --action <action>', '执行动作: backup / verify / incremental')
  .requiredOption('--cron <expr>', 'Cron 表达式 (如 "0 2 * * *" 表示每天凌晨2点)')
  .option('-s, --source <path>', '源目录（backup 动作必填）')
  .option('-o, --output <dir>', '输出目录（backup 动作必填）')
  .option('-r, --sample-rate <rate>', '抽样比例', parseFloat, 0.1)
  .option('-e, --exclude <patterns>', '排除目录/文件，逗号分隔')
  .option('-n, --name <name>', '备份名称前缀')
  .option('-v, --verbose', '显示详细信息')
  .option('--once', '立即执行一次后退出')
  .action(async (options) => {
    try {
      await scheduleStartCommand(options);
    } catch (err) {
      console.error('调度启动失败:', err.message);
      process.exit(1);
    }
  });

scheduleCmd
  .command('list')
  .description('列出所有定时任务')
  .action(async () => {
    try {
      await scheduleListCommand();
    } catch (err) {
      console.error('列表获取失败:', err.message);
      process.exit(1);
    }
  });

scheduleCmd
  .command('remove <schedule-id>')
  .description('删除指定定时任务')
  .action(async (scheduleId) => {
    try {
      await scheduleRemoveCommand(scheduleId);
    } catch (err) {
      console.error('删除失败:', err.message);
      process.exit(1);
    }
  });

program.parse(process.argv);
