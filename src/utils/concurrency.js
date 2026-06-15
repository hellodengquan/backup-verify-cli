import logger from './logger.js';

export class ConcurrencyPool {
  constructor(concurrency = 2, rateLimit = 0) {
    this._concurrency = Math.max(1, concurrency);
    this._rateLimit = rateLimit;
    this._running = 0;
    this._queue = [];
    this._lastStartTime = 0;
    this._results = [];
  }

  async add(fn, label = 'task') {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, label, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this._running < this._concurrency && this._queue.length > 0) {
      const item = this._queue.shift();
      this._run(item);
    }
  }

  async _run(item) {
    this._running++;

    if (this._rateLimit > 0) {
      const now = Date.now();
      const elapsed = now - this._lastStartTime;
      const minInterval = 1000 / this._rateLimit;
      if (elapsed < minInterval) {
        await sleep(minInterval - elapsed);
      }
    }

    this._lastStartTime = Date.now();

    try {
      const result = await item.fn();
      this._results.push({ label: item.label, status: 'fulfilled', value: result });
      item.resolve(result);
    } catch (err) {
      this._results.push({ label: item.label, status: 'rejected', reason: err });
      item.reject(err);
    } finally {
      this._running--;
      this._drain();
    }
  }

  getResults() {
    return this._results;
  }

  get pending() {
    return this._queue.length;
  }

  get active() {
    return this._running;
  }
}

export async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    label = 'operation',
    onRetry = null
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
        const jitter = Math.random() * delay * 0.2;
        const waitTime = delay + jitter;

        logger.warn(`重试 ${label}: 第 ${attempt + 1} 次 (等待 ${Math.round(waitTime)}ms)`, {
          error: err.message,
          attempt: attempt + 1
        });

        if (onRetry) onRetry(attempt + 1, err);

        await sleep(waitTime);
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
