#!/usr/bin/env node

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import logger from '../src/utils/logger.js';
import { initMetrics, emitBackup, emitVerify, emitDiff, emitMultiBackup, shutdownMetrics, getMetrics } from '../src/metrics/index.js';
import { initGitHubActions, emitBackupResult, emitVerifyResult, emitDiffResult, flushSummary, setOutput, group, endGroup, error as ghError, notice } from '../src/ci/github-actions.js';
import { backupCommand } from '../src/commands/backup.js';
import { verifyCommand } from '../src/commands/verify.js';
import { diffCommand } from '../src/commands/diff.js';
import { incrementalVerifyCommand } from '../src/commands/incremental.js';
import { remotePullCommand, remoteManifestCommand } from '../src/commands/remote.js';
import { scheduleStartCommand, scheduleListCommand, scheduleRemoveCommand } from '../src/commands/schedule.js';
import { multiBackupCommand } from '../src/commands/multi-backup.js';
import { chunkedVerifyCommand } from '../src/commands/chunked-verify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

initGitHubActions();

const program = new Command();

program
  .name('backup-verify')
  .description('备份验证 CLI 工具 - 定期抽样备份、检查备份完整性及差异')
  .version(pkg.version)
  .option('--log-level <level>', '日志级别: debug, info, warn, error, silent', 'info')
  .option('--log-json', '启用 JSON 结构化日志输出')
  .option('--log-file <path>', '日志输出到文件')
  .option('--metrics', '启用 Prometheus metrics 端点')
  .option('--metrics-port <port>', 'Prometheus metrics 端口', (v) => Number(v) || 9090, 9090)
  .option('--otel', '启用 OpenTelemetry metrics 上报')
  .option('--otel-endpoint <url>', 'OpenTelemetry OTLP 端点', 'http://localhost:4318/v1/metrics')
  .hook('preAction', (thisCommand) => {
    const globalOpts = thisCommand.opts();
    if (globalOpts.logLevel || globalOpts.logJson || globalOpts.logFile) {
      logger.configure({
        level: globalOpts.logLevel,
        json: globalOpts.logJson || false,
        logFile: globalOpts.logFile
      });
    }

    if (globalOpts.metrics || globalOpts.otel) {
      initMetrics({
        prometheus: globalOpts.metrics || false,
        port: globalOpts.metricsPort,
        otel: globalOpts.otel || false,
        otelEndpoint: globalOpts.otelEndpoint
      });
    }
  });

program.hook('postAction', async () => {
  flushSummary();
  await shutdownMetrics();
});

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
    const start = Date.now();
    try {
      const result = await backupCommand(source, options);
      const duration = (Date.now() - start) / 1000;
      const fileCount = result.sampledFiles?.length || 0;
      const totalSize = result.manifest?.totalSize || 0;
      emitBackup(fileCount, totalSize, duration);
      emitBackupResult({ backupDir: result.backupDir, fileCount, totalSize });
    } catch (err) {
      ghError(`备份失败: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('verify <backup-dir>')
  .description('检查备份的完整性')
  .option('-v, --verbose', '显示详细信息')
  .option('-f, --full', '完整检查（包括多余文件检测）')
  .action(async (backupDir, options) => {
    const start = Date.now();
    try {
      const result = await verifyCommand(backupDir, options);
      const duration = (Date.now() - start) / 1000;
      emitVerify(
        result.results.passed.length,
        result.results.failed.length,
        result.results.missing.length,
        duration
      );
      emitVerifyResult(result);
      process.exit(result.isOk ? 0 : 1);
    } catch (err) {
      ghError(`验证失败: ${err.message}`);
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
    const start = Date.now();
    try {
      const result = await diffCommand(backup1, backup2, options);
      const duration = (Date.now() - start) / 1000;
      emitDiff(
        result.added.length,
        result.removed.length,
        result.modified.length,
        result.unchanged.length,
        duration
      );
      emitDiffResult(result);
    } catch (err) {
      ghError(`对比失败: ${err.message}`);
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
      ghError(`增量校验失败: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('chunked-verify <backup-dir>')
  .description('大文件分块校验（支持断点续传）')
  .option('--chunk-size <bytes>', '分块大小（字节），默认 4194304 (4MB)', (v) => Number(v) || 4 * 1024 * 1024, 4 * 1024 * 1024)
  .option('--no-resume', '禁用断点续传')
  .option('-v, --verbose', '显示详细信息')
  .action(async (backupDir, options) => {
    try {
      await chunkedVerifyCommand(backupDir, options);
    } catch (err) {
      ghError(`分块校验失败: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('multi-backup <sources...>')
  .description('多源并发备份（支持限流和失败重试）')
  .requiredOption('-o, --output <dir>', '备份输出目录')
  .option('-r, --sample-rate <rate>', '抽样比例 (0-1)', parseFloat, 0.1)
  .option('-e, --exclude <patterns>', '排除目录/文件，逗号分隔', (val) => val.split(','))
  .option('--extensions <exts>', '指定文件扩展名，逗号分隔')
  .option('-c, --concurrency <n>', '并发数', (v) => Number(v) || 2, 2)
  .option('--rate-limit <n>', '每秒最大操作数 (0=不限)', (v) => Number(v) || 0, 0)
  .option('--retries <n>', '失败重试次数', (v) => Number(v) || 2, 2)
  .option('--no-resume', '禁用断点续传复制')
  .option('-v, --verbose', '显示详细信息')
  .action(async (sources, options) => {
    try {
      const { allOk, succeeded, failed } = await multiBackupCommand(sources, options);
      emitMultiBackup(succeeded.length, failed.length);
      setOutput('multi_backup_success', String(succeeded.length));
      setOutput('multi_backup_failed', String(failed.length));
      process.exit(allOk ? 0 : 1);
    } catch (err) {
      ghError(`多源备份失败: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('metrics')
  .description('输出 Prometheus 格式的 metrics（不启动 HTTP 服务）')
  .action(async () => {
    const content = await getMetrics();
    console.log(content);
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
      ghError(`拉取失败: ${err.message}`);
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
      ghError(`读取清单失败: ${err.message}`);
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
      ghError(`调度启动失败: ${err.message}`);
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
      ghError(`列表获取失败: ${err.message}`);
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
      ghError(`删除失败: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
