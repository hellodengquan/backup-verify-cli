import fs from 'fs-extra';
import path from 'path';
import { hashFile } from './hash.js';

export async function walkDir(dir, options = {}) {
  const { exclude = [], extensions = null, relativeBase = dir } = options;
  const results = [];

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(relativeBase, fullPath);

    const shouldExclude = exclude.some((pattern) => {
      if (typeof pattern === 'string') {
        return entry.name === pattern || relPath.startsWith(pattern);
      }
      if (pattern instanceof RegExp) {
        return pattern.test(relPath);
      }
      return false;
    });

    if (shouldExclude) continue;

    if (entry.isDirectory()) {
      const subResults = await walkDir(fullPath, { ...options, relativeBase });
      results.push(...subResults);
    } else if (entry.isFile()) {
      if (extensions && extensions.length > 0) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions.includes(ext)) continue;
      }
      results.push({
        path: fullPath,
        relativePath: relPath,
        name: entry.name
      });
    }
  }

  return results;
}

export function sampleFiles(files, sampleRate) {
  if (sampleRate >= 1) return [...files];

  const sampleCount = Math.max(1, Math.floor(files.length * sampleRate));
  const shuffled = [...files].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, sampleCount);
}

export async function getFileInfo(filePath) {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    birthtime: stats.birthtime.toISOString()
  };
}

export async function buildManifest(files, baseDir) {
  const manifest = {
    createdAt: new Date().toISOString(),
    baseDir,
    files: {}
  };

  for (const file of files) {
    const [hash, info] = await Promise.all([
      hashFile(file.path),
      getFileInfo(file.path)
    ]);

    manifest.files[file.relativePath] = {
      hash,
      size: info.size,
      mtime: info.mtime
    };
  }

  return manifest;
}

export function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
