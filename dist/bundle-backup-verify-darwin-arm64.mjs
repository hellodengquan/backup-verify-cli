#!/usr/bin/env node

// bin/backup-verify.js
import { Command } from "commander";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// src/utils/logger.js
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
var LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
var StructuredLogger = class {
  constructor() {
    this._minLevel = "info";
    this._jsonMode = false;
    this._logFile = null;
    this._logStream = null;
    this._correlationId = null;
  }
  configure(options = {}) {
    if (options.level) this._minLevel = options.level;
    if (options.json) this._jsonMode = options.json;
    if (options.logFile) {
      this._logFile = options.logFile;
      fs.ensureDirSync(path.dirname(this._logFile));
      this._logStream = fs.createWriteStream(this._logFile, { flags: "a" });
    }
  }
  setCorrelationId(id) {
    this._correlationId = id;
  }
  _emit(level, message, extra = {}) {
    if (LEVELS[level] < LEVELS[this._minLevel]) return;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      message,
      ...extra
    };
    if (this._correlationId) entry.correlationId = this._correlationId;
    if (this._logStream) {
      this._logStream.write(JSON.stringify(entry) + "\n");
    }
    if (this._jsonMode) {
      const out = level === "error" ? process.stderr : process.stdout;
      out.write(JSON.stringify(entry) + "\n");
      return;
    }
    this._prettyPrint(level, message, extra);
  }
  _prettyPrint(level, message, extra) {
    const tag = {
      info: chalk.blue("[INFO]"),
      success: chalk.green("[SUCCESS]"),
      warn: chalk.yellow("[WARN]"),
      error: chalk.red("[ERROR]"),
      debug: chalk.gray("[DEBUG]")
    }[level] || `[${level.toUpperCase()}]`;
    const out = level === "error" ? console.error : console.log;
    out(tag, message);
    if (extra.data && Object.keys(extra.data).length > 0) {
      out(chalk.gray("  \u2514"), JSON.stringify(extra.data));
    }
  }
  info(msg, data) {
    this._emit("info", msg, { data: data || {} });
  }
  success(msg, data) {
    this._emit("info", msg, { data: data || {} });
  }
  warn(msg, data) {
    this._emit("warn", msg, { data: data || {} });
  }
  error(msg, data) {
    this._emit("error", msg, { data: data || {} });
  }
  debug(msg, data) {
    this._emit("debug", msg, { data: data || {} });
  }
  section(title) {
    if (this._jsonMode) {
      this._emit("info", `=== ${title} ===`);
      return;
    }
    console.log("");
    console.log(chalk.cyan.bold(`=== ${title} ===`));
  }
  listItem(msg) {
    if (this._jsonMode) {
      this._emit("info", msg);
      return;
    }
    console.log(chalk.gray("  \u2022"), msg);
  }
  flush() {
    return new Promise((resolve) => {
      if (this._logStream) {
        this._logStream.end(resolve);
        this._logStream = null;
      } else {
        resolve();
      }
    });
  }
};
var logger = new StructuredLogger();
var logger_default = logger;

// src/metrics/index.js
import http from "http";

// src/metrics/prometheus.js
import client from "prom-client";
var register = new client.Registry();
register.setDefaultLabels({ app: "backup-verify" });
var metrics = {
  backupFilesTotal: new client.Counter({
    name: "backup_verify_backup_files_total",
    help: "Total number of files backed up",
    registers: [register]
  }),
  backupBytesTotal: new client.Counter({
    name: "backup_verify_backup_bytes_total",
    help: "Total bytes backed up",
    registers: [register]
  }),
  backupDurationSeconds: new client.Histogram({
    name: "backup_verify_backup_duration_seconds",
    help: "Backup operation duration in seconds",
    buckets: [1, 5, 10, 30, 60, 120, 300, 600],
    registers: [register]
  }),
  verifyFilesTotal: new client.Counter({
    name: "backup_verify_verify_files_total",
    help: "Total files verified",
    labelNames: ["result"],
    registers: [register]
  }),
  verifyDurationSeconds: new client.Histogram({
    name: "backup_verify_verify_duration_seconds",
    help: "Verify operation duration in seconds",
    buckets: [0.5, 1, 5, 10, 30, 60, 120],
    registers: [register]
  }),
  diffFilesTotal: new client.Counter({
    name: "backup_verify_diff_files_total",
    help: "Total files in diff result",
    labelNames: ["change_type"],
    registers: [register]
  }),
  diffDurationSeconds: new client.Histogram({
    name: "backup_verify_diff_duration_seconds",
    help: "Diff operation duration in seconds",
    buckets: [0.5, 1, 5, 10, 30],
    registers: [register]
  }),
  multiBackupSourcesTotal: new client.Counter({
    name: "backup_verify_multi_backup_sources_total",
    help: "Total source directories processed",
    labelNames: ["status"],
    registers: [register]
  }),
  retryAttemptsTotal: new client.Counter({
    name: "backup_verify_retry_attempts_total",
    help: "Total retry attempts",
    labelNames: ["operation"],
    registers: [register]
  }),
  chunkedVerifyChunksTotal: new client.Counter({
    name: "backup_verify_chunked_chunks_total",
    help: "Total chunks verified",
    labelNames: ["result"],
    registers: [register]
  }),
  incrementalSkippedTotal: new client.Counter({
    name: "backup_verify_incremental_skipped_total",
    help: "Total files skipped in incremental verify",
    registers: [register]
  })
};
function recordBackup(fileCount, bytes, durationSec) {
  metrics.backupFilesTotal.inc(fileCount);
  metrics.backupBytesTotal.inc(bytes);
  metrics.backupDurationSeconds.observe(durationSec);
}
function recordVerify(passed, failed, missing, durationSec) {
  metrics.verifyFilesTotal.inc({ result: "passed" }, passed);
  metrics.verifyFilesTotal.inc({ result: "failed" }, failed);
  metrics.verifyFilesTotal.inc({ result: "missing" }, missing);
  metrics.verifyDurationSeconds.observe(durationSec);
}
function recordDiff(added, removed, modified, unchanged, durationSec) {
  metrics.diffFilesTotal.inc({ change_type: "added" }, added);
  metrics.diffFilesTotal.inc({ change_type: "removed" }, removed);
  metrics.diffFilesTotal.inc({ change_type: "modified" }, modified);
  metrics.diffFilesTotal.inc({ change_type: "unchanged" }, unchanged);
  metrics.diffDurationSeconds.observe(durationSec);
}
function recordMultiBackup(successCount, failedCount) {
  metrics.multiBackupSourcesTotal.inc({ status: "success" }, successCount);
  metrics.multiBackupSourcesTotal.inc({ status: "failed" }, failedCount);
}
async function getMetrics() {
  return register.metrics();
}
function getContentType() {
  return register.contentType;
}

// src/metrics/otel.js
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
var meter = null;
var meterProvider = null;
var counters = {};
function initOtelMetrics(options = {}) {
  const {
    endpoint = "http://localhost:4318/v1/metrics",
    exportInterval = 1e4,
    serviceName = "backup-verify"
  } = options;
  const exporter = new OTLPMetricExporter({ url: endpoint });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: exportInterval
  });
  meterProvider = new MeterProvider({
    readers: [reader]
  });
  meter = meterProvider.getMeter(serviceName);
  counters.backupFilesTotal = meter.createCounter("backup_verify_backup_files_total", { description: "Total files backed up" });
  counters.backupBytesTotal = meter.createCounter("backup_verify_backup_bytes_total", { description: "Total bytes backed up" });
  counters.verifyFilesPassed = meter.createCounter("backup_verify_verify_files_passed", { description: "Files that passed verification" });
  counters.verifyFilesFailed = meter.createCounter("backup_verify_verify_files_failed", { description: "Files that failed verification" });
  counters.diffFilesTotal = meter.createCounter("backup_verify_diff_files_total", { description: "Total files in diff by type" });
  counters.multiBackupSourcesTotal = meter.createCounter("backup_verify_multi_backup_sources_total", { description: "Total sources processed" });
  counters.retryAttemptsTotal = meter.createCounter("backup_verify_retry_attempts_total", { description: "Retry attempts" });
  counters.backupDuration = meter.createHistogram("backup_verify_backup_duration_seconds", { description: "Backup duration" });
  counters.verifyDuration = meter.createHistogram("backup_verify_verify_duration_seconds", { description: "Verify duration" });
  return meterProvider;
}
function otelRecordBackup(fileCount, bytes, durationSec) {
  if (!meter) return;
  counters.backupFilesTotal.add(fileCount);
  counters.backupBytesTotal.add(bytes);
  counters.backupDuration.record(durationSec);
}
function otelRecordVerify(passed, failed, durationSec) {
  if (!meter) return;
  counters.verifyFilesPassed.add(passed);
  counters.verifyFilesFailed.add(failed);
  counters.verifyDuration.record(durationSec);
}
function otelRecordDiff(added, removed, modified, unchanged) {
  if (!meter) return;
  counters.diffFilesTotal.add(added, { change_type: "added" });
  counters.diffFilesTotal.add(removed, { change_type: "removed" });
  counters.diffFilesTotal.add(modified, { change_type: "modified" });
  counters.diffFilesTotal.add(unchanged, { change_type: "unchanged" });
}
function otelRecordMultiBackup(successCount, failedCount) {
  if (!meter) return;
  counters.multiBackupSourcesTotal.add(successCount, { status: "success" });
  counters.multiBackupSourcesTotal.add(failedCount, { status: "failed" });
}
async function shutdownOtelMetrics() {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
    meter = null;
  }
}

