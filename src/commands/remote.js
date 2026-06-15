import fs from 'fs-extra';
import path from 'path';
import logger from '../utils/logger.js';
import { S3Adapter } from '../remote/s3.js';
import { SFTPAdapter } from '../remote/sftp.js';

export async function remotePullCommand(options) {
  const {
    type,
    output,
    name,
    config: configPath,
    verbose = false
  } = options;

  logger.section('远端备份拉取');
  logger.info(`远端类型: ${type}`);
  logger.info(`输出目录: ${output}`);
  logger.info(`备份名称: ${name}`);

  const config = await loadConfig(configPath);

  if (type === 's3') {
    await pullFromS3(config.s3, name, output, verbose);
  } else if (type === 'sftp') {
    await pullFromSFTP(config.sftp, name, output, verbose);
  } else {
    logger.error(`不支持的远端类型: ${type}，仅支持 s3 和 sftp`);
    process.exit(1);
  }
}

export async function remoteManifestCommand(options) {
  const {
    type,
    name,
    config: configPath
  } = options;

  logger.section('远端清单读取');
  logger.info(`远端类型: ${type}`);
  logger.info(`备份名称: ${name}`);

  const config = await loadConfig(configPath);

  let manifest;

  if (type === 's3') {
    const adapter = new S3Adapter(config.s3);
    manifest = await adapter.downloadManifest(name);
  } else if (type === 'sftp') {
    const adapter = new SFTPAdapter(config.sftp);
    await adapter.connect();
    try {
      manifest = await adapter.downloadManifest(name);
    } finally {
      await adapter.disconnect();
    }
  } else {
    logger.error(`不支持的远端类型: ${type}`);
    process.exit(1);
  }

  logger.section('清单内容');
  logger.info(`备份名称: ${manifest.backupName || '未知'}`);
  logger.info(`创建时间: ${manifest.createdAt}`);
  logger.info(`文件数量: ${Object.keys(manifest.files).length}`);

  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

async function pullFromS3(config, backupName, outputDir, verbose) {
  if (!config) {
    logger.error('缺少 S3 配置，请检查配置文件');
    process.exit(1);
  }

  const adapter = new S3Adapter(config);

  logger.info('正在从 S3 下载备份...');
  const backupDir = await adapter.downloadBackup(backupName, outputDir, {
    onProgress(current, total, file) {
      if (verbose) {
        logger.debug(`下载进度: ${current}/${total} - ${file}`, true);
      } else if (current % 10 === 0 || current === total) {
        logger.info(`下载进度: ${current}/${total}`);
      }
    }
  });

  logger.section('下载完成');
  logger.success(`备份已下载到: ${backupDir}`);
  return backupDir;
}

async function pullFromSFTP(config, backupName, outputDir, verbose) {
  if (!config) {
    logger.error('缺少 SFTP 配置，请检查配置文件');
    process.exit(1);
  }

  const adapter = new SFTPAdapter(config);

  await adapter.connect();

  try {
    logger.info('正在从 SFTP 下载备份...');
    const backupDir = await adapter.downloadBackup(backupName, outputDir, {
      onProgress(current, total, file) {
        if (verbose) {
          logger.debug(`下载进度: ${current}/${total} - ${file}`, true);
        } else if (current % 10 === 0 || current === total) {
          logger.info(`下载进度: ${current}/${total}`);
        }
      }
    });

    logger.section('下载完成');
    logger.success(`备份已下载到: ${backupDir}`);
    return backupDir;
  } finally {
    await adapter.disconnect();
  }
}

async function loadConfig(configPath) {
  if (!configPath) {
    const defaultPaths = [
      'backup-verify.config.json',
      'backup-verify.config.jsonc',
      '.backup-verify.json'
    ];

    for (const p of defaultPaths) {
      if (await fs.pathExists(p)) {
        configPath = p;
        break;
      }
    }

    if (!configPath) {
      logger.error('未找到配置文件，请使用 --config 指定配置文件路径');
      process.exit(1);
    }
  }

  if (!await fs.pathExists(configPath)) {
    logger.error(`配置文件不存在: ${configPath}`);
    process.exit(1);
  }

  const raw = await fs.readFile(configPath, 'utf-8');
  const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(cleaned);
}
