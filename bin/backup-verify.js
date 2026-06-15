#!/usr/bin/env node

import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import logger from '../src/utils/logger.js';
import { initMetrics, emitBackup, emitVerify, emitDiff, emitMultiBackup, shutdownMetrics, getMetrics } from '../src/metrics/index.js';
import { initGitHubActions, emitBackupResult, emitVerifyResult, emitDiffResult, flushSummary, setOutput, group, endGroup, error as ghError, notice, addSummaryTable, addSummaryHeading } from '../src/ci/github-actions.js';
import { backupCommand } from '../src/commands/backup.js';
import { verifyCommand } from '../src/commands/verify.js';
import { diffCommand } from '../src/commands/diff.js';
import { incrementalVerifyCommand } from '../src/commands/incremental.js';
import { remotePullCommand, remoteManifestCommand } from '../src/commands/remote.js';
import { scheduleStartCommand, scheduleListCommand, scheduleRemoveCommand } from '../src/commands/schedule.js';
import { multiBackupCommand } from '../src/commands/multi-backup.js';
import { chunkedVerifyCommand } from '../src/commands/chunked-verify.js';
import { getSLIEngine, resetSLIEngine } from '../src/release/slo.js';
import { getChannelFromVersion, isValidChannel, VALID_CHANNELS } from '../src/release/channel.js';
import { generateBuildAttestation, writeCIAttestationFiles, verifyArtifactAttestation, getBuildEnvironment } from '../src/release/attestation.js';
import { signArtifact, writeAttestation, sha256File, verifyAttestationSignature } from '../src/release/sigstore.js';

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

program
  .command('version')
  .description('显示版本信息和发布 channel')
  .option('--json', '以 JSON 格式输出')
  .option('--channel', '仅显示 channel')
  .action((options) => {
    const channel = getChannelFromVersion(pkg.version);
    if (options.channel) {
      console.log(channel);
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({
        version: pkg.version,
        name: pkg.name,
        channel,
        supportedChannels: VALID_CHANNELS,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        ci: getBuildEnvironment()
      }, null, 2));
      return;
    }
    console.log(`${pkg.name} v${pkg.version} (${channel})`);
    console.log(`Node.js ${process.version} on ${process.platform}-${process.arch}`);
    console.log(`Supported channels: ${VALID_CHANNELS.join(', ')}`);
  });

const releaseCmd = program.command('release').description('发布相关子命令');

releaseCmd
  .command('channel')
  .description('管理发布 channel')
  .option('--set <name>', '设置输出目录的 channel (stable/beta/nightly)')
  .option('--dir <path>', '构建输出目录', 'dist')
  .option('--list', '列出所有支持的 channel')
  .action(async (options) => {
    if (options.list) {
      for (const ch of VALID_CHANNELS) {
        console.log(`- ${ch}`);
      }
      return;
    }
    if (options.set) {
      if (!isValidChannel(options.set)) {
        ghError(`无效 channel: ${options.set}`);
        process.exit(1);
      }
      const manifestPath = join(options.dir, 'build-manifest.json');
      if (!await import('fs').then(m => m.promises.access(manifestPath).then(() => true).catch(() => false))) {
        ghError(`未找到 manifest: ${manifestPath}`);
        process.exit(1);
      }
      const { readJson, writeJson } = await import('fs-extra');
      const manifest = await readJson(manifestPath);
      manifest.channel = options.set;
      await writeJson(manifestPath, manifest, { spaces: 2 });
      console.log(`Channel 设置为: ${options.set}`);
      setOutput('release_channel', options.set);
      return;
    }
    const current = getChannelFromVersion(pkg.version);
    console.log(`Current channel: ${current}`);
    setOutput('release_channel', current);
  });