// src/metrics/index.js
var metricsServer = null;
function initMetrics(options = {}) {
  const { prometheus = false, port = 9090, otel = false, otelEndpoint = "http://localhost:4318/v1/metrics" } = options;
  if (prometheus) {
    startMetricsServer(port);
  }
  if (otel) {
    initOtelMetrics({ endpoint: otelEndpoint });
    logger_default.info(`OpenTelemetry metrics \u4E0A\u62A5\u5DF2\u542F\u7528: ${otelEndpoint}`);
  }
}
function startMetricsServer(port) {
  metricsServer = http.createServer(async (req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      try {
        const content = await getMetrics();
        res.writeHead(200, { "Content-Type": getContentType() });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  metricsServer.listen(port, () => {
    logger_default.info(`Prometheus metrics \u7AEF\u70B9: http://localhost:${port}/metrics`);
  });
}
function emitBackup(fileCount, bytes, durationSec) {
  recordBackup(fileCount, bytes, durationSec);
  otelRecordBackup(fileCount, bytes, durationSec);
}
function emitVerify(passed, failed, missing, durationSec) {
  recordVerify(passed, failed, missing, durationSec);
  otelRecordVerify(passed, failed + missing, durationSec);
}
function emitDiff(added, removed, modified, unchanged, durationSec) {
  recordDiff(added, removed, modified, unchanged, durationSec);
  otelRecordDiff(added, removed, modified, unchanged);
}
function emitMultiBackup(successCount, failedCount) {
  recordMultiBackup(successCount, failedCount);
  otelRecordMultiBackup(successCount, failedCount);
}
async function shutdownMetrics() {
  if (metricsServer) {
    await new Promise((resolve) => metricsServer.close(resolve));
    metricsServer = null;
    logger_default.info("Prometheus metrics \u670D\u52A1\u5DF2\u5173\u95ED");
  }
  await shutdownOtelMetrics();
}

// src/ci/github-actions.js
import fs2 from "fs-extra";
var _githubOutputFile = null;
var _githubStepSummaryFile = null;
var _enabled = false;
var _summaryContent = [];
function initGitHubActions() {
  const isCI = process.env.GITHUB_ACTIONS === "true";
  if (!isCI) return false;
  _enabled = true;
  _githubOutputFile = process.env.GITHUB_OUTPUT || null;
  _githubStepSummaryFile = process.env.GITHUB_STEP_SUMMARY || null;
  return true;
}
function setOutput(name, value) {
  const line = `${name}=${value}`;
  if (_githubOutputFile) {
    fs2.appendFileSync(_githubOutputFile, line + "\n");
  }
  if (!_enabled) return;
  const encoded = encodeGitHubValue(value);
  process.stdout.write(`::set-output name=${name}::${encoded}
`);
}
function group(title) {
  if (_enabled) process.stdout.write(`::group::${title}
`);
}
function endGroup() {
  if (_enabled) process.stdout.write("::endgroup::\n");
}
function error(message, options = {}) {
  if (_enabled) {
    const props = formatAnnotationProps(options);
    process.stderr.write(`::error${props}::${encodeGitHubValue(message)}
`);
  }
}
function warning(message, options = {}) {
  if (_enabled) {
    const props = formatAnnotationProps(options);
    process.stdout.write(`::warning${props}::${encodeGitHubValue(message)}
`);
  }
}
function notice(message, options = {}) {
  if (_enabled) {
    const props = formatAnnotationProps(options);
    process.stdout.write(`::notice${props}::${encodeGitHubValue(message)}
`);
  }
}
function addSummary(content) {
  _summaryContent.push(content);
  if (_githubStepSummaryFile) {
    fs2.appendFileSync(_githubStepSummaryFile, content + "\n");
  }
}
function addSummaryHeading(text, level = 2) {
  const hashes = "#".repeat(level);
  addSummary(`${hashes} ${text}`);
}
function addSummaryTable(headers, rows) {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const dataLines = rows.map((row) => `| ${row.join(" | ")} |`);
  addSummary([headerLine, separatorLine, ...dataLines].join("\n"));
}
function flushSummary() {
  if (_githubStepSummaryFile && _summaryContent.length > 0) {
    const content = _summaryContent.join("\n") + "\n";
    fs2.appendFileSync(_githubStepSummaryFile, content);
  }
  _summaryContent = [];
}
function emitBackupResult(result) {
  const { backupDir, fileCount, totalSize } = result;
  setOutput("backup_dir", backupDir || "");
  setOutput("backup_file_count", String(fileCount || 0));
  setOutput("backup_total_size", String(totalSize || 0));
  if (_enabled) {
    group("\u5907\u4EFD\u7ED3\u679C");
    notice(`\u5907\u4EFD\u5B8C\u6210: ${fileCount} \u4E2A\u6587\u4EF6, ${formatBytes(totalSize)}`);
    endGroup();
  }
  addSummaryHeading("\u5907\u4EFD\u7ED3\u679C");
  addSummaryTable(
    ["\u6307\u6807", "\u503C"],
    [
      ["\u6587\u4EF6\u6570", String(fileCount || 0)],
      ["\u603B\u5927\u5C0F", formatBytes(totalSize)],
      ["\u5907\u4EFD\u76EE\u5F55", backupDir || "N/A"]
    ]
  );
}
function emitVerifyResult(result) {
  const { results, isOk } = result;
  setOutput("verify_passed", String(results.passed?.length || 0));
  setOutput("verify_failed", String(results.failed?.length || 0));
  setOutput("verify_missing", String(results.missing?.length || 0));
  setOutput("verify_ok", String(isOk));
  if (_enabled) {
    group("\u6821\u9A8C\u7ED3\u679C");
    if (isOk) {
      notice(`\u6821\u9A8C\u901A\u8FC7: ${results.passed?.length || 0} \u4E2A\u6587\u4EF6`);
    } else {
      error(`\u6821\u9A8C\u5931\u8D25: ${results.failed?.length || 0} \u635F\u574F, ${results.missing?.length || 0} \u7F3A\u5931`);
    }
    endGroup();
  }
  addSummaryHeading("\u6821\u9A8C\u7ED3\u679C");
  addSummaryTable(
    ["\u72B6\u6001", "\u6570\u91CF"],
    [
      ["\u901A\u8FC7", String(results.passed?.length || 0)],
      ["\u635F\u574F", String(results.failed?.length || 0)],
      ["\u7F3A\u5931", String(results.missing?.length || 0)]
    ]
  );
}
function emitDiffResult(result) {
  const { added, removed, modified, unchanged, hasChanges } = result;
  setOutput("diff_added", String(added?.length || 0));
  setOutput("diff_removed", String(removed?.length || 0));
  setOutput("diff_modified", String(modified?.length || 0));
  setOutput("diff_has_changes", String(hasChanges));
  if (_enabled) {
    group("\u5DEE\u5F02\u5BF9\u6BD4\u7ED3\u679C");
    if (hasChanges) {
      warning(`\u53D1\u73B0\u5DEE\u5F02: +${added?.length || 0} -${removed?.length || 0} ~${modified?.length || 0}`);
    } else {
      notice("\u4E24\u4E2A\u5907\u4EFD\u5B8C\u5168\u4E00\u81F4");
    }
    endGroup();
  }
  addSummaryHeading("\u5DEE\u5F02\u5BF9\u6BD4");
  addSummaryTable(
    ["\u7C7B\u578B", "\u6570\u91CF"],
    [
      ["\u65B0\u589E", String(added?.length || 0)],
      ["\u5220\u9664", String(removed?.length || 0)],
      ["\u4FEE\u6539", String(modified?.length || 0)],
      ["\u672A\u53D8\u5316", String(unchanged?.length || 0)]
    ]
  );
}
function formatAnnotationProps(options) {
  const parts = [];
  if (options.file) parts.push(`file=${encodeGitHubValue(options.file)}`);
  if (options.line) parts.push(`line=${options.line}`);
  if (options.col) parts.push(`col=${options.col}`);
  return parts.length > 0 ? ` ${parts.join(",")}` : "";
}
function encodeGitHubValue(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// src/commands/backup.js
import fs4 from "fs-extra";
import path3 from "path";

// src/utils/file.js
import fs3 from "fs-extra";
import path2 from "path";

// src/utils/hash.js
import { createHash } from "crypto";
import { createReadStream, readFileSync } from "fs";
function hashFile(filePath, algorithm = "sha256") {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// src/utils/file.js
async function walkDir(dir, options = {}) {
  const { exclude = [], extensions = null, relativeBase = dir } = options;
  const results = [];
  const entries = await fs3.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path2.join(dir, entry.name);
    const relPath = path2.relative(relativeBase, fullPath);
    const shouldExclude = exclude.some((pattern) => {
      if (typeof pattern === "string") {
        return entry.name === pattern || relPath.startsWith(pattern);
      }
      if (pattern instanceof RegExp) {
        return pattern.test(relPath);
      }
      return false;
    });
    if (shouldExclude) continue;
    if (entry.isDirectory()) {
      const subResults = await walkDir(fullPath, { ...options, relativeBase });
      results.push(...subResults);
    } else if (entry.isFile()) {
      if (extensions && extensions.length > 0) {
        const ext = path2.extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) continue;
      }
      results.push({
        path: fullPath,
        relativePath: relPath,
        name: entry.name
      });
    }
  }
  return results;
}
function sampleFiles(files, sampleRate) {
  if (sampleRate >= 1) return [...files];
  const sampleCount = Math.max(1, Math.floor(files.length * sampleRate));
  const shuffled = [...files].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, sampleCount);
}
async function getFileInfo(filePath) {
  const stats = await fs3.stat(filePath);
  return {
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    birthtime: stats.birthtime.toISOString()
  };
}
async function buildManifest(files, baseDir) {
  const manifest = {
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    baseDir,
    files: {}
  };
  for (const file of files) {
    const [hash, info] = await Promise.all([
      hashFile(file.path),
      getFileInfo(file.path)
    ]);
    manifest.files[file.relativePath] = {
      hash,
      size: info.size,
      mtime: info.mtime
    };
  }
  return manifest;
}
function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// src/commands/backup.js
async function backupCommand(source, options) {
  const {
    output,
    sampleRate = 0.1,
    exclude = ["node_modules", ".git", "dist", "build"],
    extensions = null,
    name = null,
    verbose = false
  } = options;
  logger_default.section("\u5907\u4EFD\u4EFB\u52A1\u5F00\u59CB");
  logger_default.info(`\u6E90\u76EE\u5F55: ${source}`);
  logger_default.info(`\u8F93\u51FA\u76EE\u5F55: ${output}`);
  logger_default.info(`\u62BD\u6837\u6BD4\u4F8B: ${(sampleRate * 100).toFixed(1)}%`);
  if (!await fs4.pathExists(source)) {
    logger_default.error(`\u6E90\u76EE\u5F55\u4E0D\u5B58\u5728: ${source}`);
    process.exit(1);
  }
  const sourceStat = await fs4.stat(source);
  if (!sourceStat.isDirectory()) {
    logger_default.error(`\u6E90\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55: ${source}`);
    process.exit(1);
  }
  logger_default.info("\u6B63\u5728\u626B\u63CF\u6587\u4EF6...");
  const allFiles = await walkDir(source, {
    exclude,
    extensions: extensions ? extensions.split(",").map((e) => e.trim().toLowerCase()) : null
  });
  logger_default.info(`\u53D1\u73B0\u6587\u4EF6\u603B\u6570: ${allFiles.length}`);
  if (allFiles.length === 0) {
    logger_default.warn("\u6CA1\u6709\u627E\u5230\u4EFB\u4F55\u6587\u4EF6\uFF0C\u5907\u4EFD\u53D6\u6D88");
    process.exit(0);
  }
  logger_default.info("\u6B63\u5728\u968F\u673A\u62BD\u6837...");
  const sampledFiles = sampleFiles(allFiles, sampleRate);
  logger_default.info(`\u62BD\u6837\u6587\u4EF6\u6570: ${sampledFiles.length}`);
  if (verbose) {
    logger_default.section("\u62BD\u6837\u6587\u4EF6\u5217\u8868");
    sampledFiles.forEach((f) => logger_default.listItem(f.relativePath));
  }
  const backupName = name || `backup-${Date.now()}`;
  const backupDir = path3.join(output, backupName);
  const filesDir = path3.join(backupDir, "files");
  logger_default.info(`\u5907\u4EFD\u76EE\u5F55: ${backupDir}`);
  logger_default.info("\u6B63\u5728\u590D\u5236\u6587\u4EF6...");
  let totalSize = 0;
  let copiedCount = 0;
  for (const file of sampledFiles) {
    const destPath = path3.join(filesDir, file.relativePath);
    await fs4.ensureDir(path3.dirname(destPath));
    await fs4.copy(file.path, destPath);
    const stats = await fs4.stat(file.path);
    totalSize += stats.size;
    copiedCount++;
    if (verbose) {
      logger_default.debug(`\u5DF2\u590D\u5236: ${file.relativePath} (${formatSize(stats.size)})`, true);
    }
  }
  logger_default.info("\u6B63\u5728\u751F\u6210\u6587\u4EF6\u6E05\u5355...");
  const manifest = await buildManifest(sampledFiles, source);
  manifest.backupName = backupName;
  manifest.sampleRate = sampleRate;
  manifest.totalFilesSampled = sampledFiles.length;
  manifest.totalFilesSource = allFiles.length;
  manifest.totalSize = totalSize;
  const manifestPath = path3.join(backupDir, "manifest.json");
  await fs4.writeJson(manifestPath, manifest, { spaces: 2 });
  logger_default.section("\u5907\u4EFD\u5B8C\u6210");
  logger_default.success(`\u5907\u4EFD\u540D\u79F0: ${backupName}`);
  logger_default.success(`\u590D\u5236\u6587\u4EF6\u6570: ${copiedCount}`);
  logger_default.success(`\u603B\u5927\u5C0F: ${formatSize(totalSize)}`);
  logger_default.success(`\u5907\u4EFD\u4F4D\u7F6E: ${backupDir}`);
  logger_default.success(`\u6E05\u5355\u6587\u4EF6: ${manifestPath}`);
  return { backupDir, manifest, sampledFiles };
}

// src/commands/verify.js
import fs5 from "fs-extra";
import path4 from "path";
async function verifyCommand(backupDir, options) {
  const { verbose = false, full = false } = options;
  logger_default.section("\u5B8C\u6574\u6027\u68C0\u67E5\u5F00\u59CB");
  logger_default.info(`\u5907\u4EFD\u76EE\u5F55: ${backupDir}`);
  const manifestPath = path4.join(backupDir, "manifest.json");
  if (!await fs5.pathExists(manifestPath)) {
    logger_default.error(`\u6E05\u5355\u6587\u4EF6\u4E0D\u5B58\u5728: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = await fs5.readJson(manifestPath);
  const filesDir = path4.join(backupDir, "files");
  const files = Object.entries(manifest.files);
  logger_default.info(`\u5907\u4EFD\u540D\u79F0: ${manifest.backupName || "\u672A\u77E5"}`);
  logger_default.info(`\u6E05\u5355\u6587\u4EF6\u6570: ${files.length}`);
  logger_default.info(`\u521B\u5EFA\u65F6\u95F4: ${manifest.createdAt}`);
  const results = {
    passed: [],
    failed: [],
    missing: [],
    extra: []
  };
  logger_default.info("\u6B63\u5728\u6821\u9A8C\u6587\u4EF6\u5B8C\u6574\u6027...");
  for (const [relPath, expected] of files) {
    const filePath = path4.join(filesDir, relPath);
    if (!await fs5.pathExists(filePath)) {
      results.missing.push({ path: relPath, expected });
      if (verbose) logger_default.warn(`\u7F3A\u5931\u6587\u4EF6: ${relPath}`);
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
        if (verbose) logger_default.success(`\u6821\u9A8C\u901A\u8FC7: ${relPath}`);
      } else {
        const issues = [];
        if (!isHashMatch) issues.push("\u54C8\u5E0C\u4E0D\u5339\u914D");
        if (!isSizeMatch) issues.push("\u5927\u5C0F\u4E0D\u5339\u914D");
        results.failed.push({
          path: relPath,
          expected,
          actual: { hash: actualHash, size: actualInfo.size },
          issues
        });
        logger_default.warn(`\u6821\u9A8C\u5931\u8D25: ${relPath} - ${issues.join(", ")}`);
      }
    } catch (err) {
      results.failed.push({
        path: relPath,
        error: err.message
      });
      logger_default.error(`\u8BFB\u53D6\u5931\u8D25: ${relPath} - ${err.message}`);
    }
  }
  if (full) {
    logger_default.info("\u6B63\u5728\u68C0\u67E5\u591A\u4F59\u6587\u4EF6...");
    const allFiles = await walkBackupDir(filesDir);
    const manifestPaths = new Set(files.map(([p]) => p));
    for (const relPath of allFiles) {
      if (!manifestPaths.has(relPath)) {
        results.extra.push(relPath);
        if (verbose) logger_default.warn(`\u591A\u4F59\u6587\u4EF6: ${relPath}`);
      }
    }
  }
  const total = files.length;
  const passedCount = results.passed.length;
  const failedCount = results.failed.length;
  const missingCount = results.missing.length;
  const extraCount = results.extra.length;
  logger_default.section("\u68C0\u67E5\u7ED3\u679C");
  logger_default.info(`\u603B\u8BA1: ${total} \u4E2A\u6587\u4EF6`);
  logger_default.success(`\u901A\u8FC7: ${passedCount} \u4E2A`);
  if (failedCount > 0) logger_default.error(`\u635F\u574F: ${failedCount} \u4E2A`);
  if (missingCount > 0) logger_default.error(`\u7F3A\u5931: ${missingCount} \u4E2A`);
  if (extraCount > 0) logger_default.warn(`\u591A\u4F59: ${extraCount} \u4E2A`);
  const isOk = failedCount === 0 && missingCount === 0;
  if (isOk) {
    logger_default.success("\u2713 \u5907\u4EFD\u5B8C\u6574\u6027\u6821\u9A8C\u901A\u8FC7");
  } else {
    logger_default.error("\u2717 \u5907\u4EFD\u5B8C\u6574\u6027\u6821\u9A8C\u5931\u8D25");
  }
  if (results.failed.length > 0 && verbose) {
    logger_default.section("\u635F\u574F\u6587\u4EF6\u8BE6\u60C5");
    results.failed.forEach((f) => {
      logger_default.listItem(`${f.path}`);
      if (f.expected && f.actual) {
        console.log(`     \u671F\u671B\u54C8\u5E0C: ${f.expected.hash}`);
        console.log(`     \u5B9E\u9645\u54C8\u5E0C: ${f.actual.hash}`);
        console.log(`     \u671F\u671B\u5927\u5C0F: ${formatSize(f.expected.size)}`);
        console.log(`     \u5B9E\u9645\u5927\u5C0F: ${formatSize(f.actual.size)}`);
      }
      if (f.error) {
        console.log(`     \u9519\u8BEF: ${f.error}`);
      }
    });
  }
  if (results.missing.length > 0 && verbose) {
    logger_default.section("\u7F3A\u5931\u6587\u4EF6\u5217\u8868");
    results.missing.forEach((f) => logger_default.listItem(f.path));
  }
  return { results, isOk, manifest };
}
async function walkBackupDir(dir, base = dir) {
  const results = [];
  const entries = await fs5.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path4.join(dir, entry.name);
    const relPath = path4.relative(base, fullPath);
    if (entry.isDirectory()) {
      const sub = await walkBackupDir(fullPath, base);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

// src/commands/diff.js
import fs7 from "fs-extra";
import path6 from "path";
import { diffLines } from "diff";
import chalk2 from "chalk";

// src/utils/export.js
import fs6 from "fs-extra";
import path5 from "path";
async function exportReport(data, outputPath) {
  const ext = path5.extname(outputPath).toLowerCase();
  const dir = path5.dirname(outputPath);
  await fs6.ensureDir(dir);
  if (ext === ".json") {
    await exportJSON(data, outputPath);
  } else if (ext === ".csv") {
    await exportCSV(data, outputPath);
  } else {
    throw new Error(`\u4E0D\u652F\u6301\u7684\u5BFC\u51FA\u683C\u5F0F: ${ext}\uFF0C\u4EC5\u652F\u6301 .json \u548C .csv`);
  }
}
async function exportJSON(data, outputPath) {
  await fs6.writeJson(outputPath, data, { spaces: 2 });
  logger_default.success(`JSON \u62A5\u544A\u5DF2\u5BFC\u51FA: ${outputPath}`);
}
async function exportCSV(data, outputPath) {
  const rows = [];
  rows.push(["type", "path", "oldHash", "newHash", "oldSize", "newSize", "sizeChange"].join(","));
  for (const f of data.added || []) {
    rows.push(["added", csvEscape(f.path), "", csvEscape(f.info?.hash || ""), "", f.info?.size || 0, f.info?.size || 0].join(","));
  }
  for (const f of data.removed || []) {
    rows.push(["removed", csvEscape(f.path), csvEscape(f.info?.hash || ""), "", f.info?.size || 0, "", -(f.info?.size || 0)].join(","));
  }
  for (const f of data.modified || []) {
    const sizeChange = (f.new?.size || 0) - (f.old?.size || 0);
    rows.push(["modified", csvEscape(f.path), csvEscape(f.old?.hash || ""), csvEscape(f.new?.hash || ""), f.old?.size || 0, f.new?.size || 0, sizeChange].join(","));
  }
  for (const f of data.unchanged || []) {
    rows.push(["unchanged", csvEscape(f.path), csvEscape(f.info?.hash || ""), csvEscape(f.info?.hash || ""), f.info?.size || 0, f.info?.size || 0, 0].join(","));
  }
  const content = rows.join("\n") + "\n";
  await fs6.writeFile(outputPath, content, "utf-8");
  logger_default.success(`CSV \u62A5\u544A\u5DF2\u5BFC\u51FA: ${outputPath}`);
}
function csvEscape(str) {
  if (!str) return "";
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// src/commands/diff.js
async function diffCommand(backup1, backup2, options) {
  const { verbose = false, content = false, export: exportPath = null } = options;
  logger_default.section("\u5907\u4EFD\u5DEE\u5F02\u5BF9\u6BD4");
  logger_default.info(`\u5907\u4EFD 1: ${backup1}`);
  logger_default.info(`\u5907\u4EFD 2: ${backup2}`);
  const manifest1Path = path6.join(backup1, "manifest.json");
  const manifest2Path = path6.join(backup2, "manifest.json");
  if (!await fs7.pathExists(manifest1Path)) {
    logger_default.error(`\u5907\u4EFD 1 \u6E05\u5355\u6587\u4EF6\u4E0D\u5B58\u5728: ${manifest1Path}`);
    process.exit(1);
  }
  if (!await fs7.pathExists(manifest2Path)) {
    logger_default.error(`\u5907\u4EFD 2 \u6E05\u5355\u6587\u4EF6\u4E0D\u5B58\u5728: ${manifest2Path}`);
    process.exit(1);
  }
  const manifest1 = await fs7.readJson(manifest1Path);
  const manifest2 = await fs7.readJson(manifest2Path);
  const files1 = manifest1.files;
  const files2 = manifest2.files;
  const allPaths = /* @__PURE__ */ new Set([...Object.keys(files1), ...Object.keys(files2)]);
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
  logger_default.section("\u5DEE\u5F02\u7EDF\u8BA1");
  logger_default.info(`\u5907\u4EFD 1 \u6587\u4EF6\u6570: ${Object.keys(files1).length}`);
  logger_default.info(`\u5907\u4EFD 2 \u6587\u4EF6\u6570: ${Object.keys(files2).length}`);
  logger_default.success(`\u65B0\u589E\u6587\u4EF6: ${added.length}`);
  logger_default.error(`\u5220\u9664\u6587\u4EF6: ${removed.length}`);
  logger_default.warn(`\u4FEE\u6539\u6587\u4EF6: ${modified.length}`);
  logger_default.info(`\u672A\u53D8\u5316\u6587\u4EF6: ${unchanged.length}`);
  let sizeDiff = 0;
  for (const f of added) sizeDiff += f.info.size;
  for (const f of removed) sizeDiff -= f.info.size;
  for (const f of modified) sizeDiff += f.new.size - f.old.size;
  if (sizeDiff > 0) {
    logger_default.info(`\u5927\u5C0F\u53D8\u5316: +${formatSize(sizeDiff)}`);
  } else if (sizeDiff < 0) {
    logger_default.info(`\u5927\u5C0F\u53D8\u5316: -${formatSize(Math.abs(sizeDiff))}`);
  } else {
    logger_default.info(`\u5927\u5C0F\u53D8\u5316: 0 B`);
  }
  if (added.length > 0) {
    logger_default.section("\u65B0\u589E\u6587\u4EF6");
    added.forEach((f) => {
      logger_default.listItem(`${chalk2.green("+")} ${f.path} (${formatSize(f.info.size)})`);
    });
  }
  if (removed.length > 0) {
    logger_default.section("\u5220\u9664\u6587\u4EF6");
    removed.forEach((f) => {
      logger_default.listItem(`${chalk2.red("-")} ${f.path} (${formatSize(f.info.size)})`);
    });
  }
  if (modified.length > 0) {
    logger_default.section("\u4FEE\u6539\u6587\u4EF6");
    modified.forEach((f) => {
      const sizeChange = f.new.size - f.old.size;
      const sizeStr = sizeChange >= 0 ? `+${formatSize(sizeChange)}` : `-${formatSize(Math.abs(sizeChange))}`;
      logger_default.listItem(`${chalk2.yellow("~")} ${f.path} (${sizeStr})`);
    });
  }
  if (content && modified.length > 0) {
    logger_default.section("\u5185\u5BB9\u5DEE\u5F02\u8BE6\u60C5");
    const filesDir1 = path6.join(backup1, "files");
    const filesDir2 = path6.join(backup2, "files");
    for (const f of modified) {
      const file1Path = path6.join(filesDir1, f.path);
      const file2Path = path6.join(filesDir2, f.path);
      const isText = await isTextFile(file1Path) && await isTextFile(file2Path);
      if (isText) {
        console.log("");
        console.log(chalk2.cyan.bold(`  ${f.path}`));
        console.log(chalk2.gray("  " + "\u2500".repeat(50)));
        const content1 = await fs7.readFile(file1Path, "utf-8");
        const content2 = await fs7.readFile(file2Path, "utf-8");
        const diff = diffLines(content1, content2);
        for (const part of diff) {
          if (part.added) {
            process.stdout.write(chalk2.green(part.value.split("\n").map((l) => `    + ${l}`).join("\n")));
          } else if (part.removed) {
            process.stdout.write(chalk2.red(part.value.split("\n").map((l) => `    - ${l}`).join("\n")));
          } else if (verbose) {
            process.stdout.write(chalk2.gray(part.value.split("\n").map((l) => `      ${l}`).join("\n")));
          }
        }
      } else {
        logger_default.listItem(`${f.path} - \u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u8DF3\u8FC7\u5185\u5BB9\u5BF9\u6BD4`);
      }
    }
  }
  const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0;
  if (hasChanges) {
    logger_default.warn("\u4E24\u4E2A\u5907\u4EFD\u5B58\u5728\u5DEE\u5F02");
  } else {
    logger_default.success("\u4E24\u4E2A\u5907\u4EFD\u5B8C\u5168\u4E00\u81F4");
  }
  const reportData = {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
    const buf = await fs7.readFile(filePath);
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

// src/commands/incremental.js
import fs8 from "fs-extra";
import path7 from "path";
var SNAPSHOT_FILE = "verify-snapshot.json";
async function incrementalVerifyCommand(backupDir, options) {
  const { verbose = false, full = false } = options;
  logger_default.section("\u589E\u91CF\u54C8\u5E0C\u6821\u9A8C\u5F00\u59CB");
  logger_default.info(`\u5907\u4EFD\u76EE\u5F55: ${backupDir}`);
  const manifestPath = path7.join(backupDir, "manifest.json");
  if (!await fs8.pathExists(manifestPath)) {
    logger_default.error(`\u6E05\u5355\u6587\u4EF6\u4E0D\u5B58\u5728: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = await fs8.readJson(manifestPath);
  const filesDir = path7.join(backupDir, "files");
  const snapshotPath = path7.join(backupDir, SNAPSHOT_FILE);
  let previousSnapshot = null;
  if (await fs8.pathExists(snapshotPath)) {
    previousSnapshot = await fs8.readJson(snapshotPath);
    logger_default.info(`\u53D1\u73B0\u4E0A\u6B21\u6821\u9A8C\u5FEB\u7167: ${previousSnapshot.verifiedAt}`);
  } else {
    logger_default.info("\u672A\u53D1\u73B0\u4E0A\u6B21\u6821\u9A8C\u5FEB\u7167\uFF0C\u5C06\u6267\u884C\u5168\u91CF\u6821\u9A8C");
  }
  const files = Object.entries(manifest.files);
  logger_default.info(`\u6E05\u5355\u6587\u4EF6\u6570: ${files.length}`);
  const toVerify = [];
  const skipped = [];
  for (const [relPath, expected] of files) {
    const filePath = path7.join(filesDir, relPath);
    if (!await fs8.pathExists(filePath)) {
      toVerify.push({ relPath, expected, filePath, reason: "missing" });
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
    toVerify.push({ relPath, expected, filePath, reason: "changed_or_new" });
  }
  logger_default.info(`\u9700\u8981\u6821\u9A8C: ${toVerify.length} \u4E2A\u6587\u4EF6`);
  logger_default.info(`\u8DF3\u8FC7\uFF08\u672A\u53D8\u66F4\uFF09: ${skipped.length} \u4E2A\u6587\u4EF6`);
  if (verbose && skipped.length > 0) {
    logger_default.section("\u8DF3\u8FC7\u6587\u4EF6");
    skipped.forEach((p) => logger_default.listItem(`${p} (\u672A\u53D8\u66F4)`));
  }
  const results = {
    passed: [],
    failed: [],
    missing: [],
    skipped
  };
  for (const item of toVerify) {
    const { relPath, expected, filePath, reason } = item;
    if (reason === "missing") {
      results.missing.push({ path: relPath, expected });
      if (verbose) logger_default.warn(`\u7F3A\u5931\u6587\u4EF6: ${relPath}`);
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
        if (verbose) logger_default.success(`\u6821\u9A8C\u901A\u8FC7: ${relPath}`);
      } else {
        const issues = [];
        if (!isHashMatch) issues.push("\u54C8\u5E0C\u4E0D\u5339\u914D");
        if (!isSizeMatch) issues.push("\u5927\u5C0F\u4E0D\u5339\u914D");
        results.failed.push({
          path: relPath,
          expected,
          actual: { hash: actualHash, size: actualInfo.size, mtime: actualInfo.mtime },
          issues
        });
        logger_default.warn(`\u6821\u9A8C\u5931\u8D25: ${relPath} - ${issues.join(", ")}`);
      }
    } catch (err) {
      results.failed.push({ path: relPath, error: err.message });
      logger_default.error(`\u8BFB\u53D6\u5931\u8D25: ${relPath} - ${err.message}`);
    }
  }
  if (full) {
    logger_default.info("\u6B63\u5728\u68C0\u67E5\u591A\u4F59\u6587\u4EF6...");
    const allLocalFiles = await walkBackupDir2(filesDir);
    const manifestPaths = new Set(files.map(([p]) => p));
    const extra = [];
    for (const relPath of allLocalFiles) {
      if (!manifestPaths.has(relPath)) {
        extra.push(relPath);
        if (verbose) logger_default.warn(`\u591A\u4F59\u6587\u4EF6: ${relPath}`);
      }
    }
    results.extra = extra;
  }
  const newSnapshot = {
    verifiedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
    const passedEntry = results.passed.find((p) => p.path === relPath);
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
  await fs8.writeJson(snapshotPath, newSnapshot, { spaces: 2 });
  logger_default.info(`\u6821\u9A8C\u5FEB\u7167\u5DF2\u4FDD\u5B58: ${snapshotPath}`);
  const failedCount = results.failed.length;
  const missingCount = results.missing.length;
  const extraCount = results.extra?.length || 0;
  logger_default.section("\u589E\u91CF\u6821\u9A8C\u7ED3\u679C");
  logger_default.info(`\u603B\u8BA1: ${files.length} \u4E2A\u6587\u4EF6`);
  logger_default.info(`\u672C\u6B21\u6821\u9A8C: ${toVerify.length} \u4E2A`);
  logger_default.info(`\u8DF3\u8FC7: ${skipped.length} \u4E2A`);
  logger_default.success(`\u901A\u8FC7: ${results.passed.length} \u4E2A`);
  if (failedCount > 0) logger_default.error(`\u635F\u574F: ${failedCount} \u4E2A`);
  if (missingCount > 0) logger_default.error(`\u7F3A\u5931: ${missingCount} \u4E2A`);
  if (extraCount > 0) logger_default.warn(`\u591A\u4F59: ${extraCount} \u4E2A`);
  const isOk = failedCount === 0 && missingCount === 0;
  if (isOk) {
    logger_default.success("\u2713 \u589E\u91CF\u6821\u9A8C\u901A\u8FC7");
  } else {
    logger_default.error("\u2717 \u589E\u91CF\u6821\u9A8C\u5931\u8D25");
  }
  if (results.failed.length > 0 && verbose) {
    logger_default.section("\u635F\u574F\u6587\u4EF6\u8BE6\u60C5");
    results.failed.forEach((f) => {
      logger_default.listItem(`${f.path}`);
      if (f.expected && f.actual) {
        console.log(`     \u671F\u671B\u54C8\u5E0C: ${f.expected.hash}`);
        console.log(`     \u5B9E\u9645\u54C8\u5E0C: ${f.actual.hash}`);
      }
      if (f.error) {
        console.log(`     \u9519\u8BEF: ${f.error}`);
      }
    });
  }
  return { results, isOk, snapshot: newSnapshot };
}
async function walkBackupDir2(dir, base = dir) {
  const results = [];
  const entries = await fs8.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path7.join(dir, entry.name);
    const relPath = path7.relative(base, fullPath);
    if (entry.name === SNAPSHOT_FILE) continue;
    if (entry.isDirectory()) {
      const sub = await walkBackupDir2(fullPath, base);
      results.push(...sub);
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

// src/commands/remote.js
import fs11 from "fs-extra";

// src/remote/s3.js
import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from "@aws-sdk/client-s3";
import fs9 from "fs-extra";
import path8 from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
var S3Adapter = class {
  constructor(config) {
    this.client = new S3Client({
      region: config.region || "us-east-1",
      credentials: {
        accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
      },
      endpoint: config.endpoint || void 0,
      forcePathStyle: config.forcePathStyle || false
    });
    this.bucket = config.bucket;
    this.prefix = config.prefix || "";
  }
  async listObjects(prefix = "") {
    const fullPrefix = this.prefix ? `${this.prefix}/${prefix}` : prefix;
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: fullPrefix
    });
    const response = await this.client.send(command);
    return (response.Contents || []).map((obj) => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
      etag: obj.ETag
    }));
  }
  async downloadFile(key, localPath) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key
    });
    const response = await this.client.send(command);
    await fs9.ensureDir(path8.dirname(localPath));
    if (response.Body && typeof response.Body === "object" && "pipe" in response.Body) {
      const writeStream = createWriteStream(localPath);
      await pipeline(response.Body, writeStream);
    } else {
      const buffer = await response.Body.transformToByteArray();
      await fs9.writeFile(localPath, Buffer.from(buffer));
    }
    return localPath;
  }
  async downloadManifest(backupName) {
    const manifestKey = this.prefix ? `${this.prefix}/${backupName}/manifest.json` : `${backupName}/manifest.json`;
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: manifestKey
    });
    const response = await this.client.send(command);
    const buffer = await response.Body.transformToByteArray();
    return JSON.parse(Buffer.from(buffer).toString("utf-8"));
  }
  async downloadBackup(backupName, localDir, options = {}) {
    const { onProgress } = options;
    const prefix = this.prefix ? `${this.prefix}/${backupName}/` : `${backupName}/`;
    const objects = await this.listObjects(`${backupName}/`);
    const backupDir = path8.join(localDir, backupName);
    await fs9.ensureDir(backupDir);
    let downloaded = 0;
    for (const obj of objects) {
      const relativePath = obj.key.slice(prefix.length);
      if (!relativePath) continue;
      const localPath = path8.join(backupDir, relativePath);
      await this.downloadFile(obj.key, localPath);
      downloaded++;
      if (onProgress) {
        onProgress(downloaded, objects.length, relativePath);
      }
    }
    logger_default.success(`\u5DF2\u4E0B\u8F7D ${downloaded} \u4E2A\u6587\u4EF6\u5230 ${backupDir}`);
    return backupDir;
  }
  async getFileInfo(key) {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key
    });
    const response = await this.client.send(command);
    return {
      size: response.ContentLength,
      lastModified: response.LastModified,
      etag: response.ETag
    };
  }
};

