import { Client } from 'ssh2';
import fs from 'fs-extra';
import path from 'path';
import { createWriteStream } from 'fs';
import logger from '../utils/logger.js';

export class SFTPAdapter {
  constructor(config) {
    this.config = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      password: config.password || undefined,
      privateKey: config.privateKey || undefined,
      passphrase: config.passphrase || undefined
    };
    this.remotePath = config.remotePath || '/backup';
    this.conn = null;
    this.sftp = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const conn = new Client();

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          this.conn = conn;
          this.sftp = sftp;
          logger.info(`SFTP 已连接: ${this.config.host}:${this.config.port}`);
          resolve();
        });
      });

      conn.on('error', reject);

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
      logger.info('SFTP 连接已关闭');
    }
  }

  async listFiles(remotePath) {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);
        resolve(list.map(item => ({
          name: item.filename,
          path: `${remotePath}/${item.filename}`,
          size: item.attrs.size,
          isDirectory: (item.attrs.mode & 0o40000) !== 0,
          mtime: new Date(item.attrs.mtime * 1000).toISOString()
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
    await fs.ensureDir(path.dirname(localPath));

    return new Promise((resolve, reject) => {
      const writeStream = createWriteStream(localPath);
      const readStream = this.sftp.createReadStream(remotePath);

      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('close', () => resolve(localPath));

      readStream.pipe(writeStream);
    });
  }

  async downloadManifest(backupName) {
    const manifestPath = `${this.remotePath}/${backupName}/manifest.json`;
    const buffer = await this.readFile(manifestPath);
    return JSON.parse(buffer.toString('utf-8'));
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
    const backupDir = path.join(localDir, backupName);
    await fs.ensureDir(backupDir);

    const allFiles = await this.walkRemoteDir(remoteBackupPath);
    const prefix = remoteBackupPath + '/';

    let downloaded = 0;
    for (const file of allFiles) {
      const relativePath = file.path.slice(prefix.length);
      if (!relativePath) continue;

      const localPath = path.join(backupDir, relativePath);
      await this.downloadFile(file.path, localPath);
      downloaded++;

      if (onProgress) {
        onProgress(downloaded, allFiles.length, relativePath);
      }
    }

    logger.success(`已下载 ${downloaded} 个文件到 ${backupDir}`);
    return backupDir;
  }

  async stat(remotePath) {
    return new Promise((resolve, reject) => {
      this.sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        resolve({
          size: stats.size,
          mtime: new Date(stats.mtime * 1000).toISOString(),
          isDirectory: stats.isDirectory()
        });
      });
    });
  }
}
