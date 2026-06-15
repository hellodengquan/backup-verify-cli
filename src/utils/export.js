import fs from 'fs-extra';
import path from 'path';
import logger from './logger.js';

export async function exportReport(data, outputPath) {
  const ext = path.extname(outputPath).toLowerCase();
  const dir = path.dirname(outputPath);

  await fs.ensureDir(dir);

  if (ext === '.json') {
    await exportJSON(data, outputPath);
  } else if (ext === '.csv') {
    await exportCSV(data, outputPath);
  } else {
    throw new Error(`不支持的导出格式: ${ext}，仅支持 .json 和 .csv`);
  }
}

async function exportJSON(data, outputPath) {
  await fs.writeJson(outputPath, data, { spaces: 2 });
  logger.success(`JSON 报告已导出: ${outputPath}`);
}

async function exportCSV(data, outputPath) {
  const rows = [];

  rows.push(['type', 'path', 'oldHash', 'newHash', 'oldSize', 'newSize', 'sizeChange'].join(','));

  for (const f of data.added || []) {
    rows.push(['added', csvEscape(f.path), '', csvEscape(f.info?.hash || ''), '', f.info?.size || 0, f.info?.size || 0].join(','));
  }

  for (const f of data.removed || []) {
    rows.push(['removed', csvEscape(f.path), csvEscape(f.info?.hash || ''), '', f.info?.size || 0, '', -(f.info?.size || 0)].join(','));
  }

  for (const f of data.modified || []) {
    const sizeChange = (f.new?.size || 0) - (f.old?.size || 0);
    rows.push(['modified', csvEscape(f.path), csvEscape(f.old?.hash || ''), csvEscape(f.new?.hash || ''), f.old?.size || 0, f.new?.size || 0, sizeChange].join(','));
  }

  for (const f of data.unchanged || []) {
    rows.push(['unchanged', csvEscape(f.path), csvEscape(f.info?.hash || ''), csvEscape(f.info?.hash || ''), f.info?.size || 0, f.info?.size || 0, 0].join(','));
  }

  const content = rows.join('\n') + '\n';
  await fs.writeFile(outputPath, content, 'utf-8');
  logger.success(`CSV 报告已导出: ${outputPath}`);
}

function csvEscape(str) {
  if (!str) return '';
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
