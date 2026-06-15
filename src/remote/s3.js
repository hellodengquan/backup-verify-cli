import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs-extra';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import logger from '../utils/logger.js';

export class S3Adapter {
  constructor(config) {
    this.client = new S3Client({
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
      },
      endpoint: config.endpoint || undefined,
      forcePathStyle: config.forcePathStyle || false
    });
    this.bucket = config.bucket;
    this.prefix = config.prefix || '';
  }

  async listObjects(prefix = '') {
    const fullPrefix = this.prefix ? `${this.prefix}/${prefix}` : prefix;
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: fullPrefix
    });

    const response = await this.client.send(command);
    return (response.Contents || []).map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified,
      etag: obj.ETag
    }));
  }

  async downloadFile(key, localPath) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key
    });

    const response = await this.client.send(command);
    await fs.ensureDir(path.dirname(localPath));

    if (response.Body && typeof response.Body === 'object' && 'pipe' in response.Body) {
      const writeStream = createWriteStream(localPath);
      await pipeline(response.Body, writeStream);
    } else {
      const buffer = await response.Body.transformToByteArray();
      await fs.writeFile(localPath, Buffer.from(buffer));
    }

    return localPath;
  }

  async downloadManifest(backupName) {
    const manifestKey = this.prefix
      ? `${this.prefix}/${backupName}/manifest.json`
      : `${backupName}/manifest.json`;

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: manifestKey
    });

    const response = await this.client.send(command);
    const buffer = await response.Body.transformToByteArray();
    return JSON.parse(Buffer.from(buffer).toString('utf-8'));
  }

  async downloadBackup(backupName, localDir, options = {}) {
    const { onProgress } = options;
    const prefix = this.prefix
      ? `${this.prefix}/${backupName}/`
      : `${backupName}/`;

    const objects = await this.listObjects(`${backupName}/`);
    const backupDir = path.join(localDir, backupName);
    await fs.ensureDir(backupDir);

    let downloaded = 0;
    for (const obj of objects) {
      const relativePath = obj.key.slice(prefix.length);
      if (!relativePath) continue;

      const localPath = path.join(backupDir, relativePath);
      await this.downloadFile(obj.key, localPath);
      downloaded++;

      if (onProgress) {
        onProgress(downloaded, objects.length, relativePath);
      }
    }

    logger.success(`已下载 ${downloaded} 个文件到 ${backupDir}`);
    return backupDir;
  }

  async getFileInfo(key) {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key
    });

    const response = await this.client.send(command);
    return {
      size: response.ContentLength,
      lastModified: response.LastModified,
      etag: response.ETag
    };
  }
}