// src/remote/sftp.js
import { Client } from "ssh2";
import fs10 from "fs-extra";
import path9 from "path";
import { createWriteStream as createWriteStream2 } from "fs";
var SFTPAdapter = class {
  constructor(config) {
    this.config = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password || void 0,
      privateKey: config.privateKey || void 0,
      passphrase: config.passphrase || void 0
    };
    this.remotePath = config.remotePath || "/backup";
    this.conn = null;
    this.sftp = null;
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on("ready", () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          this.conn = conn;
          this.sftp = sftp;
          logger_default.info(`SFTP \u5DF2\u8FDE\u63A5: ${this.config.host}:${this.config.port}`);
          resolve();
        });
      });
      conn.on("error", reject);
      const connectConfig = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username
      };
      if (this.config.privateKey) {
        connectConfig.privateKey = this.config.privateKey;
        if (this.config.passphrase) {
          connectConfig.passphrase = this.config.passphrase;
        }
      } else if (this.config.password) {
        connectConfig.password = this.config.password;
      }
      conn.connect(connectConfig);
    });
  }
  async disconnect() {
    if (this.conn) {
      this.conn.end();
      this.conn = null;
      this.sftp = null;
      logger_default.info("SFTP \u8FDE\u63A5\u5DF2\u5173\u95ED");
    }
  }
  async listFiles(remotePath) {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map((item) => ({
          name: item.filename,
          path: `${remotePath}/${item.filename}`,
          size: item.attrs.size,
          isDirectory: (item.attrs.mode & 16384) !== 0,
          mtime: new Date(item.attrs.mtime * 1e3).toISOString()
        })));
      });
    });
  }
  async readFile(remotePath) {
    return new Promise((resolve, reject) => {
      this.sftp.readFile(remotePath, (err, buf) => {
        if (err) return reject(err);
        resolve(buf);
      });
    });
  }
  async downloadFile(remotePath, localPath) {
    await fs10.ensureDir(path9.dirname(localPath));
    return new Promise((resolve, reject) => {
      const writeStream = createWriteStream2(localPath);
      const readStream = this.sftp.createReadStream(remotePath);
      readStream.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("close", () => resolve(localPath));
      readStream.pipe(writeStream);
    });
  }
  async downloadManifest(backupName) {
    const manifestPath = `${this.remotePath}/${backupName}/manifest.json`;
    const buffer = await this.readFile(manifestPath);
    return JSON.parse(buffer.toString("utf-8"));
  }
  async walkRemoteDir(remotePath) {
    const results = [];
    const entries = await this.listFiles(remotePath);
    for (const entry of entries) {
      if (entry.isDirectory) {
        const subResults = await this.walkRemoteDir(entry.path);
        results.push(...subResults);
      } else {
        results.push(entry);
      }
    }
    return results;
  }
  async downloadBackup(backupName, localDir, options = {}) {
    const { onProgress } = options;
    const remoteBackupPath = `${this.remotePath}/${backupName}`;
    const backupDir = path9.join(localDir, backupName);
    await fs10.ensureDir(backupDir);
    const allFiles = await this.walkRemoteDir(remoteBackupPath);
    const prefix = remoteBackupPath + "/";
    let downloaded = 0;
    for (const file of allFiles) {
      const relativePath = file.path.slice(prefix.length);
      if (!relativePath) continue;
      const localPath = path9.join(backupDir, relativePath);
      await this.downloadFile(file.path, localPath);
      downloaded++;
      if (onProgress) {
        onProgress(downloaded, allFiles.length, relativePath);
      }
    }
    logger_default.success(`\u5DF2\u4E0B\u8F7D ${downloaded} \u4E2A\u6587\u4EF6\u5230 ${backupDir}`);
    return backupDir;
  }
  async stat(remotePath) {
    return new Promise((resolve, reject) => {
      this.sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          size: stats.size,
          mtime: new Date(stats.mtime * 1e3).toISOString(),
          isDirectory: stats.isDirectory()
        });
      });
    });
  }
};

