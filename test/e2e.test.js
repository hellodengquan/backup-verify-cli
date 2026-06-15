import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_PATH = path.join(__dirname, '..', 'bin', 'backup-verify.js');
const TEST_ROOT = path.join('/tmp', 'bv-e2e-test-' + Date.now());
const SOURCE_DIR = path.join(TEST_ROOT, 'source');
const BACKUP_DIR = path.join(TEST_ROOT, 'backups');
const EXPORT_DIR = path.join(TEST_ROOT, 'exports');
const SCHEDULE_DIR = path.join(TEST_ROOT, 'schedules');

function run(args) {
  const result = spawnSync('node', [CLI_PATH, ...splitArgs(args)], {
    encoding: 'utf-8',
    timeout: 30000,
    cwd: TEST_ROOT
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
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

describe('端到端集成测试', () => {

  before(async () => {
    await fs.ensureDir(SOURCE_DIR);
    await fs.ensureDir(BACKUP_DIR);
    await fs.ensureDir(EXPORT_DIR);

    await fs.writeFile(path.join(SOURCE_DIR, 'a.txt'), 'alpha content\n');
    await fs.writeFile(path.join(SOURCE_DIR, 'b.txt'), 'beta content\n');
    await fs.writeFile(path.join(SOURCE_DIR, 'c.txt'), 'gamma content\n');
    await fs.ensureDir(path.join(SOURCE_DIR, 'sub'));
    await fs.writeFile(path.join(SOURCE_DIR, 'sub', 'd.txt'), 'delta content\n');

    const origDir = process.cwd();
    process.chdir(TEST_ROOT);
    await fs.ensureDir(SCHEDULE_DIR);
  });

  after(async () => {
    await fs.remove(TEST_ROOT);
  });

  describe('1. backup 命令', () => {
    it('全量备份成功', () => {
      const result = run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 1.0 -n full-backup`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('备份完成'));
      assert.ok(result.output.includes('复制文件数: 4'));

      const manifestPath = path.join(BACKUP_DIR, 'full-backup', 'manifest.json');
      assert.ok(fs.pathExistsSync(manifestPath));

      const manifest = fs.readJsonSync(manifestPath);
      assert.equal(Object.keys(manifest.files).length, 4);
      assert.ok(manifest.files['a.txt']);
      assert.ok(manifest.files['b.txt']);
      assert.ok(manifest.files['c.txt']);
      assert.ok(manifest.files['sub/d.txt']);
    });

    it('抽样备份成功', () => {
      const result = run(`backup "${SOURCE_DIR}" -o "${BACKUP_DIR}" -r 0.5 -n sample-backup`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('抽样比例: 50.0%'));

      const manifestPath = path.join(BACKUP_DIR, 'sample-backup', 'manifest.json');
      const manifest = fs.readJsonSync(manifestPath);
      assert.ok(Object.keys(manifest.files).length >= 1);
      assert.ok(Object.keys(manifest.files).length <= 4);
    });

    it('备份文件内容与源文件一致', async () => {
      const srcContent = await fs.readFile(path.join(SOURCE_DIR, 'a.txt'), 'utf-8');
      const bkContent = await fs.readFile(path.join(BACKUP_DIR, 'full-backup', 'files', 'a.txt'), 'utf-8');
      assert.equal(srcContent, bkContent);
    });

    it('备份清单包含正确的哈希值', async () => {
      const manifestPath = path.join(BACKUP_DIR, 'full-backup', 'manifest.json');
      const manifest = fs.readJsonSync(manifestPath);

      const aPath = path.join(BACKUP_DIR, 'full-backup', 'files', 'a.txt');
      const { hashFile } = await import('../src/utils/hash.js');
      const actualHash = await hashFile(aPath);
      assert.equal(manifest.files['a.txt'].hash, actualHash);
    });
  });

  describe('2. verify 命令', () => {
    it('完整备份校验通过', () => {
      const result = run(`verify "${path.join(BACKUP_DIR, 'full-backup')}" -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('备份完整性校验通过'));
    });

    it('校验检测到文件损坏', async () => {
      const filePath = path.join(BACKUP_DIR, 'full-backup', 'files', 'a.txt');
      await fs.writeFile(filePath, 'CORRUPTED DATA!!!');

      const result = run(`verify "${path.join(BACKUP_DIR, 'full-backup')}" -v`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('校验失败'));
      assert.ok(result.output.includes('备份完整性校验失败'));

      await fs.writeFile(filePath, 'alpha content\n');
    });

    it('校验检测到文件缺失', async () => {
      const filePath = path.join(BACKUP_DIR, 'full-backup', 'files', 'b.txt');
      const tempPath = filePath + '.bak';
      await fs.move(filePath, tempPath);

      const result = run(`verify "${path.join(BACKUP_DIR, 'full-backup')}" -v`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('缺失'));

      await fs.move(tempPath, filePath);
    });
  });

  describe('3. diff 命令 + JSON/CSV 导出', () => {
    let diffBackup1, diffBackup2;

    before(async () => {
      const diffSrc = path.join(TEST_ROOT, 'diff-source');
      await fs.ensureDir(diffSrc);
      await fs.writeFile(path.join(diffSrc, 'keep.txt'), 'unchanged\n');
      await fs.writeFile(path.join(diffSrc, 'modify.txt'), 'version1\n');
      await fs.writeFile(path.join(diffSrc, 'delete.txt'), 'will be deleted\n');

      diffBackup1 = path.join(BACKUP_DIR, 'diff-v1');
      run(`backup "${diffSrc}" -o "${BACKUP_DIR}" -r 1.0 -n diff-v1`);

      await fs.writeFile(path.join(diffSrc, 'modify.txt'), 'version2\n');
      await fs.writeFile(path.join(diffSrc, 'add.txt'), 'newly added\n');
      await fs.remove(path.join(diffSrc, 'delete.txt'));

      diffBackup2 = path.join(BACKUP_DIR, 'diff-v2');
      run(`backup "${diffSrc}" -o "${BACKUP_DIR}" -r 1.0 -n diff-v2`);
    });

    it('差异对比正确', () => {
      const result = run(`diff "${diffBackup1}" "${diffBackup2}"`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('新增文件: 1'));
      assert.ok(result.output.includes('删除文件: 1'));
      assert.ok(result.output.includes('修改文件: 1'));
    });

    it('JSON 导出正确', () => {
      const jsonPath = path.join(EXPORT_DIR, 'report.json');
      const result = run(`diff "${diffBackup1}" "${diffBackup2}" --export "${jsonPath}"`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('JSON 报告已导出'));

      assert.ok(fs.pathExistsSync(jsonPath));
      const report = fs.readJsonSync(jsonPath);

      assert.ok(report.generatedAt);
      assert.equal(report.summary.added, 1);
      assert.equal(report.summary.removed, 1);
      assert.equal(report.summary.modified, 1);

      assert.equal(report.added.length, 1);
      assert.ok(report.added[0].path.includes('add.txt'));

      assert.equal(report.removed.length, 1);
      assert.ok(report.removed[0].path.includes('delete.txt'));

      assert.equal(report.modified.length, 1);
      assert.ok(report.modified[0].path.includes('modify.txt'));
    });

    it('CSV 导出正确', () => {
      const csvPath = path.join(EXPORT_DIR, 'report.csv');
      const result = run(`diff "${diffBackup1}" "${diffBackup2}" --export "${csvPath}"`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('CSV 报告已导出'));

      assert.ok(fs.pathExistsSync(csvPath));
      const content = fs.readFileSync(csvPath, 'utf-8');
      const lines = content.trim().split('\n');

      assert.ok(lines[0].startsWith('type,path,'));
      assert.ok(content.includes('added,add.txt'));
      assert.ok(content.includes('removed,delete.txt'));
      assert.ok(content.includes('modified,modify.txt'));
      assert.ok(content.includes('unchanged,keep.txt'));
    });

    it('导出格式不支持时报错', () => {
      const result = run(`diff "${diffBackup1}" "${diffBackup2}" --export "${EXPORT_DIR}/report.xml"`);
      assert.notEqual(result.exitCode, 0);
    });
  });

  describe('4. incremental 增量校验', () => {
    const incBackup = path.join(BACKUP_DIR, 'inc-test');

    before(async () => {
      const src = path.join(TEST_ROOT, 'inc-source');
      await fs.ensureDir(src);
      await fs.writeFile(path.join(src, 'x.txt'), 'xxx\n');
      await fs.writeFile(path.join(src, 'y.txt'), 'yyy\n');
      run(`backup "${src}" -o "${BACKUP_DIR}" -r 1.0 -n inc-test`);
    });

    it('首次增量校验执行全量', () => {
      const result = run(`incremental "${incBackup}" -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('未发现上次校验快照，将执行全量校验'));
      assert.ok(result.output.includes('本次校验: 2'));

      const snapshotPath = path.join(incBackup, 'verify-snapshot.json');
      assert.ok(fs.pathExistsSync(snapshotPath));
    });

    it('第二次增量校验跳过未变更文件', () => {
      const result = run(`incremental "${incBackup}" -v`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('跳过（未变更）: 2'));
      assert.ok(result.output.includes('需要校验: 0'));
    });

    it('修改文件后增量校验只校验变更文件', async () => {
      await fs.writeFile(path.join(incBackup, 'files', 'x.txt'), 'modified xxx\n');

      const result = run(`incremental "${incBackup}" -v`);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('需要校验: 1'));
      assert.ok(result.output.includes('校验失败'));

      await fs.writeFile(path.join(incBackup, 'files', 'x.txt'), 'xxx\n');
    });

    it('修复后增量校验通过', async () => {
      const snapshotPath = path.join(incBackup, 'verify-snapshot.json');
      await fs.remove(snapshotPath);

      run(`incremental "${incBackup}" -v`);

      const result = run(`incremental "${incBackup}" -v`);
      assert.equal(result.exitCode, 0);
    });
  });

  describe('5. schedule 定时调度', () => {
    it('schedule list 无任务时显示空列表', () => {
      const result = run('schedule list');
      assert.equal(result.exitCode, 0);
    });

    it('schedule start --once 执行一次备份', () => {
      const schedBackup = path.join(BACKUP_DIR, 'schedule-test');
      const result = run(`schedule start -a backup --cron "0 2 * * *" -s "${SOURCE_DIR}" -o "${schedBackup}" --once`);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('任务执行完成'));
    });

    it('schedule start --once 执行一次增量校验', () => {
      const result = run(`schedule start -a incremental --cron "0 3 * * *" -s "${path.join(BACKUP_DIR, 'full-backup')}" --once`);
      assert.equal(result.exitCode, 0);
    });

    it('schedule list 显示已运行的任务', () => {
      const result = run('schedule list');
      assert.equal(result.exitCode, 0);
    });

    it('无效 cron 表达式报错', () => {
      const result = run(`schedule start -a backup --cron "invalid" -s "${SOURCE_DIR}" -o "${path.join(BACKUP_DIR, 'bad-cron')}" --once`);
      assert.notEqual(result.exitCode, 0);
    });
  });

  describe('6. 完整工作流', () => {
    it('备份 → 校验 → 修改源 → 再次备份 → 差异对比 → 导出报告', async () => {
      const wfSrc = path.join(TEST_ROOT, 'wf-source');
      await fs.ensureDir(wfSrc);
      await fs.writeFile(path.join(wfSrc, 'data.txt'), 'original data\n');
      await fs.writeFile(path.join(wfSrc, 'config.json'), '{"v":1}\n');

      const wfBackup = path.join(BACKUP_DIR, 'wf');
      run(`backup "${wfSrc}" -o "${wfBackup}" -r 1.0 -n step1`);

      const verify1 = run(`verify "${path.join(wfBackup, 'step1')}"`);
      assert.equal(verify1.exitCode, 0);

      const inc1 = run(`incremental "${path.join(wfBackup, 'step1')}" -v`);
      assert.equal(inc1.exitCode, 0);

      await fs.writeFile(path.join(wfSrc, 'data.txt'), 'modified data\n');
      await fs.writeFile(path.join(wfSrc, 'new.txt'), 'brand new file\n');
      await fs.remove(path.join(wfSrc, 'config.json'));

      run(`backup "${wfSrc}" -o "${wfBackup}" -r 1.0 -n step2`);

      const diffResult = run(`diff "${path.join(wfBackup, 'step1')}" "${path.join(wfBackup, 'step2')}"`);
      assert.ok(diffResult.output.includes('新增文件: 1'));
      assert.ok(diffResult.output.includes('删除文件: 1'));
      assert.ok(diffResult.output.includes('修改文件: 1'));

      const jsonReport = path.join(EXPORT_DIR, 'wf-report.json');
      const csvReport = path.join(EXPORT_DIR, 'wf-report.csv');

      run(`diff "${path.join(wfBackup, 'step1')}" "${path.join(wfBackup, 'step2')}" --export "${jsonReport}"`);
      run(`diff "${path.join(wfBackup, 'step1')}" "${path.join(wfBackup, 'step2')}" --export "${csvReport}"`);

      assert.ok(fs.pathExistsSync(jsonReport));
      assert.ok(fs.pathExistsSync(csvReport));

      const json = fs.readJsonSync(jsonReport);
      assert.equal(json.summary.added, 1);
      assert.equal(json.summary.removed, 1);
      assert.equal(json.summary.modified, 1);

      const csv = fs.readFileSync(csvReport, 'utf-8');
      assert.ok(csv.includes('added,'));
      assert.ok(csv.includes('removed,'));
      assert.ok(csv.includes('modified,'));

      const inc2 = run(`incremental "${path.join(wfBackup, 'step2')}" -v`);
      assert.equal(inc2.exitCode, 0);
    });
  });

  describe('7. CLI help 和版本', () => {
    it('显示帮助信息', () => {
      const result = run('--help');
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('backup'));
      assert.ok(result.output.includes('verify'));
      assert.ok(result.output.includes('diff'));
      assert.ok(result.output.includes('incremental'));
      assert.ok(result.output.includes('remote'));
      assert.ok(result.output.includes('schedule'));
    });

    it('显示版本号', () => {
      const result = run('--version');
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('1.0.0'));
    });

    it('子命令帮助信息', () => {
      const result = run('backup --help');
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('--sample-rate'));

      const result2 = run('diff --help');
      assert.ok(result2.output.includes('--export'));

      const result3 = run('incremental --help');
      assert.ok(result3.output.includes('增量'));

      const result4 = run('remote --help');
      assert.ok(result4.output.includes('pull'));

      const result5 = run('schedule --help');
      assert.ok(result5.output.includes('start'));
    });
  });
});