releaseCmd
  .command('slo')
  .description('查看和评估 SLO 状态')
  .option('--json', '以 JSON 输出')
  .option('--manifest <path>', 'build manifest 路径', 'dist/build-manifest.json')
  .option('--backup <total,failed,duration>', '记录一次备份结果 (如 "10,1,30")')
  .option('--verify <total,failed,missing,duration>', '记录一次校验结果')
  .action(async (options) => {
    const slo = getSLIEngine();

    if (options.backup) {
      const [total, failed, duration] = options.backup.split(',').map(Number);
      const r = slo.recordBackupResult(total, failed, duration);
      console.log(`记录备份: successRate=${r.successRate.toFixed(1)}% (${r.passed}/${r.total})`);
    }
    if (options.verify) {
      const [total, failed, missing, duration] = options.verify.split(',').map(Number);
      const r = slo.recordVerifyResult(total, failed, missing, duration);
      console.log(`记录校验: successRate=${r.successRate.toFixed(1)}% integrity=${r.integrityRate.toFixed(3)}%`);
    }

    const report = slo.getReport();

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('=== SLO 报告 ===');
      console.log(`状态: ${report.sloStatus.healthy ? '✓ 达标' : '✗ 不达标'}`);
      console.log(`严重告警: ${report.sloStatus.criticalCount}`);
      console.log(`警告告警: ${report.sloStatus.warningCount}`);
      for (const [name, sli] of Object.entries(report.slis)) {
        console.log(`  ${name}: avg=${sli.average} (n=${sli.samples})`);
      }
      for (const a of report.alerts.critical) {
        console.log(`  CRITICAL: ${a.metric} ${a.actual} < target ${a.target}`);
      }
      for (const a of report.alerts.warning) {
        console.log(`  WARNING: ${a.metric} ${a.actual} breached warning threshold`);
      }
      addSummaryHeading('SLO 报告');
      addSummaryTable(
        ['指标', '状态', '实际值', '目标'],
        [
          ['总体', report.sloStatus.healthy ? 'PASS' : 'FAIL', '-', '-'],
          ['严重告警', report.sloStatus.criticalCount, '-', '0'],
          ['警告告警', report.sloStatus.warningCount, '-', '0']
        ]
      );
    }
    setOutput('slo_healthy', String(report.sloStatus.healthy));
    setOutput('slo_critical_alerts', String(report.sloStatus.criticalCount));
    setOutput('slo_warning_alerts', String(report.sloStatus.warningCount));
    process.exit(report.sloStatus.healthy ? 0 : 2);
  });

const attestCmd = program.command('attest').description('Attestation 子命令');

attestCmd
  .command('sign <artifact>')
  .description('为 artifact 生成 Sigstore 风格的签名与 provenance')
  .requiredOption('-o, --output <dir>', '输出目录')
  .option('--name <name>', 'artifact 显示名')
  .option('--repo <url>', '仓库 URL')
  .option('--sha <hash>', '提交 SHA')
  .action(async (artifact, options) => {
    try {
      const attestation = await signArtifact(artifact, {
        name: options.name,
        invocation: { externalParameters: { repo: options.repo, sha: options.sha } }
      });
      const paths = await writeAttestation(artifact, attestation, options.output);
      console.log(`SHA256: ${attestation.hash.value}`);
      console.log(`Attestation: ${paths.attestationPath}`);
      console.log(`Provenance: ${paths.provenancePath}`);
      setOutput('artifact_sha256', attestation.hash.value);
      setOutput('attestation_path', paths.attestationPath);
    } catch (err) {
      ghError(`签名失败: ${err.message}`);
      process.exit(1);
    }
  });

attestCmd
  .command('generate <artifact>')
  .description('为构建产出物生成 CI build provenance attestation')
  .requiredOption('-o, --output <dir>', '输出目录')
  .option('--platform <id>', '平台标识 (如 linux-x64)')
  .action(async (artifact, options) => {
    try {
      const att = await generateBuildAttestation(artifact, {
        platform: options.platform
      });
      const paths = await writeCIAttestationFiles(artifact, att, options.output);
      console.log(`Bundle: ${paths.bundlePath}`);
      console.log(`Statement: ${paths.statementPath}`);
      console.log(`Provenance: ${paths.provenancePath}`);
      setOutput('attestation_bundle', paths.bundlePath);
      setOutput('artifact_sha256', att.artifact.sha256);
    } catch (err) {
      ghError(`生成 attestation 失败: ${err.message}`);
      process.exit(1);
    }
  });

attestCmd
  .command('verify <artifact>')
  .description('校验 artifact 的签名或 attestation')
  .requiredOption('--bundle <path>', 'attestation bundle 路径')
  .action(async (artifact, options) => {
    try {
      const result = await verifyArtifactAttestation(artifact, options.bundle);
      if (result.valid) {
        console.log('✓ Attestation 有效');
        if (result.subject) {
          console.log(`  Subject: ${JSON.stringify(result.subject)}`);
        }
        notice('attestation 验证通过');
        setOutput('attestation_valid', 'true');
        process.exit(0);
      } else {
        console.log('✗ Attestation 无效:', result.error);
        ghError(`attestation 验证失败: ${result.error}`);
        setOutput('attestation_valid', 'false');
        process.exit(1);
      }
    } catch (err) {
      ghError(`校验失败: ${err.message}`);
      process.exit(1);
    }
  });

attestCmd
  .command('env')
  .description('输出当前 CI 构建环境')
  .option('--json', 'JSON 格式')
  .action((options) => {
    const env = getBuildEnvironment();
    console.log(options.json ? JSON.stringify(env, null, 2) : `CI: ${env.ci}`);
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