// src/commands/remote.js
async function remotePullCommand(options) {
  const {
    type,
    output,
    name,
    config: configPath,
    verbose = false
  } = options;
  logger_default.section("\u8FDC\u7AEF\u5907\u4EFD\u62C9\u53D6");
  logger_default.info(`\u8FDC\u7AEF\u7C7B\u578B: ${type}`);
  logger_default.info(`\u8F93\u51FA\u76EE\u5F55: ${output}`);
  logger_default.info(`\u5907\u4EFD\u540D\u79F0: ${name}`);
  const config = await loadConfig(configPath);
  if (type === "s3") {
    await pullFromS3(config.s3, name, output, verbose);
  } else if (type === "sftp") {
    await pullFromSFTP(config.sftp, name, output, verbose);
  } else {
    logger_default.error(`\u4E0D\u652F\u6301\u7684\u8FDC\u7AEF\u7C7B\u578B: ${type}\uFF0C\u4EC5\u652F\u6301 s3 \u548C sftp`);
    process.exit(1);
  }
}
async function remoteManifestCommand(options) {
  const {
    type,
    name,
    config: configPath
  } = options;
  logger_default.section("\u8FDC\u7AEF\u6E05\u5355\u8BFB\u53D6");
  logger_default.info(`\u8FDC\u7AEF\u7C7B\u578B: ${type}`);
  logger_default.info(`\u5907\u4EFD\u540D\u79F0: ${name}`);
  const config = await loadConfig(configPath);
  let manifest;
  if (type === "s3") {
    const adapter = new S3Adapter(config.s3);
    manifest = await adapter.downloadManifest(name);
  } else if (type === "sftp") {
    const adapter = new SFTPAdapter(config.sftp);
    await adapter.connect();
    try {
      manifest = await adapter.downloadManifest(name);
    } finally {
      await adapter.disconnect();
    }
  } else {
    logger_default.error(`\u4E0D\u652F\u6301\u7684\u8FDC\u7AEF\u7C7B\u578B: ${type}`);
    process.exit(1);
  }
  logger_default.section("\u6E05\u5355\u5185\u5BB9");
  logger_default.info(`\u5907\u4EFD\u540D\u79F0: ${manifest.backupName || "\u672A\u77E5"}`);
  logger_default.info(`\u521B\u5EFA\u65F6\u95F4: ${manifest.createdAt}`);
  logger_default.info(`\u6587\u4EF6\u6570\u91CF: ${Object.keys(manifest.files).length}`);
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}
async function pullFromS3(config, backupName, outputDir, verbose) {
  if (!config) {
    logger_default.error("\u7F3A\u5C11 S3 \u914D\u7F6E\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E\u6587\u4EF6");
    process.exit(1);
  }
  const adapter = new S3Adapter(config);
  logger_default.info("\u6B63\u5728\u4ECE S3 \u4E0B\u8F7D\u5907\u4EFD...");
  const backupDir = await adapter.downloadBackup(backupName, outputDir, {
    onProgress(current, total, file) {
      if (verbose) {
        logger_default.debug(`\u4E0B\u8F7D\u8FDB\u5EA6: ${current}/${total} - ${file}`, true);
      } else if (current % 10 === 0 || current === total) {
        logger_default.info(`\u4E0B\u8F7D\u8FDB\u5EA6: ${current}/${total}`);
      }
    }
  });
  logger_default.section("\u4E0B\u8F7D\u5B8C\u6210");
  logger_default.success(`\u5907\u4EFD\u5DF2\u4E0B\u8F7D\u5230: ${backupDir}`);
  return backupDir;
}
async function pullFromSFTP(config, backupName, outputDir, verbose) {
  if (!config) {
    logger_default.error("\u7F3A\u5C11 SFTP \u914D\u7F6E\uFF0C\u8BF7\u68C0\u67E5\u914D\u7F6E\u6587\u4EF6");
    process.exit(1);
  }
  const adapter = new SFTPAdapter(config);
  await adapter.connect();
  try {
    logger_default.info("\u6B63\u5728\u4ECE SFTP \u4E0B\u8F7D\u5907\u4EFD...");
    const backupDir = await adapter.downloadBackup(backupName, outputDir, {
      onProgress(current, total, file) {
        if (verbose) {
          logger_default.debug(`\u4E0B\u8F7D\u8FDB\u5EA6: ${current}/${total} - ${file}`, true);
        } else if (current % 10 === 0 || current === total) {
          logger_default.info(`\u4E0B\u8F7D\u8FDB\u5EA6: ${current}/${total}`);
        }
      }
    });
    logger_default.section("\u4E0B\u8F7D\u5B8C\u6210");
    logger_default.success(`\u5907\u4EFD\u5DF2\u4E0B\u8F7D\u5230: ${backupDir}`);
    return backupDir;
  } finally {
    await adapter.disconnect();
  }
}
async function loadConfig(configPath) {
  if (!configPath) {
    const defaultPaths = [
      "backup-verify.config.json",
      "backup-verify.config.jsonc",
      ".backup-verify.json"
    ];
    for (const p of defaultPaths) {
      if (await fs11.pathExists(p)) {
        configPath = p;
        break;
      }
    }
    if (!configPath) {
      logger_default.error("\u672A\u627E\u5230\u914D\u7F6E\u6587\u4EF6\uFF0C\u8BF7\u4F7F\u7528 --config \u6307\u5B9A\u914D\u7F6E\u6587\u4EF6\u8DEF\u5F84");
      process.exit(1);
    }
  }
  if (!await fs11.pathExists(configPath)) {
    logger_default.error(`\u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728: ${configPath}`);
    process.exit(1);
  }
  const raw = await fs11.readFile(configPath, "utf-8");
  const cleaned = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return JSON.parse(cleaned);
}

