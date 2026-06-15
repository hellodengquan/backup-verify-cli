import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

class StructuredLogger {
  constructor() {
    this._minLevel = 'info';
    this._jsonMode = false;
    this._logFile = null;
    this._logStream = null;
    this._correlationId = null;
  }

  configure(options = {}) {
    if (options.level) this._minLevel = options.level;
    if (options.json) this._jsonMode = options.json;
    if (options.logFile) {
      this._logFile = options.logFile;
      fs.ensureDirSync(path.dirname(this._logFile));
      this._logStream = fs.createWriteStream(this._logFile, { flags: 'a' });
    }
  }

  setCorrelationId(id) {
    this._correlationId = id;
  }

  _emit(level, message, extra = {}) {
    if (LEVELS[level] < LEVELS[this._minLevel]) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...extra
    };
    if (this._correlationId) entry.correlationId = this._correlationId;

    if (this._logStream) {
      this._logStream.write(JSON.stringify(entry) + '\n');
    }

    if (this._jsonMode) {
      const out = level === 'error' ? process.stderr : process.stdout;
      out.write(JSON.stringify(entry) + '\n');
      return;
    }

    this._prettyPrint(level, message, extra);
  }

  _prettyPrint(level, message, extra) {
    const tag = {
      info: chalk.blue('[INFO]'),
      success: chalk.green('[SUCCESS]'),
      warn: chalk.yellow('[WARN]'),
      error: chalk.red('[ERROR]'),
      debug: chalk.gray('[DEBUG]')
    }[level] || `[${level.toUpperCase()}]`;

    const out = level === 'error' ? console.error : console.log;
    out(tag, message);
    if (extra.data && Object.keys(extra.data).length > 0) {
      out(chalk.gray('  └'), JSON.stringify(extra.data));
    }
  }

  info(msg, data) { this._emit('info', msg, { data: data || {} }); }
  success(msg, data) { this._emit('info', msg, { data: data || {} }); }
  warn(msg, data) { this._emit('warn', msg, { data: data || {} }); }
  error(msg, data) { this._emit('error', msg, { data: data || {} }); }
  debug(msg, data) { this._emit('debug', msg, { data: data || {} }); }

  section(title) {
    if (this._jsonMode) {
      this._emit('info', `=== ${title} ===`);
      return;
    }
    console.log('');
    console.log(chalk.cyan.bold(`=== ${title} ===`));
  }

  listItem(msg) {
    if (this._jsonMode) {
      this._emit('info', msg);
      return;
    }
    console.log(chalk.gray('  •'), msg);
  }

  flush() {
    return new Promise((resolve) => {
      if (this._logStream) {
        this._logStream.end(resolve);
        this._logStream = null;
      } else {
        resolve();
      }
    });
  }
}

const logger = new StructuredLogger();

export default logger;
export { StructuredLogger };
