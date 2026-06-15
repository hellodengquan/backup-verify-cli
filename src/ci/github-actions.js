import fs from 'fs-extra';
import path from 'path';

let _githubOutputFile = null;
let _githubStepSummaryFile = null;
let _enabled = false;
let _summaryContent = [];

export function initGitHubActions() {
  const isCI = process.env.GITHUB_ACTIONS === 'true';
  if (!isCI) return false;

  _enabled = true;
  _githubOutputFile = process.env.GITHUB_OUTPUT || null;
  _githubStepSummaryFile = process.env.GITHUB_STEP_SUMMARY || null;

  return true;
}

export function isGitHubActions() {
  return _enabled || process.env.GITHUB_ACTIONS === 'true';
}

export function forceEnableForTest() {
  _enabled = true;
  if (!_githubOutputFile) _githubOutputFile = process.env.GITHUB_OUTPUT || null;
  if (!_githubStepSummaryFile) _githubStepSummaryFile = process.env.GITHUB_STEP_SUMMARY || null;
}

export function setOutput(name, value) {
  const line = `${name}=${value}`;

  if (_githubOutputFile) {
    fs.appendFileSync(_githubOutputFile, line + '\n');
  }

  if (!_enabled) return;

  const encoded = encodeGitHubValue(value);
  process.stdout.write(`::set-output name=${name}::${encoded}\n`);
}

export function group(title) {
  if (_enabled) process.stdout.write(`::group::${title}\n`);
}

export function endGroup() {
  if (_enabled) process.stdout.write('::endgroup::\n');
}

export function error(message, options = {}) {
  if (_enabled) {
    const props = formatAnnotationProps(options);
    process.stderr.write(`::error${props}::${encodeGitHubValue(message)}\n`);
  }
}

export function warning(message, options = {}) {
  if (_enabled) {
    const props = formatAnnotationProps(options);
    process.stdout.write(`::warning${props}::${encodeGitHubValue(message)}\n`);
  }
}

export function notice(message, options = {}) {
  if (_enabled) {
    const props = formatAnnotationProps(options);
    process.stdout.write(`::notice${props}::${encodeGitHubValue(message)}\n`);
  }
}

export function addSummary(content) {
  _summaryContent.push(content);

  if (_githubStepSummaryFile) {
    fs.appendFileSync(_githubStepSummaryFile, content + '\n');
  }
}

export function addSummaryHeading(text, level = 2) {
  const hashes = '#'.repeat(level);
  addSummary(`${hashes} ${text}`);
}

export function addSummaryTable(headers, rows) {
  const headerLine = `| ${headers.join(' | ')} |`;
  const separatorLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const dataLines = rows.map(row => `| ${row.join(' | ')} |`);
  addSummary([headerLine, separatorLine, ...dataLines].join('\n'));
}

export function flushSummary() {
  if (_githubStepSummaryFile && _summaryContent.length > 0) {
    const content = _summaryContent.join('\n') + '\n';
    fs.appendFileSync(_githubStepSummaryFile, content);
  }
  _summaryContent = [];
}

export function getSummaryContent() {
  return _summaryContent.join('\n');
}

export function emitBackupResult(result) {
  const { backupDir, fileCount, totalSize } = result;

  setOutput('backup_dir', backupDir || '');
  setOutput('backup_file_count', String(fileCount || 0));
  setOutput('backup_total_size', String(totalSize || 0));

  if (_enabled) {
    group('备份结果');
    notice(`备份完成: ${fileCount} 个文件, ${formatBytes(totalSize)}`);
    endGroup();
  }

  addSummaryHeading('备份结果');
  addSummaryTable(
    ['指标', '值'],
    [
      ['文件数', String(fileCount || 0)],
      ['总大小', formatBytes(totalSize)],
      ['备份目录', backupDir || 'N/A']
    ]
  );
}

export function emitVerifyResult(result) {
  const { results, isOk } = result;

  setOutput('verify_passed', String(results.passed?.length || 0));
  setOutput('verify_failed', String(results.failed?.length || 0));
  setOutput('verify_missing', String(results.missing?.length || 0));
  setOutput('verify_ok', String(isOk));

  if (_enabled) {
    group('校验结果');
    if (isOk) {
      notice(`校验通过: ${results.passed?.length || 0} 个文件`);
    } else {
      error(`校验失败: ${results.failed?.length || 0} 损坏, ${results.missing?.length || 0} 缺失`);
    }
    endGroup();
  }

  addSummaryHeading('校验结果');
  addSummaryTable(
    ['状态', '数量'],
    [
      ['通过', String(results.passed?.length || 0)],
      ['损坏', String(results.failed?.length || 0)],
      ['缺失', String(results.missing?.length || 0)]
    ]
  );
}

export function emitDiffResult(result) {
  const { added, removed, modified, unchanged, hasChanges } = result;

  setOutput('diff_added', String(added?.length || 0));
  setOutput('diff_removed', String(removed?.length || 0));
  setOutput('diff_modified', String(modified?.length || 0));
  setOutput('diff_has_changes', String(hasChanges));

  if (_enabled) {
    group('差异对比结果');
    if (hasChanges) {
      warning(`发现差异: +${added?.length || 0} -${removed?.length || 0} ~${modified?.length || 0}`);
    } else {
      notice('两个备份完全一致');
    }
    endGroup();
  }

  addSummaryHeading('差异对比');
  addSummaryTable(
    ['类型', '数量'],
    [
      ['新增', String(added?.length || 0)],
      ['删除', String(removed?.length || 0)],
      ['修改', String(modified?.length || 0)],
      ['未变化', String(unchanged?.length || 0)]
    ]
  );
}

function formatAnnotationProps(options) {
  const parts = [];
  if (options.file) parts.push(`file=${encodeGitHubValue(options.file)}`);
  if (options.line) parts.push(`line=${options.line}`);
  if (options.col) parts.push(`col=${options.col}`);
  return parts.length > 0 ? ` ${parts.join(',')}` : '';
}

export function encodeGitHubValue(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