// src/commands/schedule.js
import fs12 from "fs-extra";
import path10 from "path";
import cron from "node-cron";
var SCHEDULES_DIR = "schedules";
async function scheduleStartCommand(options) {
  const {
    action,
    cron: cronExpr,
    source,
    output,
    sampleRate = 0.1,
    exclude = "",
    name,
    verbose = false,
    incremental = false,
    once = false
  } = options;
  logger_default.section("\u5B9A\u65F6\u4EFB\u52A1\u542F\u52A8");
  logger_default.info(`\u52A8\u4F5C: ${action}`);
  logger_default.info(`Cron \u8868\u8FBE\u5F0F: ${cronExpr}`);
  if (!cron.validate(cronExpr)) {
    logger_default.error(`\u65E0\u6548\u7684 Cron \u8868\u8FBE\u5F0F: ${cronExpr}`);
    process.exit(1);
  }
  const scheduleId = `schedule-${Date.now()}`;
  const scheduleInfo = {
    id: scheduleId,
    action,
    cron: cronExpr,
    source,
    output,
    sampleRate,
    exclude,
    name,
    incremental,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    runs: []
  };
  const runAction = async () => {
    const runStart = (/* @__PURE__ */ new Date()).toISOString();
    logger_default.section(`\u5B9A\u65F6\u4EFB\u52A1\u89E6\u53D1 [${action}]`);
    logger_default.info(`\u4EFB\u52A1 ID: ${scheduleId}`);
    logger_default.info(`\u89E6\u53D1\u65F6\u95F4: ${runStart}`);
    try {
      let result;
      if (action === "backup") {
        result = await backupCommand(source, {
          output,
          sampleRate,
          exclude: exclude ? exclude.split(",") : ["node_modules", ".git", "dist", "build"],
          name: name || `auto-${Date.now()}`,
          verbose
        });
      } else if (action === "verify") {
        result = await verifyCommand(source, { verbose, full: true });
      } else if (action === "incremental") {
        result = await incrementalVerifyCommand(source, { verbose, full: true });
      } else {
        logger_default.error(`\u672A\u77E5\u52A8\u4F5C: ${action}`);
        return;
      }
      const runEnd = (/* @__PURE__ */ new Date()).toISOString();
      scheduleInfo.runs.push({
        startedAt: runStart,
        finishedAt: runEnd,
        success: true,
        result: action === "verify" || action === "incremental" ? result.isOk : true
      });
      logger_default.success(`\u4EFB\u52A1\u6267\u884C\u5B8C\u6210: ${action}`);
    } catch (err) {
      const runEnd = (/* @__PURE__ */ new Date()).toISOString();
      scheduleInfo.runs.push({
        startedAt: runStart,
        finishedAt: runEnd,
        success: false,
        error: err.message
      });
      logger_default.error(`\u4EFB\u52A1\u6267\u884C\u5931\u8D25: ${err.message}`);
    }
    await saveScheduleInfo(scheduleInfo);
  };
  if (once) {
    await runAction();
    return;
  }
  logger_default.info("\u6B63\u5728\u6CE8\u518C Cron \u4EFB\u52A1...");
  const task = cron.schedule(cronExpr, runAction, {
    scheduled: true
  });
  logger_default.success(`Cron \u4EFB\u52A1\u5DF2\u6CE8\u518C: ${cronExpr}`);
  logger_default.info("\u6309 Ctrl+C \u505C\u6B62\u8C03\u5EA6");
  process.on("SIGINT", () => {
    logger_default.info("\u6B63\u5728\u505C\u6B62\u8C03\u5EA6...");
    task.stop();
    scheduleInfo.stoppedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveScheduleInfo(scheduleInfo).then(() => {
      logger_default.success("\u8C03\u5EA6\u5DF2\u505C\u6B62");
      process.exit(0);
    });
  });
  process.on("SIGTERM", () => {
    task.stop();
    scheduleInfo.stoppedAt = (/* @__PURE__ */ new Date()).toISOString();
    saveScheduleInfo(scheduleInfo).then(() => {
      process.exit(0);
    });
  });
  await saveScheduleInfo(scheduleInfo);
}
async function scheduleListCommand(options = {}) {
  logger_default.section("\u5B9A\u65F6\u4EFB\u52A1\u5217\u8868");
  if (!await fs12.pathExists(SCHEDULES_DIR)) {
    logger_default.info("\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1");
    return [];
  }
  const files = await fs12.readdir(SCHEDULES_DIR);
  const scheduleFiles = files.filter((f) => f.startsWith("schedule-") && f.endsWith(".json"));
  if (scheduleFiles.length === 0) {
    logger_default.info("\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1");
    return [];
  }
  const schedules = [];
  for (const file of scheduleFiles) {
    const info = await fs12.readJson(path10.join(SCHEDULES_DIR, file));
    schedules.push(info);
    logger_default.listItem(`ID: ${info.id}`);
    console.log(`     \u52A8\u4F5C: ${info.action}`);
    console.log(`     Cron: ${info.cron}`);
    console.log(`     \u542F\u52A8\u65F6\u95F4: ${info.startedAt}`);
    console.log(`     \u8FD0\u884C\u6B21\u6570: ${info.runs.length}`);
    if (info.stoppedAt) {
      console.log(`     \u505C\u6B62\u65F6\u95F4: ${info.stoppedAt}`);
    }
  }
  return schedules;
}
async function scheduleRemoveCommand(scheduleId) {
  logger_default.section("\u5220\u9664\u5B9A\u65F6\u4EFB\u52A1");
  logger_default.info(`\u4EFB\u52A1 ID: ${scheduleId}`);
  const filePath = path10.join(SCHEDULES_DIR, `${scheduleId}.json`);
  if (!await fs12.pathExists(filePath)) {
    logger_default.error(`\u4EFB\u52A1\u4E0D\u5B58\u5728: ${scheduleId}`);
    process.exit(1);
  }
  await fs12.remove(filePath);
  logger_default.success(`\u5DF2\u5220\u9664\u4EFB\u52A1: ${scheduleId}`);
}
async function saveScheduleInfo(info) {
  await fs12.ensureDir(SCHEDULES_DIR);
  const filePath = path10.join(SCHEDULES_DIR, `${info.id}.json`);
  await fs12.writeJson(filePath, info, { spaces: 2 });
}

