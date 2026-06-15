import client from 'prom-client';

const register = new client.Registry();

register.setDefaultLabels({ app: 'backup-verify' });

const metrics = {
  backupFilesTotal: new client.Counter({
    name: 'backup_verify_backup_files_total',
    help: 'Total number of files backed up',
    registers: [register]
  }),
  backupBytesTotal: new client.Counter({
    name: 'backup_verify_backup_bytes_total',
    help: 'Total bytes backed up',
    registers: [register]
  }),
  backupDurationSeconds: new client.Histogram({
    name: 'backup_verify_backup_duration_seconds',
    help: 'Backup operation duration in seconds',
    buckets: [1, 5, 10, 30, 60, 120, 300, 600],
    registers: [register]
  }),
  verifyFilesTotal: new client.Counter({
    name: 'backup_verify_verify_files_total',
    help: 'Total files verified',
    labelNames: ['result'],
    registers: [register]
  }),
  verifyDurationSeconds: new client.Histogram({
    name: 'backup_verify_verify_duration_seconds',
    help: 'Verify operation duration in seconds',
    buckets: [0.5, 1, 5, 10, 30, 60, 120],
    registers: [register]
  }),
  diffFilesTotal: new client.Counter({
    name: 'backup_verify_diff_files_total',
    help: 'Total files in diff result',
    labelNames: ['change_type'],
    registers: [register]
  }),
  diffDurationSeconds: new client.Histogram({
    name: 'backup_verify_diff_duration_seconds',
    help: 'Diff operation duration in seconds',
    buckets: [0.5, 1, 5, 10, 30],
    registers: [register]
  }),
  multiBackupSourcesTotal: new client.Counter({
    name: 'backup_verify_multi_backup_sources_total',
    help: 'Total source directories processed',
    labelNames: ['status'],
    registers: [register]
  }),
  retryAttemptsTotal: new client.Counter({
    name: 'backup_verify_retry_attempts_total',
    help: 'Total retry attempts',
    labelNames: ['operation'],
    registers: [register]
  }),
  chunkedVerifyChunksTotal: new client.Counter({
    name: 'backup_verify_chunked_chunks_total',
    help: 'Total chunks verified',
    labelNames: ['result'],
    registers: [register]
  }),
  incrementalSkippedTotal: new client.Counter({
    name: 'backup_verify_incremental_skipped_total',
    help: 'Total files skipped in incremental verify',
    registers: [register]
  })
};

export function recordBackup(fileCount, bytes, durationSec) {
  metrics.backupFilesTotal.inc(fileCount);
  metrics.backupBytesTotal.inc(bytes);
  metrics.backupDurationSeconds.observe(durationSec);
}

export function recordVerify(passed, failed, missing, durationSec) {
  metrics.verifyFilesTotal.inc({ result: 'passed' }, passed);
  metrics.verifyFilesTotal.inc({ result: 'failed' }, failed);
  metrics.verifyFilesTotal.inc({ result: 'missing' }, missing);
  metrics.verifyDurationSeconds.observe(durationSec);
}

export function recordDiff(added, removed, modified, unchanged, durationSec) {
  metrics.diffFilesTotal.inc({ change_type: 'added' }, added);
  metrics.diffFilesTotal.inc({ change_type: 'removed' }, removed);
  metrics.diffFilesTotal.inc({ change_type: 'modified' }, modified);
  metrics.diffFilesTotal.inc({ change_type: 'unchanged' }, unchanged);
  metrics.diffDurationSeconds.observe(durationSec);
}

export function recordMultiBackup(successCount, failedCount) {
  metrics.multiBackupSourcesTotal.inc({ status: 'success' }, successCount);
  metrics.multiBackupSourcesTotal.inc({ status: 'failed' }, failedCount);
}

export function recordRetry(operation) {
  metrics.retryAttemptsTotal.inc({ operation });
}

export function recordChunkedVerify(passedChunks, failedChunks) {
  metrics.chunkedVerifyChunksTotal.inc({ result: 'passed' }, passedChunks);
  metrics.chunkedVerifyChunksTotal.inc({ result: 'failed' }, failedChunks);
}

export function recordIncrementalSkipped(count) {
  metrics.incrementalSkippedTotal.inc(count);
}

export async function getMetrics() {
  return register.metrics();
}

export function getContentType() {
  return register.contentType;
}

export function resetMetrics() {
  register.resetMetrics();
}

export { register, metrics };
