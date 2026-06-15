import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';

let meter = null;
let meterProvider = null;

const counters = {};

export function initOtelMetrics(options = {}) {
  const {
    endpoint = 'http://localhost:4318/v1/metrics',
    exportInterval = 10000,
    serviceName = 'backup-verify'
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

  counters.backupFilesTotal = meter.createCounter('backup_verify_backup_files_total', { description: 'Total files backed up' });
  counters.backupBytesTotal = meter.createCounter('backup_verify_backup_bytes_total', { description: 'Total bytes backed up' });
  counters.verifyFilesPassed = meter.createCounter('backup_verify_verify_files_passed', { description: 'Files that passed verification' });
  counters.verifyFilesFailed = meter.createCounter('backup_verify_verify_files_failed', { description: 'Files that failed verification' });
  counters.diffFilesTotal = meter.createCounter('backup_verify_diff_files_total', { description: 'Total files in diff by type' });
  counters.multiBackupSourcesTotal = meter.createCounter('backup_verify_multi_backup_sources_total', { description: 'Total sources processed' });
  counters.retryAttemptsTotal = meter.createCounter('backup_verify_retry_attempts_total', { description: 'Retry attempts' });

  counters.backupDuration = meter.createHistogram('backup_verify_backup_duration_seconds', { description: 'Backup duration' });
  counters.verifyDuration = meter.createHistogram('backup_verify_verify_duration_seconds', { description: 'Verify duration' });

  return meterProvider;
}

export function otelRecordBackup(fileCount, bytes, durationSec) {
  if (!meter) return;
  counters.backupFilesTotal.add(fileCount);
  counters.backupBytesTotal.add(bytes);
  counters.backupDuration.record(durationSec);
}

export function otelRecordVerify(passed, failed, durationSec) {
  if (!meter) return;
  counters.verifyFilesPassed.add(passed);
  counters.verifyFilesFailed.add(failed);
  counters.verifyDuration.record(durationSec);
}

export function otelRecordDiff(added, removed, modified, unchanged) {
  if (!meter) return;
  counters.diffFilesTotal.add(added, { change_type: 'added' });
  counters.diffFilesTotal.add(removed, { change_type: 'removed' });
  counters.diffFilesTotal.add(modified, { change_type: 'modified' });
  counters.diffFilesTotal.add(unchanged, { change_type: 'unchanged' });
}

export function otelRecordMultiBackup(successCount, failedCount) {
  if (!meter) return;
  counters.multiBackupSourcesTotal.add(successCount, { status: 'success' });
  counters.multiBackupSourcesTotal.add(failedCount, { status: 'failed' });
}

export function otelRecordRetry(operation) {
  if (!meter) return;
  counters.retryAttemptsTotal.add(1, { operation });
}

export async function shutdownOtelMetrics() {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
    meter = null;
  }
}

export function isOtelInitialized() {
  return meter !== null;
}
