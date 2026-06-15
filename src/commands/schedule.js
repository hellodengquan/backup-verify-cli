import fs from 'fs-extra';
import path from 'path';
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { backupCommand } from './backup.js';
import { verifyCommand } from './verify.js';
import { incrementalVerifyCommand } from './incremental.js';

const SCHEDULES_DIR = 'schedules';

export async function scheduleStartCommand(options) {
  const {
    action,
    cron: cronExpr,
    source,
    output,
    sampleRate = 0.1,
    exclude = '',
    name,
    verbose = false,
    incremental = false,
    once = false
  } = options;

  logger.section('定时任务启动');
  logger.info(`动作: ${action}`);
  logger.info(`Cron 表达式: ${cronExpr}`);

  if (!cron.validate(cronExpr)) {
    logger.error(`无效的 Cron 表达式: ${cronExpr}`);
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
    startedAt: new Date().toISOString(),
    runs: []
  };

  const runAction = async () => {
    const runStart = new Date().toISOString();
    logger.section(`定时任务触发 [${action}]`);
    logger.info(`任务 ID: ${scheduleId}`);
    logger.info(`触发时间: ${runStart}`);

    try {
      let result;

      if (action === 'backup') {
        result = await backupCommand(source, {
          output,
          sampleRate,
          exclude: exclude ? exclude.split(',') : ['node_modules', '.git', 'dist', 'build'],
          name: name || `auto-${Date.now()}`,
          verbose
        });
      } else if (action === 'verify') {
        result = await verifyCommand(source, { verbose, full: true });
      } else if (action === 'incremental') {
        result = await incrementalVerifyCommand(source, { verbose, full: true });
      } else {
        logger.error(`未知动作: ${action}`);
        return;
      }

      const runEnd = new Date().toISOString();
      scheduleInfo.runs.push({
        startedAt: runStart,
        finishedAt: runEnd,
        success: true,
        result: action === 'verify' || action === 'incremental' ? result.isOk : true
      });

      logger.success(`任务执行完成: ${action}`);
    } catch (err) {
      const runEnd = new Date().toISOString();
      scheduleInfo.runs.push({
        startedAt: runStart,
        finishedAt: runEnd,
        success: false,
        error: err.message
      });

      logger.error(`任务执行失败: ${err.message}`);
    }

    await saveScheduleInfo(scheduleInfo);
  };

  if (once) {
    await runAction();
    return;
  }

  logger.info('正在注册 Cron 任务...');

  const task = cron.schedule(cronExpr, runAction, {
    scheduled: true
  });

  logger.success(`Cron 任务已注册: ${cronExpr}`);
  logger.info('按 Ctrl+C 停止调度');

  process.on('SIGINT', () => {
    logger.info('正在停止调度...');
    task.stop();
    scheduleInfo.stoppedAt = new Date().toISOString();
    saveScheduleInfo(scheduleInfo).then(() => {
      logger.success('调度已停止');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    task.stop();
    scheduleInfo.stoppedAt = new Date().toISOString();
    saveScheduleInfo(scheduleInfo).then(() => {
      process.exit(0);
    });
  });

  await saveScheduleInfo(scheduleInfo);
}

export async function scheduleListCommand(options = {}) {
  logger.section('定时任务列表');

  if (!await fs.pathExists(SCHEDULES_DIR)) {
    logger.info('暂无定时任务');
    return [];
  }

  const files = await fs.readdir(SCHEDULES_DIR);
  const scheduleFiles = files.filter(f => f.startsWith('schedule-') && f.endsWith('.json'));

  if (scheduleFiles.length === 0) {
    logger.info('暂无定时任务');
    return [];
  }

  const schedules = [];
  for (const file of scheduleFiles) {
    const info = await fs.readJson(path.join(SCHEDULES_DIR, file));
    schedules.push(info);
    logger.listItem(`ID: ${info.id}`);
    console.log(`     动作: ${info.action}`);
    console.log(`     Cron: ${info.cron}`);
    console.log(`     启动时间: ${info.startedAt}`);
    console.log(`     运行次数: ${info.runs.length}`);
    if (info.stoppedAt) {
      console.log(`     停止时间: ${info.stoppedAt}`);
    }
  }

  return schedules;
}

export async function scheduleRemoveCommand(scheduleId) {
  logger.section('删除定时任务');
  logger.info(`任务 ID: ${scheduleId}`);

  const filePath = path.join(SCHEDULES_DIR, `${scheduleId}.json`);

  if (!await fs.pathExists(filePath)) {
    logger.error(`任务不存在: ${scheduleId}`);
    process.exit(1);
  }

  await fs.remove(filePath);
  logger.success(`已删除任务: ${scheduleId}`);
}

async function saveScheduleInfo(info) {
  await fs.ensureDir(SCHEDULES_DIR);
  const filePath = path.join(SCHEDULES_DIR, `${info.id}.json`);
  await fs.writeJson(filePath, info, { spaces: 2 });
}