// src/commands/multi-backup.js
import fs14 from "fs-extra";
import path12 from "path";

// src/utils/concurrency.js
var ConcurrencyPool = class {
  constructor(concurrency = 2, rateLimit = 0) {
    this._concurrency = Math.max(1, concurrency);
    this._rateLimit = rateLimit;
    this._running = 0;
    this._queue = [];
    this._lastStartTime = 0;
    this._results = [];
  }
  async add(fn, label = "task") {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, label, resolve, reject });
      this._drain();
    });
  }
  _drain() {
    while (this._running < this._concurrency && this._queue.length > 0) {
      const item = this._queue.shift();
      this._run(item);
    }
  }
  async _run(item) {
    this._running++;
    if (this._rateLimit > 0) {
      const now = Date.now();
      const elapsed = now - this._lastStartTime;
      const minInterval = 1e3 / this._rateLimit;
      if (elapsed < minInterval) {
        await sleep(minInterval - elapsed);
      }
    }
    this._lastStartTime = Date.now();
    try {
      const result = await item.fn();
      this._results.push({ label: item.label, status: "fulfilled", value: result });
      item.resolve(result);
    } catch (err) {
      this._results.push({ label: item.label, status: "rejected", reason: err });
      item.reject(err);
    } finally {
      this._running--;
      this._drain();
    }
  }
  getResults() {
    return this._results;
  }
  get pending() {
    return this._queue.length;
  }
  get active() {
    return this._running;
  }
};
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1e3,
    maxDelay = 3e4,
    factor = 2,
    label = "operation",
    onRetry = null
  } = options;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
        const jitter = Math.random() * delay * 0.2;
        const waitTime = delay + jitter;
        logger_default.warn(`\u91CD\u8BD5 ${label}: \u7B2C ${attempt + 1} \u6B21 (\u7B49\u5F85 ${Math.round(waitTime)}ms)`, {
          error: err.message,
          attempt: attempt + 1
        });
        if (onRetry) onRetry(attempt + 1, err);
        await sleep(waitTime);
      }
    }
  }
  throw lastError;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src/utils/chunk.js
