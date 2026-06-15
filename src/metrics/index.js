import http from 'http';
import logger from '../utils/logger.js';
import { recordBackup, recordVerify, recordDiff, recordMultiBackup, recordRetry, recordChunkedVerify, recordIncrementalSkipped, getMetrics, getContentType, resetMetrics } from './prometheus.js';
import { initOtelMetrics, otelRecordBackup, otelRecordVerify, otelRecordDiff, otelRecordMultiBackup, otelRecordRetry, shutdownOtelMetrics, isOtelInitialized } from './otel.js';

let metricsServer = null;

export function initMetrics(options = {}) {
  const { prometheus = false, port = 9090, otel = false, otelEndpoint = 'http://localhost:4318/v1/metrics' } = options;

  if (prometheus) {
    startMetricsServer(port);
  }

  if (otel) {
    initOtelMetrics({ endpoint: otelEndpoint });
    logger.info(`OpenTelemetry metrics 上报已启用: ${otelEndpoint}`);
  }
}

function startMetricsServer(port) {
  metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const content = await getMetrics();
        res.writeHead(200, { 'Content-Type': getContentType() });
        res.end(content);
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  metricsServer.listen(port, () => {
    logger.info(`Prometheus metrics 端点: http://localhost:${port}/metrics`);
  });
}

export function emitBackup(fileCount, bytes, durationSec) {
  recordBackup(fileCount, bytes, durationSec);
  otelRecordBackup(fileCount, bytes, durationSec);
}

export function emitVerify(passed, failed, missing, durationSec) {
  recordVerify(passed, failed, missing, durationSec);
  otelRecordVerify(passed, failed + missing, durationSec);
}

export function emitDiff(added, removed, modified, unchanged, durationSec) {
  recordDiff(added, removed, modified, unchanged, durationSec);
  otelRecordDiff(added, removed, modified, unchanged);
}

export function emitMultiBackup(successCount, failedCount) {
  recordMultiBackup(successCount, failedCount);
  otelRecordMultiBackup(successCount, failedCount);
}

export function emitRetry(operation) {
  recordRetry(operation);
  otelRecordRetry(operation);
}

export function emitChunkedVerify(passedChunks, failedChunks) {
  recordChunkedVerify(passedChunks, failedChunks);
}

export function emitIncrementalSkipped(count) {
  recordIncrementalSkipped(count);
}

export async function shutdownMetrics() {
  if (metricsServer) {
    await new Promise((resolve) => metricsServer.close(resolve));
    metricsServer = null;
    logger.info('Prometheus metrics 服务已关闭');
  }
  await shutdownOtelMetrics();
}

export { getMetrics, getContentType, resetMetrics };
