import { build } from 'esbuild';
import { createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const PLATFORMS = [
  { bin: 'backup-verify-darwin-x64',      os: 'macos',   arch: 'x64' },
  { bin: 'backup-verify-darwin-arm64',     os: 'macos',   arch: 'arm64' },
  { bin: 'backup-verify-linux-x64',        os: 'linux',  arch: 'x64' },
  { bin: 'backup-verify-linux-arm64',       os: 'linux', arch: 'arm64' },
  { bin: 'backup-verify-win32-x64.exe',     os: 'windows', arch: 'x64' },
  { bin: 'backup-verify-win32-arm64.exe',   os: 'windows', arch: 'arm64' }
];

async function buildBundle(outPath) {
  const distDir = path.join(ROOT, 'dist');
  await fs.ensureDir(distDir);

  console.log(`打包 -> ${outPath}`);

  await build({
    entryPoints: [path.join(ROOT, 'bin', 'backup-verify.js')],
    bundle: true,
    platform: 'node',
    target: ['node20'],
    format: 'esm',
    outfile: outPath,
    banner: {},
    packages: 'external',
    external: [],
    minify: false,
    sourcemap: false,
    logLevel: 'info'
  });

  return outPath;
}

async function compressFile(filePath) {
  const gzPath = filePath + '.gz';

  await pipeline(
    fs.createReadStream(filePath),
    createGzip(),
    createWriteStream(gzPath)
  );

  return gzPath;
}

async function buildPlatform(platform) {
  console.log(`\n构建: ${platform.os}-${platform.arch}`);

  const distDir = path.join(ROOT, 'dist');
  await fs.ensureDir(distDir);

  const bundleName = `bundle-${platform.bin.replace('.exe', '')}.mjs`;
  const bundlePath = path.join(distDir, bundleName);

  await buildBundle(bundlePath);

  const outPath = path.join(distDir, platform.bin);

  if (platform.os === 'windows') {
    const batContent = `@echo off\r\nnode "%~dp0${bundleName}" %*\r\n`;
    await fs.writeFile(outPath, batContent);
  } else {
    const shContent = `#!/bin/sh\nexec node "$(dirname "$0")/${bundleName}" "$@"\n`;
    await fs.writeFile(outPath, shContent);
    try { fs.chmodSync(outPath, 0o755); } catch {}
  }

  const gzPath = await compressFile(outPath);
  const bundleGzPath = await compressFile(bundlePath);

  const stat = await fs.stat(bundlePath);
  const gzStat = await fs.stat(bundleGzPath);

  console.log(`  Bundle: ${bundlePath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  启动器: ${outPath}`);
  console.log(`  压缩: ${bundleGzPath} (${(gzStat.size / 1024 / 1024).toFixed(2)} MB)`);

  return {
    platform: `${platform.os}-${platform.arch}`,
    path: outPath,
    bundle: bundlePath,
    compressed: bundleGzPath,
    size: stat.size,
    compressedSize: gzStat.size
  };
}

async function buildAll(platformFilter) {
  const platforms = platformFilter
    ? PLATFORMS.filter(p => `${p.os}-${p.arch}` === platformFilter || p.bin.startsWith(platformFilter))
    : PLATFORMS;

  if (platforms.length === 0) {
    console.error('没有匹配的平台');
    process.exit(1);
  }

  console.log(`将构建 ${platforms.length} 个平台:`);
  platforms.forEach(p => console.log(`  - ${p.os}-${p.arch}`));

  const results = [];
  for (const platform of platforms) {
    try {
      const result = await buildPlatform(platform);
      results.push(result);
    } catch (err) {
      console.error(`构建失败 ${platform.os}-${platform.arch}: ${err.message}`);
      results.push({ platform: `${platform.os}-${platform.arch}`, error: err.message });
    }
  }

  console.log('\n构建汇总:');
  const manifest = { version: (await fs.readJson(path.join(ROOT, 'package.json'))).version, builds: {} };
  for (const r of results) {
    if (r.error) {
      console.log(`  ✗ ${r.platform}: ${r.error}`);
    } else {
      console.log(`  ✓ ${r.platform}: ${(r.size / 1024 / 1024).toFixed(2)} MB`);
      manifest.builds[r.platform] = {
        file: path.basename(r.path),
        compressed: path.basename(r.compressed),
        size: r.size,
        compressedSize: r.compressedSize
      };
    }
  }

  const manifestPath = path.join(ROOT, 'dist', 'build-manifest.json');
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  console.log(`\n清单文件: ${manifestPath}`);

  return results;
}

const filter = process.argv[2] || null;
buildAll(filter).catch(err => {
  console.error('构建失败:', err);
  process.exit(1);
});