import { createHash as createHash2 } from "crypto";
import { createReadStream as createReadStream2, openSync, readSync, fstatSync, closeSync, writeSync } from "fs";
import fs13 from "fs-extra";
import path11 from "path";
var DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
var PROGRESS_FILE = "chunk-progress.json";
async function hashFileChunked(filePath, options = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    algorithm = "sha256",
    onProgress = null
  } = options;
  const stat = await fs13.stat(filePath);
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
  logger_default.debug(`\u5206\u5757\u6821\u9A8C: ${filePath} (${formatSize2(fileSize)}, ${totalChunks} \u5757)`);
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
    const hash = createHash2(algorithm);
    const stream = createReadStream2(filePath, { start: offset, end: offset + size - 1 });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function simpleHashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash2(algorithm);
    const stream = createReadStream2(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
async function verifyChunked(backupDir, options = {}) {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    verbose = false,
    resume = true
  } = options;
  logger_default.section("\u5206\u5757\u6821\u9A8C\u5F00\u59CB");
  logger_default.info(`\u5907\u4EFD\u76EE\u5F55: ${backupDir}`);
  logger_default.info(`\u5206\u5757\u5927\u5C0F: ${formatSize2(chunkSize)}`);
  const manifestPath = path11.join(backupDir, "manifest.json");
  if (!await fs13.pathExists(manifestPath)) {
    logger_default.error(`\u6E05\u5355\u6587\u4EF6\u4E0D\u5B58\u5728: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = await fs13.readJson(manifestPath);
  const filesDir = path11.join(backupDir, "files");
  const progressPath = path11.join(backupDir, PROGRESS_FILE);
  let progress = null;
  if (resume && await fs13.pathExists(progressPath)) {
    progress = await fs13.readJson(progressPath);
    logger_default.info(`\u53D1\u73B0\u65AD\u70B9\u7EED\u4F20\u8FDB\u5EA6: \u5DF2\u5B8C\u6210 ${progress.completedCount}/${progress.totalFiles} \u6587\u4EF6`);
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
      if (verbose) logger_default.debug(`\u8DF3\u8FC7\u5DF2\u5B8C\u6210: ${relPath}`);
      continue;
    }
    const filePath = path11.join(filesDir, relPath);
    if (!await fs13.pathExists(filePath)) {
      results.missing.push({ path: relPath, expected });
      logger_default.warn(`\u7F3A\u5931\u6587\u4EF6: ${relPath}`);
      continue;
    }
    try {
      const chunkedResult = await hashFileChunked(filePath, {
        chunkSize,
        onProgress(current, total, bytesDone, bytesTotal) {
          if (verbose && current === total) {
            logger_default.debug(`\u5206\u5757\u5B8C\u6210: ${relPath} (${total} \u5757)`);
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
        if (verbose) logger_default.info(`\u6821\u9A8C\u901A\u8FC7: ${relPath} (${chunkedResult.totalChunks} \u5757)`);
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
          mismatchedChunks: mismatchedChunks.length > 0 ? mismatchedChunks : "hash_mismatch"
        });
        logger_default.warn(`\u6821\u9A8C\u5931\u8D25: ${relPath} - \u54C8\u5E0C\u4E0D\u5339\u914D`);
      }
      completedSet.add(relPath);
      await saveProgress(progressPath, Array.from(completedSet), files.length);
    } catch (err) {
      results.failed.push({ path: relPath, error: err.message });
      logger_default.error(`\u8BFB\u53D6\u5931\u8D25: ${relPath} - ${err.message}`);
    }
  }
  const isOk = results.failed.length === 0 && results.missing.length === 0;
  logger_default.section("\u5206\u5757\u6821\u9A8C\u7ED3\u679C");
  logger_default.info(`\u603B\u8BA1: ${files.length} \u4E2A\u6587\u4EF6`);
  logger_default.info(`\u901A\u8FC7: ${results.passed.length}`);
  if (results.skipped.length) logger_default.info(`\u8DF3\u8FC7\uFF08\u7EED\u4F20\uFF09: ${results.skipped.length}`);
  if (results.failed.length) logger_default.error(`\u5931\u8D25: ${results.failed.length}`);
  if (results.missing.length) logger_default.error(`\u7F3A\u5931: ${results.missing.length}`);
  if (isOk) {
    logger_default.success("\u2713 \u5206\u5757\u6821\u9A8C\u901A\u8FC7");
    if (await fs13.pathExists(progressPath)) await fs13.remove(progressPath);
  } else {
    logger_default.error("\u2717 \u5206\u5757\u6821\u9A8C\u5931\u8D25");
  }
  return { results, isOk };
}
async function saveProgress(progressPath, completed, totalFiles) {
  await fs13.writeJson(progressPath, {
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    totalFiles,
    completedCount: completed.length,
    completed
  }, { spaces: 2 });
}
async function copyWithResume(src, dest, options = {}) {
  const { chunkSize = DEFAULT_CHUNK_SIZE, onProgress = null } = options;
  await fs13.ensureDir(path11.dirname(dest));
  const srcStat = await fs13.stat(src);
  const fileSize = srcStat.size;
  if (await fs13.pathExists(dest)) {
    const destStat = await fs13.stat(dest);
    if (destStat.size === fileSize) {
      const srcHash = await simpleHashFile(src);
      const destHash = await simpleHashFile(dest);
      if (srcHash === destHash) {
        logger_default.debug(`\u8DF3\u8FC7\u5DF2\u5B8C\u6210\u590D\u5236: ${path11.basename(dest)}`);
        return { skipped: true };
      }
    }
  }
  const totalChunks = Math.ceil(fileSize / chunkSize);
  const fd = openSync(src, "r");
  const wd = openSync(dest, "w");
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
function formatSize2(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// src/commands/multi-backup.js
async function multiBackupCommand(sources, options) {
  const {
    output,
    sampleRate = 0.1,
    exclude = ["node_modules", ".git", "dist", "build"],
    extensions = null,
    concurrency = 2,
    rateLimit = 0,
    retries = 2,
    verbose = false,
    resume = true
  } = options;
  logger_default.section("\u591A\u6E90\u5E76\u53D1\u5907\u4EFD");
  logger_default.info(`\u6E90\u76EE\u5F55\u6570: ${sources.length}`);
  logger_default.info(`\u8F93\u51FA\u76EE\u5F55: ${output}`);
  logger_default.info(`\u5E76\u53D1\u6570: ${concurrency}`);
  logger_default.info(`\u91CD\u8BD5\u6B21\u6570: ${retries}`);
  const pool = new ConcurrencyPool(concurrency, rateLimit);
  const results = [];
  for (const source of sources) {
    pool.add(async () => {
      const sourceName = path12.basename(source);
      logger_default.setCorrelationId(sourceName);
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
              logger_default.warn(`\u6E90 ${sourceName} \u5907\u4EFD\u91CD\u8BD5 ${attempt}`, { error: err.message });
            }
          }
        );
        results.push({ source, status: "success", ...result });
        logger_default.info(`\u6E90 ${sourceName} \u5907\u4EFD\u5B8C\u6210`);
      } catch (err) {
        results.push({ source, status: "failed", error: err.message });
        logger_default.error(`\u6E90 ${sourceName} \u5907\u4EFD\u5931\u8D25: ${err.message}`);
      }
      logger_default.setCorrelationId(null);
    }, `backup-${path12.basename(source)}`);
  }
  while (pool.active > 0 || pool.pending > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  logger_default.section("\u591A\u6E90\u5907\u4EFD\u6C47\u603B");
  const succeeded = results.filter((r) => r.status === "success");
  const failed = results.filter((r) => r.status === "failed");
  logger_default.info(`\u6210\u529F: ${succeeded.length}`);
  if (failed.length > 0) {
    logger_default.error(`\u5931\u8D25: ${failed.length}`);
    failed.forEach((f) => logger_default.listItem(`${f.source}: ${f.error}`));
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
  if (!await fs14.pathExists(source)) {
    throw new Error(`\u6E90\u76EE\u5F55\u4E0D\u5B58\u5728: ${source}`);
  }
  const sourceStat = await fs14.stat(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`\u6E90\u8DEF\u5F84\u4E0D\u662F\u76EE\u5F55: ${source}`);
  }
  logger_default.info(`\u626B\u63CF\u6E90\u76EE\u5F55: ${source}`);
  const allFiles = await walkDir(source, {
    exclude,
    extensions: extensions ? extensions.split(",").map((e) => e.trim().toLowerCase()) : null
  });
  if (allFiles.length === 0) {
    logger_default.warn(`${source}: \u6CA1\u6709\u627E\u5230\u6587\u4EF6`);
    return { backupDir: null, fileCount: 0, totalSize: 0 };
  }
  const sampledFiles = sampleFiles(allFiles, sampleRate);
  const backupName = name || `backup-${Date.now()}`;
  const backupDir = path12.join(output, backupName);
  const filesDir = path12.join(backupDir, "files");
  let totalSize = 0;
  let copiedCount = 0;
  for (const file of sampledFiles) {
    const destPath = path12.join(filesDir, file.relativePath);
    const copyResult = await copyWithResume(file.path, destPath, {
      onProgress(current, total, bytesDone, bytesTotal) {
        if (verbose && current === total) {
          logger_default.debug(`\u5DF2\u590D\u5236: ${file.relativePath}`);
        }
      }
    });
    const stats = await fs14.stat(file.path);
    totalSize += stats.size;
    copiedCount++;
  }
  const manifest = await buildManifest(sampledFiles, source);
  manifest.backupName = backupName;
  manifest.sampleRate = sampleRate;
  manifest.totalFilesSampled = sampledFiles.length;
  manifest.totalFilesSource = allFiles.length;
  manifest.totalSize = totalSize;
  const manifestPath = path12.join(backupDir, "manifest.json");
  await fs14.writeJson(manifestPath, manifest, { spaces: 2 });
  logger_default.info(`\u5907\u4EFD\u5B8C\u6210: ${backupName} (${copiedCount} \u6587\u4EF6, ${formatSize(totalSize)})`);
  return { backupDir, manifest, fileCount: copiedCount, totalSize };
}

// src/commands/chunked-verify.js
var DEFAULT_CHUNK = 4 * 1024 * 1024;
async function chunkedVerifyCommand(backupDir, options) {
  const chunkSize = options.chunkSize || DEFAULT_CHUNK;
  const verbose = options.verbose || false;
  const resume = options.resume !== false;
  const { isOk, results } = await verifyChunked(backupDir, {
    chunkSize,
    verbose,
    resume
  });
  process.exit(isOk ? 0 : 1);
}

// bin/backup-verify.js
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var pkgPath = join(__dirname, "..", "package.json");
var pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
initGitHubActions();
var program = new Command();
program.name("backup-verify").description("\u5907\u4EFD\u9A8C\u8BC1 CLI \u5DE5\u5177 - \u5B9A\u671F\u62BD\u6837\u5907\u4EFD\u3001\u68C0\u67E5\u5907\u4EFD\u5B8C\u6574\u6027\u53CA\u5DEE\u5F02").version(pkg.version).option("--log-level <level>", "\u65E5\u5FD7\u7EA7\u522B: debug, info, warn, error, silent", "info").option("--log-json", "\u542F\u7528 JSON \u7ED3\u6784\u5316\u65E5\u5FD7\u8F93\u51FA").option("--log-file <path>", "\u65E5\u5FD7\u8F93\u51FA\u5230\u6587\u4EF6").option("--metrics", "\u542F\u7528 Prometheus metrics \u7AEF\u70B9").option("--metrics-port <port>", "Prometheus metrics \u7AEF\u53E3", (v) => Number(v) || 9090, 9090).option("--otel", "\u542F\u7528 OpenTelemetry metrics \u4E0A\u62A5").option("--otel-endpoint <url>", "OpenTelemetry OTLP \u7AEF\u70B9", "http://localhost:4318/v1/metrics").hook("preAction", (thisCommand) => {
  const globalOpts = thisCommand.opts();
  if (globalOpts.logLevel || globalOpts.logJson || globalOpts.logFile) {
    logger_default.configure({
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
program.hook("postAction", async () => {
  flushSummary();
  await shutdownMetrics();
});
program.command("backup <source>").description("\u62BD\u6837\u5907\u4EFD\u6307\u5B9A\u76EE\u5F55\u7684\u6587\u4EF6").requiredOption("-o, --output <dir>", "\u5907\u4EFD\u8F93\u51FA\u76EE\u5F55").option("-r, --sample-rate <rate>", "\u62BD\u6837\u6BD4\u4F8B (0-1)", parseFloat, 0.1).option("-e, --exclude <patterns>", "\u6392\u9664\u76EE\u5F55/\u6587\u4EF6\uFF0C\u9017\u53F7\u5206\u9694", (val) => val.split(",")).option("--extensions <exts>", "\u6307\u5B9A\u6587\u4EF6\u6269\u5C55\u540D\uFF0C\u9017\u53F7\u5206\u9694").option("-n, --name <name>", "\u5907\u4EFD\u540D\u79F0\uFF0C\u9ED8\u8BA4\u81EA\u52A8\u751F\u6210").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").action(async (source, options) => {
  const start = Date.now();
  try {
    const result = await backupCommand(source, options);
    const duration = (Date.now() - start) / 1e3;
    const fileCount = result.sampledFiles?.length || 0;
    const totalSize = result.manifest?.totalSize || 0;
    emitBackup(fileCount, totalSize, duration);
    emitBackupResult({ backupDir: result.backupDir, fileCount, totalSize });
  } catch (err) {
    error(`\u5907\u4EFD\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.command("verify <backup-dir>").description("\u68C0\u67E5\u5907\u4EFD\u7684\u5B8C\u6574\u6027").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").option("-f, --full", "\u5B8C\u6574\u68C0\u67E5\uFF08\u5305\u62EC\u591A\u4F59\u6587\u4EF6\u68C0\u6D4B\uFF09").action(async (backupDir, options) => {
  const start = Date.now();
  try {
    const result = await verifyCommand(backupDir, options);
    const duration = (Date.now() - start) / 1e3;
    emitVerify(
      result.results.passed.length,
      result.results.failed.length,
      result.results.missing.length,
      duration
    );
    emitVerifyResult(result);
    process.exit(result.isOk ? 0 : 1);
  } catch (err) {
    error(`\u9A8C\u8BC1\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.command("diff <backup1> <backup2>").description("\u5BF9\u6BD4\u4E24\u4E2A\u5907\u4EFD\u4E4B\u95F4\u7684\u5DEE\u5F02").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").option("-c, --content", "\u663E\u793A\u6587\u4EF6\u5185\u5BB9\u5DEE\u5F02\uFF08\u4EC5\u6587\u672C\u6587\u4EF6\uFF09").option("--export <path>", "\u5BFC\u51FA\u5DEE\u5F02\u62A5\u544A\uFF08\u652F\u6301 .json \u548C .csv \u683C\u5F0F\uFF09").action(async (backup1, backup2, options) => {
  const start = Date.now();
  try {
    const result = await diffCommand(backup1, backup2, options);
    const duration = (Date.now() - start) / 1e3;
    emitDiff(
      result.added.length,
      result.removed.length,
      result.modified.length,
      result.unchanged.length,
      duration
    );
    emitDiffResult(result);
  } catch (err) {
    error(`\u5BF9\u6BD4\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.command("incremental <backup-dir>").description("\u589E\u91CF\u54C8\u5E0C\u6821\u9A8C\uFF08\u4EC5\u6821\u9A8C\u53D8\u66F4\u6587\u4EF6\uFF09").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").option("-f, --full", "\u5B8C\u6574\u68C0\u67E5\uFF08\u5305\u62EC\u591A\u4F59\u6587\u4EF6\u68C0\u6D4B\uFF09").action(async (backupDir, options) => {
  try {
    const { isOk } = await incrementalVerifyCommand(backupDir, options);
    process.exit(isOk ? 0 : 1);
  } catch (err) {
    error(`\u589E\u91CF\u6821\u9A8C\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.command("chunked-verify <backup-dir>").description("\u5927\u6587\u4EF6\u5206\u5757\u6821\u9A8C\uFF08\u652F\u6301\u65AD\u70B9\u7EED\u4F20\uFF09").option("--chunk-size <bytes>", "\u5206\u5757\u5927\u5C0F\uFF08\u5B57\u8282\uFF09\uFF0C\u9ED8\u8BA4 4194304 (4MB)", (v) => Number(v) || 4 * 1024 * 1024, 4 * 1024 * 1024).option("--no-resume", "\u7981\u7528\u65AD\u70B9\u7EED\u4F20").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").action(async (backupDir, options) => {
  try {
    await chunkedVerifyCommand(backupDir, options);
  } catch (err) {
    error(`\u5206\u5757\u6821\u9A8C\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.command("multi-backup <sources...>").description("\u591A\u6E90\u5E76\u53D1\u5907\u4EFD\uFF08\u652F\u6301\u9650\u6D41\u548C\u5931\u8D25\u91CD\u8BD5\uFF09").requiredOption("-o, --output <dir>", "\u5907\u4EFD\u8F93\u51FA\u76EE\u5F55").option("-r, --sample-rate <rate>", "\u62BD\u6837\u6BD4\u4F8B (0-1)", parseFloat, 0.1).option("-e, --exclude <patterns>", "\u6392\u9664\u76EE\u5F55/\u6587\u4EF6\uFF0C\u9017\u53F7\u5206\u9694", (val) => val.split(",")).option("--extensions <exts>", "\u6307\u5B9A\u6587\u4EF6\u6269\u5C55\u540D\uFF0C\u9017\u53F7\u5206\u9694").option("-c, --concurrency <n>", "\u5E76\u53D1\u6570", (v) => Number(v) || 2, 2).option("--rate-limit <n>", "\u6BCF\u79D2\u6700\u5927\u64CD\u4F5C\u6570 (0=\u4E0D\u9650)", (v) => Number(v) || 0, 0).option("--retries <n>", "\u5931\u8D25\u91CD\u8BD5\u6B21\u6570", (v) => Number(v) || 2, 2).option("--no-resume", "\u7981\u7528\u65AD\u70B9\u7EED\u4F20\u590D\u5236").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").action(async (sources, options) => {
  try {
    const { allOk, succeeded, failed } = await multiBackupCommand(sources, options);
    emitMultiBackup(succeeded.length, failed.length);
    setOutput("multi_backup_success", String(succeeded.length));
    setOutput("multi_backup_failed", String(failed.length));
    process.exit(allOk ? 0 : 1);
  } catch (err) {
    error(`\u591A\u6E90\u5907\u4EFD\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.command("metrics").description("\u8F93\u51FA Prometheus \u683C\u5F0F\u7684 metrics\uFF08\u4E0D\u542F\u52A8 HTTP \u670D\u52A1\uFF09").action(async () => {
  const content = await getMetrics();
  console.log(content);
});
var remoteCmd = program.command("remote").description("\u8FDC\u7AEF\u5907\u4EFD\u64CD\u4F5C");
remoteCmd.command("pull").description("\u4ECE\u8FDC\u7AEF\u62C9\u53D6\u5907\u4EFD\u5230\u672C\u5730").requiredOption("-t, --type <type>", "\u8FDC\u7AEF\u7C7B\u578B: s3 \u6216 sftp").requiredOption("-o, --output <dir>", "\u672C\u5730\u8F93\u51FA\u76EE\u5F55").requiredOption("-n, --name <name>", "\u8FDC\u7AEF\u5907\u4EFD\u540D\u79F0").option("-c, --config <path>", "\u914D\u7F6E\u6587\u4EF6\u8DEF\u5F84").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").action(async (options) => {
  try {
    await remotePullCommand(options);
  } catch (err) {
    error(`\u62C9\u53D6\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
remoteCmd.command("manifest").description("\u8BFB\u53D6\u8FDC\u7AEF\u5907\u4EFD\u6E05\u5355").requiredOption("-t, --type <type>", "\u8FDC\u7AEF\u7C7B\u578B: s3 \u6216 sftp").requiredOption("-n, --name <name>", "\u8FDC\u7AEF\u5907\u4EFD\u540D\u79F0").option("-c, --config <path>", "\u914D\u7F6E\u6587\u4EF6\u8DEF\u5F84").action(async (options) => {
  try {
    await remoteManifestCommand(options);
  } catch (err) {
    error(`\u8BFB\u53D6\u6E05\u5355\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
var scheduleCmd = program.command("schedule").description("\u5B9A\u65F6\u4EFB\u52A1\u8C03\u5EA6");
scheduleCmd.command("start").description("\u542F\u52A8\u5B9A\u65F6\u4EFB\u52A1").requiredOption("-a, --action <action>", "\u6267\u884C\u52A8\u4F5C: backup / verify / incremental").requiredOption("--cron <expr>", 'Cron \u8868\u8FBE\u5F0F (\u5982 "0 2 * * *" \u8868\u793A\u6BCF\u5929\u51CC\u66682\u70B9)').option("-s, --source <path>", "\u6E90\u76EE\u5F55\uFF08backup \u52A8\u4F5C\u5FC5\u586B\uFF09").option("-o, --output <dir>", "\u8F93\u51FA\u76EE\u5F55\uFF08backup \u52A8\u4F5C\u5FC5\u586B\uFF09").option("-r, --sample-rate <rate>", "\u62BD\u6837\u6BD4\u4F8B", parseFloat, 0.1).option("-e, --exclude <patterns>", "\u6392\u9664\u76EE\u5F55/\u6587\u4EF6\uFF0C\u9017\u53F7\u5206\u9694").option("-n, --name <name>", "\u5907\u4EFD\u540D\u79F0\u524D\u7F00").option("-v, --verbose", "\u663E\u793A\u8BE6\u7EC6\u4FE1\u606F").option("--once", "\u7ACB\u5373\u6267\u884C\u4E00\u6B21\u540E\u9000\u51FA").action(async (options) => {
  try {
    await scheduleStartCommand(options);
  } catch (err) {
    error(`\u8C03\u5EA6\u542F\u52A8\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
scheduleCmd.command("list").description("\u5217\u51FA\u6240\u6709\u5B9A\u65F6\u4EFB\u52A1").action(async () => {
  try {
    await scheduleListCommand();
  } catch (err) {
    error(`\u5217\u8868\u83B7\u53D6\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
scheduleCmd.command("remove <schedule-id>").description("\u5220\u9664\u6307\u5B9A\u5B9A\u65F6\u4EFB\u52A1").action(async (scheduleId) => {
  try {
    await scheduleRemoveCommand(scheduleId);
  } catch (err) {
    error(`\u5220\u9664\u5931\u8D25: ${err.message}`);
    process.exit(1);
  }
});
program.parse(process.argv);
