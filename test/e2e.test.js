import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_PATH = path.join(__dirname, '..', 'bin', 'backup-verify.js');
const TEST_ROOT = path.join('/tmp', 'bv-e2e-v2-' + Date.now());
const SOURCE_DIR = path.join(TEST_ROOT, 'source');
const BACKUP_DIR = path.join(TEST_ROOT, 'backups');
const EXPORT_DIR = path.join(TEST_ROOT, 'exports');
const LOG_DIR = path.join(TEST_ROOT, 'logs');

function run(args, extraEnv = {}) {
  const result = spawnSync('node', [CLI_PATH, ...splitArgs(args)], {
    encoding: 'utf-8',
    timeout: 60000,
    cwd: TEST_ROOT,
    env: { ...process.env, ...extraEnv }
  });
  const output = (result.stdout || '') + (result.stderr || '');
  return { output, exitCode: result.status || 0 };
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

describe('端到端集成测试 v2', () => {

  before(async () => {
    await fs.ensureDir(SOURCE_DIR);
    await fs.ensureDir(BACKUP_DIR);
    await fs.ensureDir(EXPORT_DIR);
    await fs.ensureDir(LOG_DIR);

    await fs.writeFile(path.join(SOURCE_DIR, 'a.txt'), 'alpha content\n');
    await fs.writeFile(path.join(SOURCE_DIR, 'b.txt'), 'beta content\n');
    await fs.writeFile(path.join(SOURCE_DIR, 'c.txt'), 'gamma content\n');
    await fs.ensureDir(path.join(SOURCE_DIR, 'sub'));
    await fs.writeFile(path.join(SOURCE_DIR, 'sub', 'd.txt'), 'delta content\n');
  });

  after(async () => {
    await fs.remove(TEST_ROOT);
  });

  describe('1. backup 命令', () => {
    it('全量备份成功', () => {
      const result = run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1.0 -n full-backup`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('备份完成'));

      const manifest = fs.readJsonSync(path.join(BACKUP_DIR, 'full-backup', 'manifest.json'));
      assert.equal(Object.keys(manifest.files).length, 4);
    });

    it('备份文件内容与源文件一致', async () => {
      const srcContent = await fs.readFile(path.join(SOURCE_DIR, 'a.txt'), 'utf-8');
      const bkContent = await fs.readFile(path.join(BACKUP_DIR, 'full-backup', 'files', 'a.txt'), 'utf-8');
      assert.equal(srcContent, bkContent);
    });
  });

  describe('2. verify 命令', () => {
    it('校验通过', () => {
      const result = run(`verify "${path.join(BACKUP_DIR, 'full-backup')}"`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('备份完整性校验通过'));
    });

    it('检测到文件损坏', async () => {
      const filePath = path.join(BACKUP_DIR, 'full-backup', 'files', 'a.txt');
      await fs.writeFile(filePath, 'CORRUPTED');
      const result = run(`verify "${path.join(BACKUP_DIR, 'full-backup')}"`);
      assert.equal(result.exitCode, 1);
      await fs.writeFile(filePath, 'alpha content\n');
    });
  });

  describe('3. diff + JSON/CSV 导出', () => {
    let bk1, bk2;

    before(async () => {
      const src = path.join(TEST_ROOT, 'diff-src');
      await fs.ensureDir(src);
      await fs.writeFile(path.join(src, 'keep.txt'), 'unchanged\n');
      await fs.writeFile(path.join(src, 'modify.txt'), 'v1\n');
      await fs.writeFile(path.join(src, 'delete.txt'), 'will be deleted\n');

      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1.0 -n diff-v1`);
      bk1 = path.join(BACKUP_DIR, 'diff-v1');

      await fs.writeFile(path.join(src, 'modify.txt'), 'v2\n');
      await fs.writeFile(path.join(src, 'add.txt'), 'newly added\n');
      await fs.remove(path.join(src, 'delete.txt'));

      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1.0 -n diff-v2`);
      bk2 = path.join(BACKUP_DIR, 'diff-v2');
    });

    it('差异对比正确', () => {
      const result = run(`diff "${bk1}" "${bk2}"`);
      assert.ok(result.output.includes('新增文件: 1'));
      assert.ok(result.output.includes('修改文件: 1'));
    });

    it('JSON 导出', () => {
      const jsonPath = path.join(EXPORT_DIR, 'report.json');
      const result = run(`diff "${bk1}" "${bk2}" --export "${jsonPath}"`);
      assert.equal(result.exitCode, 0);
      const report = fs.readJsonSync(jsonPath);
      assert.equal(report.summary.added, 1);
      assert.equal(report.summary.modified, 1);
    });

    it('CSV 导出', () => {
      const csvPath = path.join(EXPORT_DIR, 'report.csv');
      run(`diff "${bk1}" "${bk2}" --export "${csvPath}"`);
      const content = fs.readFileSync(csvPath, 'utf-8');
      assert.ok(content.includes('added,'));
      assert.ok(content.includes('modified,'));
    });
  });

  describe('4. incremental 增量校验', () => {
    const incBackup = path.join(BACKUP_DIR, 'inc-test');

    before(async () => {
      const src = path.join(TEST_ROOT, 'inc-src');
      await fs.ensureDir(src);
      await fs.writeFile(path.join(src, 'x.txt'), 'xxx\n');
      await fs.writeFile(path.join(src, 'y.txt'), 'yyy\n');
      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1.0 -n inc-test`);
    });

    it('首次全量', () => {
      const result = run(`incremental "${incBackup}" -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('未发现上次校验快照'));
    });

    it('跳过未变更文件', () => {
      const result = run(`incremental "${incBackup}" -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('跳过'));
    });
  });

  describe('5. chunked-verify 分块校验', () => {
    const chunkBackup = path.join(BACKUP_DIR, 'chunk-test');

    before(async () => {
      const src = path.join(TEST_ROOT, 'chunk-src');
      await fs.ensureDir(src);
      await fs.writeFile(path.join(src, 'small.txt'), 'small content\n');
      const bigBuf = Buffer.alloc(12 * 1024, 'A');
      await fs.writeFile(path.join(src, 'big.bin'), bigBuf);
      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1.0 -n chunk-test`);
    });

    it('分块校验通过', () => {
      const result = run(`chunked-verify "${chunkBackup}" --chunk-size 4096 -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('分块校验通过'));
      assert.ok(result.output.includes('3 块'));
    });

    it('断点续传 - 第二次运行跳过已完成文件', () => {
      const result = run(`chunked-verify "${chunkBackup}" -v`);
      assert.equal(result.exitCode, 0);
    });

    it('检测到文件损坏', async () => {
      const filePath = path.join(chunkBackup, 'files', 'small.txt');
      await fs.writeFile(filePath, 'CORRUPTED');
      const result = run(`chunked-verify "${chunkBackup}" --no-resume`);
      assert.equal(result.exitCode, 1);
      await fs.writeFile(filePath, 'small content\n');
    });
  });

  describe('6. multi-backup 多源并发', () => {
    const multiOut = path.join(BACKUP_DIR, 'multi-out');
    let src1, src2, src3;

    before(async () => {
      src1 = path.join(TEST_ROOT, 'multi-src1');
      src2 = path.join(TEST_ROOT, 'multi-src2');
      src3 = path.join(TEST_ROOT, 'multi-src3');

      await fs.ensureDir(src1);
      await fs.ensureDir(src2);
      await fs.ensureDir(src3);

      await fs.writeFile(path.join(src1, 'a1.txt'), 'source1-a\n');
      await fs.writeFile(path.join(src1, 'b1.txt'), 'source1-b\n');
      await fs.writeFile(path.join(src2, 'a2.txt'), 'source2-a\n');
      await fs.writeFile(path.join(src2, 'b2.txt'), 'source2-b\n');
      await fs.writeFile(path.join(src3, 'a3.txt'), 'source3-a\n');
      await fs.writeFile(path.join(src3, 'b3.txt'), 'source3-b\n');
    });

    it('多源并发备份成功', () => {
      const result = run(`multi-backup "${src1}" "${src2}" "${src3}" -o "${multiOut}" -r 1 -c 2 -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('成功: 3'));

      const name1 = path.basename(src1);
      const name2 = path.basename(src2);
      const name3 = path.basename(src3);

      assert.ok(fs.pathExistsSync(path.join(multiOut, name1, 'manifest.json')));
      assert.ok(fs.pathExistsSync(path.join(multiOut, name2, 'manifest.json')));
      assert.ok(fs.pathExistsSync(path.join(multiOut, name3, 'manifest.json')));
    });

    it('各源文件内容正确', async () => {
      const name1 = path.basename(src1);
      const name2 = path.basename(src2);

      const content = await fs.readFile(path.join(multiOut, name1, 'files', 'a1.txt'), 'utf-8');
      assert.equal(content, 'source1-a\n');

      const content2 = await fs.readFile(path.join(multiOut, name2, 'files', 'a2.txt'), 'utf-8');
      assert.equal(content2, 'source2-a\n');
    });

    it('并发限流 - 串行执行（concurrency=1）', () => {
      const out2 = path.join(BACKUP_DIR, 'multi-serial');
      const result = run(`multi-backup "${src1}" "${src2}" -o "${out2}" -r 1 -c 1`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('成功: 2'));
    });

    it('包含不存在的源 - 部分失败', () => {
      const out3 = path.join(BACKUP_DIR, 'multi-partial');
      const result = run(`multi-backup "${src1}" "/nonexistent/path" -o "${out3}" -r 1 -c 2 --retries 0`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('失败: 1'));
    });

    it('失败重试', () => {
      const out4 = path.join(BACKUP_DIR, 'multi-retry');
      const result = run(`multi-backup "${src1}" "/nonexistent/path" -o "${out4}" -r 1 -c 2 --retries 2`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('重试'));
    });
  });

  describe('7. 结构化日志可观察性', () => {
    it('JSON 日志格式', () => {
      const result = run(`--log-json verify "${path.join(BACKUP_DIR, 'full-backup')}"`);
      assert.equal(result.exitCode, 0);

      const lines = result.output.trim().split('\n').filter(l => l.startsWith('{'));
      assert.ok(lines.length > 0, '应该有 JSON 日志输出');

      const firstLine = JSON.parse(lines[0]);
      assert.ok(firstLine.timestamp);
      assert.ok(firstLine.level);
      assert.ok(firstLine.message);
    });

    it('日志级别过滤', () => {
      const result = run(`--log-level error --log-json verify "${path.join(BACKUP_DIR, 'full-backup')}"`);
      assert.equal(result.exitCode, 0);

      const lines = result.output.trim().split('\n').filter(l => l.startsWith('{'));
      for (const line of lines) {
        const entry = JSON.parse(line);
        assert.equal(entry.level, 'error', `应该只有 error 级别日志，但发现: ${entry.level}`);
      }
    });

    it('日志输出到文件', async () => {
      const logFile = path.join(LOG_DIR, 'test.log');
      run(`--log-file "${logFile}" verify "${path.join(BACKUP_DIR, 'full-backup')}"`);

      assert.ok(await fs.pathExists(logFile), '日志文件应该存在');

      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      assert.ok(lines.length > 0, '日志文件应该有内容');

      const firstLine = JSON.parse(lines[0]);
      assert.ok(firstLine.timestamp);
      assert.ok(firstLine.level);
    });

    it('JSON 日志包含 correlationId（多源备份）', () => {
      const src = path.join(TEST_ROOT, 'log-src');
      if (!fs.pathExistsSync(src)) {
        fs.ensureDirSync(src);
        fs.writeFileSync(path.join(src, 'test.txt'), 'log test\n');
      }

      const result = run(`--log-json multi-backup "${src}" -o "${path.join(BACKUP_DIR, 'log-out')}" -r 1`);
      const lines = result.output.trim().split('\n').filter(l => l.startsWith('{'));
      const withCorrelation = lines.filter(l => {
        try {
          const entry = JSON.parse(l);
          return entry.correlationId;
        } catch { return false; }
      });
      assert.ok(withCorrelation.length > 0, '应该有包含 correlationId 的日志');
    });
  });

  describe('8. ConcurrencyPool 和 retryWithBackoff 单元级测试', () => {
    it('并发池限制并发数', async () => {
      const { ConcurrencyPool } = await import('../src/utils/concurrency.js');
      let maxConcurrent = 0;
      let current = 0;

      const pool = new ConcurrencyPool(2);

      const tasks = [];
      for (let i = 0; i < 6; i++) {
        tasks.push(pool.add(async () => {
          current++;
          if (current > maxConcurrent) maxConcurrent = current;
          await new Promise(r => setTimeout(r, 50));
          current--;
          return i;
        }, `task-${i}`));
      }

      await Promise.all(tasks);
      assert.ok(maxConcurrent <= 2, `最大并发不应超过 2，实际: ${maxConcurrent}`);
    });

    it('重试机制 - 最终成功', async () => {
      const { retryWithBackoff } = await import('../src/utils/concurrency.js');
      let attempts = 0;

      const result = await retryWithBackoff(async () => {
        attempts++;
        if (attempts < 3) throw new Error('not yet');
        return 'ok';
      }, { maxRetries: 3, baseDelay: 10, label: 'test-retry' });

      assert.equal(result, 'ok');
      assert.equal(attempts, 3);
    });

    it('重试机制 - 全部失败', async () => {
      const { retryWithBackoff } = await import('../src/utils/concurrency.js');
      let attempts = 0;

      await assert.rejects(
        retryWithBackoff(async () => {
          attempts++;
          throw new Error('always fail');
        }, { maxRetries: 2, baseDelay: 10, label: 'test-retry-fail' }),
        /always fail/
      );
      assert.equal(attempts, 3);
    });

    it('并发池收集结果', async () => {
      const { ConcurrencyPool } = await import('../src/utils/concurrency.js');
      const pool = new ConcurrencyPool(3);

      await Promise.all([
        pool.add(async () => 'a', 'task-a'),
        pool.add(async () => { throw new Error('boom'); }, 'task-b'),
        pool.add(async () => 'c', 'task-c')
      ].map(p => p.catch(() => {})));

      const results = pool.getResults();
      assert.equal(results.length, 3);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
      assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    });
  });

  describe('9. chunked hash 单元级测试', () => {
    it('分块 hash 与整文件 hash 一致', async () => {
      const { hashFileChunked } = await import('../src/utils/chunk.js');
      const { hashFile } = await import('../src/utils/hash.js');

      const testFile = path.join(SOURCE_DIR, 'a.txt');
      const fullHash = await hashFile(testFile);

      const chunked = await hashFileChunked(testFile, { chunkSize: 4 });
      assert.equal(chunked.hash, fullHash, '分块hash应与整文件hash一致');
      assert.ok(chunked.totalChunks > 1, '小分块应该产生多个块');
    });

    it('大分块 fallback 到整文件 hash', async () => {
      const { hashFileChunked } = await import('../src/utils/chunk.js');
      const { hashFile } = await import('../src/utils/hash.js');

      const testFile = path.join(SOURCE_DIR, 'a.txt');
      const fullHash = await hashFile(testFile);

      const chunked = await hashFileChunked(testFile, { chunkSize: 1024 * 1024 });
      assert.equal(chunked.hash, fullHash);
      assert.equal(chunked.totalChunks, 1);
    });

    it('断点续传进度持久化', async () => {
      const { verifyChunked } = await import('../src/utils/chunk.js');

      const src = path.join(TEST_ROOT, 'resume-src');
      await fs.ensureDir(src);
      await fs.writeFile(path.join(src, 'f1.txt'), 'file1\n');
      await fs.writeFile(path.join(src, 'f2.txt'), 'file2\n');

      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1 -n resume-test`);
      const bkDir = path.join(BACKUP_DIR, 'resume-test');

      await verifyChunked(bkDir, { chunkSize: 4096, verbose: true, resume: true });

      const progressPath = path.join(bkDir, 'chunk-progress.json');
      assert.ok(!await fs.pathExists(progressPath), '校验通过后应清除进度文件');
    });
  });

  describe('10. StructuredLogger 单元级测试', () => {
    it('日志级别过滤', async () => {
      const { StructuredLogger } = await import('../src/utils/logger.js');
      const log = new StructuredLogger();
      log.configure({ level: 'warn', json: true });

      const collected = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      const origStderr = process.stderr.write.bind(process.stderr);
      process.stdout.write = (chunk) => { collected.push(chunk.toString()); return true; };
      process.stderr.write = (chunk) => { collected.push(chunk.toString()); return true; };

      log.info('should be filtered');
      log.warn('should pass');
      log.error('should also pass');

      process.stdout.write = origStdout;
      process.stderr.write = origStderr;

      assert.equal(collected.length, 2);
      assert.ok(JSON.parse(collected[0]).level === 'warn');
      assert.ok(JSON.parse(collected[1]).level === 'error');
    });

    it('correlationId 传递', async () => {
      const { StructuredLogger } = await import('../src/utils/logger.js');
      const log = new StructuredLogger();
      log.configure({ json: true });

      log.setCorrelationId('test-123');

      const collected = [];
      const origStdout = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { collected.push(chunk.toString()); return true; };

      log.info('with correlation');

      process.stdout.write = origStdout;

      const entry = JSON.parse(collected[0]);
      assert.equal(entry.correlationId, 'test-123');
    });
  });

  describe('11. 完整工作流（含新功能）', () => {
    it('多源备份 → 分块校验 → 增量校验 → 差异导出 → JSON日志', async () => {
      const srcA = path.join(TEST_ROOT, 'wf-a');
      const srcB = path.join(TEST_ROOT, 'wf-b');
      await fs.ensureDir(srcA);
      await fs.ensureDir(srcB);
      await fs.writeFile(path.join(srcA, 'data.txt'), 'original A\n');
      await fs.writeFile(path.join(srcB, 'data.txt'), 'original B\n');

      const wfOut = path.join(BACKUP_DIR, 'wf');
      const logFile = path.join(LOG_DIR, 'workflow.log');

      const multiResult = run(`--log-file "${logFile}" multi-backup "${srcA}" "${srcB}" -o "${wfOut}" -r 1 -c 2`);
      assert.equal(multiResult.exitCode, 0);

      const backupA = path.join(wfOut, 'wf-a');
      assert.ok(await fs.pathExists(backupA), `备份目录 ${backupA} 应该存在`);

      const chunkedResult = run(`chunked-verify "${backupA}" -v`);
      assert.equal(chunkedResult.exitCode, 0);

      const incResult = run(`incremental "${backupA}" -v`);
      assert.equal(incResult.exitCode, 0);

      await fs.writeFile(path.join(srcA, 'data.txt'), 'modified A\n');
      await fs.writeFile(path.join(srcA, 'new.txt'), 'brand new\n');

      run(`backup "${srcA}" -o "${wfOut}" -r 1 -n src-a-v2`);

      const diffResult = run(`diff "${backupA}" "${path.join(wfOut, 'src-a-v2')}" --export "${path.join(EXPORT_DIR, 'wf-report.json')}"`);
      assert.ok(diffResult.output.includes('修改文件: 1'));

      assert.ok(await fs.pathExists(logFile));
      const logContent = await fs.readFile(logFile, 'utf-8');
      const logLines = logContent.trim().split('\n');
      assert.ok(logLines.length > 0);
      const firstLog = JSON.parse(logLines[0]);
      assert.ok(firstLog.timestamp);
    });
  });

  describe('12. CLI help', () => {
    it('显示新命令', () => {
      const result = run('--help');
      assert.ok(result.output.includes('chunked-verify'));
      assert.ok(result.output.includes('multi-backup'));
      assert.ok(result.output.includes('--log-json'));
      assert.ok(result.output.includes('--log-level'));
      assert.ok(result.output.includes('--log-file'));
    });

    it('子命令帮助', () => {
      const r1 = run('chunked-verify --help');
      assert.ok(r1.output.includes('--chunk-size'));
      assert.ok(r1.output.includes('--no-resume'));

      const r2 = run('multi-backup --help');
      assert.ok(r2.output.includes('--concurrency'));
      assert.ok(r2.output.includes('--retries'));
    });
  });
});
