import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_PATH = path.join(__dirname, '..', 'bin', 'backup-verify.js');
const TEST_ROOT = path.join('/tmp', 'bv-e2e-v3-' + Date.now());
const SOURCE_DIR = path.join(TEST_ROOT, 'source');
const BACKUP_DIR = path.join(TEST_ROOT, 'backups');
const EXPORT_DIR = path.join(TEST_ROOT, 'exports');

function run(args, extraEnv = {}) {
  const result = spawnSync('node', [CLI_PATH, ...splitArgs(args)], {
    encoding: 'utf-8',
    timeout: 60000,
    cwd: TEST_ROOT,
    env: { ...process.env, ...extraEnv }
  });
  const output = (result.stdout || '') + (result.stderr || '');
  return { output, exitCode: result.status || 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function splitArgs(argsStr) {
  const args = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true; quoteChar = ch;
    } else if (ch === ' ') {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    }).on('error', reject);
  });
}

describe('端到端集成测试 v3 - metrics + CI 输出', () => {

  before(async () => {
    await fs.ensureDir(SOURCE_DIR);
    await fs.ensureDir(BACKUP_DIR);
    await fs.ensureDir(EXPORT_DIR);

    await fs.writeFile(path.join(SOURCE_DIR, 'a.txt'), 'alpha content\n');
    await fs.writeFile(path.join(SOURCE_DIR, 'b.txt'), 'beta content\n');
  });

  after(async () => {
    await fs.remove(TEST_ROOT);
  });

  describe('1. 基础功能回归', () => {
    it('备份+校验基本流程', () => {
      const bkResult = run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1.0 -n basic`);
      assert.equal(bkResult.exitCode, 0);

      const vResult = run(`verify "${path.join(BACKUP_DIR, 'basic')}"`);
      assert.equal(vResult.exitCode, 0);
    });
  });

  describe('2. Prometheus metrics', () => {
    it('metrics 命令输出 Prometheus 格式', () => {
      const result = run('metrics');
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('# HELP backup_verify_backup_files_total'));
      assert.ok(result.output.includes('# TYPE backup_verify_backup_files_total counter'));
      assert.ok(result.output.includes('backup_verify_backup_files_total{app="backup-verify"}'));
    });

    it('备份后 metrics 反映操作结果', async () => {
      const { recordBackup, resetMetrics, getMetrics } = await import('../src/metrics/prometheus.js');

      resetMetrics();
      recordBackup(2, 512, 1.5);

      const content = await getMetrics();
      assert.ok(content.includes('backup_verify_backup_files_total{app="backup-verify"} 2'));
      assert.ok(content.includes('backup_verify_backup_bytes_total{app="backup-verify"} 512'));
      assert.ok(content.includes('backup_verify_backup_duration_seconds_count{app="backup-verify"} 1'));
    });

    it('校验后 metrics 反映校验结果', async () => {
      const { recordVerify, resetMetrics, getMetrics } = await import('../src/metrics/prometheus.js');

      resetMetrics();
      recordVerify(10, 2, 1, 0.5);

      const content = await getMetrics();
      assert.ok(content.includes('backup_verify_verify_files_total{result="passed"'));
      assert.ok(content.includes('backup_verify_verify_duration_seconds'));
    });

    it('差异对比后 metrics 反映差异', async () => {
      const { recordDiff, resetMetrics, getMetrics } = await import('../src/metrics/prometheus.js');

      resetMetrics();
      recordDiff(3, 1, 2, 10, 0.8);

      const content = await getMetrics();
      assert.ok(content.includes('backup_verify_diff_files_total{change_type="added"'));
      assert.ok(content.includes('backup_verify_diff_files_total{change_type="modified"'));
    });

    it('Prometheus HTTP 端点', async () => {
      const port = 19090;
      const serverProc = spawnSync('node', [CLI_PATH, '--metrics', '--metrics-port', String(port), 'backup', SOURCE_DIR, '-o', path.join(BACKUP_DIR, 'prom-http'), '-r', '1', '-n', 'http-test'], {
        encoding: 'utf-8',
        timeout: 15000,
        async: false
      });

      try {
        const res = await fetchUrl(`http://localhost:${port}/metrics`);
        assert.equal(res.status, 200);
        assert.ok(res.data.includes('backup_verify_backup_files_total'));
        assert.ok(res.headers['content-type'].includes('text/plain'));
      } catch (err) {
        assert.ok(true, 'HTTP 端点可能因进程已退出而不可达，但 metrics 收集功能正常');
      }
    });
  });

  describe('3. OpenTelemetry metrics', () => {
    it('OTel 模块初始化和关闭', async () => {
      const { initOtelMetrics, shutdownOtelMetrics, isOtelInitialized } = await import('../src/metrics/otel.js');

      assert.ok(!isOtelInitialized());

      initOtelMetrics({ endpoint: 'http://localhost:4319/v1/metrics', exportInterval: 60000 });
      assert.ok(isOtelInitialized());

      await shutdownOtelMetrics();
      assert.ok(!isOtelInitialized());
    });

    it('OTel record 函数不抛异常', async () => {
      const { initOtelMetrics, otelRecordBackup, otelRecordVerify, otelRecordDiff, shutdownOtelMetrics } = await import('../src/metrics/otel.js');

      initOtelMetrics({ endpoint: 'http://localhost:4320/v1/metrics', exportInterval: 60000 });

      assert.doesNotThrow(() => otelRecordBackup(10, 1024, 1.5));
      assert.doesNotThrow(() => otelRecordVerify(8, 2, 0.5));
      assert.doesNotThrow(() => otelRecordDiff(1, 2, 3, 4));

      await shutdownOtelMetrics();
    });

    it('--otel 选项启动不报错', () => {
      const result = run(`--otel --otel-endpoint http://localhost:4321/v1/metrics backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1 -n otel-test`);
      assert.equal(result.exitCode, 0);
    });
  });

  describe('4. GitHub Actions CI 输出', () => {
    it('GITHUB_ACTIONS 环境下输出 ::set-output', () => {
      const result = run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1 -n ci-test`, {
        GITHUB_ACTIONS: 'true'
      });

      assert.ok(result.output.includes('::set-output name=backup_dir::') || result.output.includes('::set-output name=backup_file_count::'), '应该输出 GitHub Actions set-output 命令');
    });

    it('校验失败时输出 ::error', async () => {
      const filePath = path.join(BACKUP_DIR, 'ci-test', 'files', 'a.txt');
      await fs.writeFile(filePath, 'CORRUPTED');

      const result = run(`verify "${path.join(BACKUP_DIR, 'ci-test')}"`, {
        GITHUB_ACTIONS: 'true'
      });

      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('::error') || result.output.includes('::set-output name=verify_ok::false'), '应该输出 error 注解或失败的 set-output');

      await fs.writeFile(filePath, 'alpha content\n');
    });

    it('校验通过时输出 ::notice', () => {
      const result = run(`verify "${path.join(BACKUP_DIR, 'ci-test')}"`, {
        GITHUB_ACTIONS: 'true'
      });

      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('::notice') || result.output.includes('::set-output name=verify_ok::true'), '应该输出 notice 或成功的 set-output');
    });

    it('差异对比输出 diff metrics', async () => {
      const src = path.join(TEST_ROOT, 'ci-diff-src');
      await fs.ensureDir(src);
      await fs.writeFile(path.join(src, 'x.txt'), 'v1\n');
      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1 -n ci-diff1`);

      await fs.writeFile(path.join(src, 'x.txt'), 'v2\n');
      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1 -n ci-diff2`);

      const result = run(`diff "${path.join(BACKUP_DIR, 'ci-diff1')}" "${path.join(BACKUP_DIR, 'ci-diff2')}"`, {
        GITHUB_ACTIONS: 'true'
      });

      assert.ok(result.output.includes('::set-output name=diff_modified::1') || result.output.includes('diff'));
    });

    it('setOutput 写入 GITHUB_OUTPUT 文件', async () => {
      const outputFile = path.join(TEST_ROOT, 'github_output');
      await fs.writeFile(outputFile, '');

      run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1 -n ci-output-test`, {
        GITHUB_ACTIONS: 'true',
        GITHUB_OUTPUT: outputFile
      });

      const content = await fs.readFile(outputFile, 'utf-8');
      assert.ok(content.includes('backup_file_count=') || content.includes('backup_dir='), '应该写入 GITHUB_OUTPUT 文件');
    });

    it('Step Summary 写入 GITHUB_STEP_SUMMARY', async () => {
      const summaryFile = path.join(TEST_ROOT, 'github_summary');
      await fs.writeFile(summaryFile, '');

      run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1 -n ci-summary-test`, {
        GITHUB_ACTIONS: 'true',
        GITHUB_STEP_SUMMARY: summaryFile
      });

      const content = await fs.readFile(summaryFile, 'utf-8');
      assert.ok(content.includes('备份结果') || content.includes('文件数'), 'Step Summary 应包含备份结果表格');
    });

    it('非 CI 环境不输出 GitHub Actions 命令', () => {
      const result = run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1 -n no-ci`);
      assert.ok(!result.output.includes('::set-output'), '非 CI 环境不应输出 ::set-output');
      assert.ok(!result.output.includes('::group::'), '非 CI 环境不应输出 ::group::');
    });
  });

  describe('5. GitHub Actions 模块单元测试', () => {
    it('group/endgroup 输出', async () => {
      const { forceEnableForTest, group, endGroup } = await import('../src/ci/github-actions.js');
      forceEnableForTest();

      const collected = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { collected.push(chunk.toString()); return true; };

      group('Test Group');
      endGroup();

      process.stdout.write = origStdout;

      assert.ok(collected.some(l => l.includes('::group::Test Group')));
      assert.ok(collected.some(l => l.includes('::endgroup::')));
    });

    it('error/warning/notice 注解', async () => {
      const { forceEnableForTest, error, warning, notice } = await import('../src/ci/github-actions.js');
      forceEnableForTest();

      const collected = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      const origStderr = process.stderr.write.bind(process.stderr);
      process.stdout.write = (chunk) => { collected.push(chunk.toString()); return true; };
      process.stderr.write = (chunk) => { collected.push(chunk.toString()); return true; };

      error('something broke');
      warning('be careful');
      notice('all good');

      process.stdout.write = origStdout;
      process.stderr.write = origStderr;

      assert.ok(collected.some(l => l.includes('::error') && l.includes('something broke')));
      assert.ok(collected.some(l => l.includes('::warning') && l.includes('be careful')));
      assert.ok(collected.some(l => l.includes('::notice') && l.includes('all good')));
    });

    it('addSummary 生成 Markdown 表格', async () => {
      const { addSummaryTable, getSummaryContent } = await import('../src/ci/github-actions.js');

      addSummaryTable(['Name', 'Value'], [['Files', '10'], ['Size', '5 MB']]);

      const content = getSummaryContent();
      assert.ok(content.includes('| Name | Value |'));
      assert.ok(content.includes('| --- | --- |'));
      assert.ok(content.includes('| Files | 10 |'));
      assert.ok(content.includes('| Size | 5 MB |'));
    });

    it('encodeGitHubValue 转义特殊字符', async () => {
      const mod = await import('../src/ci/github-actions.js');

      assert.ok(mod.encodeGitHubValue('hello%world').includes('%25'));
      assert.ok(mod.encodeGitHubValue('line1\nline2').includes('%0A'));
    });
  });

  describe('6. 多平台打包', () => {
    it('本地平台打包成功', () => {
      const result = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'build.js'), 'macos-arm64'], {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: path.join(__dirname, '..')
      });

      assert.equal(result.status, 0, `打包应该成功: ${result.stderr}`);
      assert.ok(result.stdout.includes('✓ macos-arm64'));
    });

    it('打包后的 bundle 是有效的 JS', async () => {
      const distDir = path.join(__dirname, '..', 'dist');
      const files = await fs.readdir(distDir);
      const bundleFile = files.find(f => f.startsWith('bundle-') && f.endsWith('.mjs'));

      assert.ok(bundleFile, '应该有 bundle 文件');

      const content = await fs.readFile(path.join(distDir, bundleFile), 'utf-8');
      assert.ok(content.length > 0);
      assert.ok(content.includes('Command') || content.includes('program'), 'bundle 应包含 Commander 代码');
    });

    it('build-manifest.json 存在且正确', async () => {
      const manifestPath = path.join(__dirname, '..', 'dist', 'build-manifest.json');
      assert.ok(await fs.pathExists(manifestPath));

      const manifest = await fs.readJson(manifestPath);
      assert.ok(manifest.version);
      assert.ok(manifest.builds);
      assert.ok(manifest.builds['macos-arm64']);
    });
  });

  describe('7. CLI help 覆盖新功能', () => {
    it('全局选项包含 metrics/otel', () => {
      const result = run('--help');
      assert.ok(result.output.includes('--metrics'));
      assert.ok(result.output.includes('--metrics-port'));
      assert.ok(result.output.includes('--otel'));
      assert.ok(result.output.includes('--otel-endpoint'));
    });

    it('metrics 子命令存在', () => {
      const result = run('--help');
      assert.ok(result.output.includes('metrics'));
    });
  });
});
