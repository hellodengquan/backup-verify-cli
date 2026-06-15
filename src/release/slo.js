const DEFAULT_SLO = {
  backup_success_rate: {
    target: 99.0,
    warning: 99.5,
    description: '备份成功率 SLO'
  },
  verify_success_rate: {
    target: 99.5,
    warning: 99.8,
    description: '校验成功率 SLO'
  },
  diff_discovery_rate: {
    target: 99.9,
    warning: 99.95,
    description: '差异发现率 SLO'
  },
  backup_duration_seconds: {
    target: 300,
    warning: 240,
    description: '备份最大允许耗时 (s)'
  },
  verify_duration_seconds: {
    target: 600,
    warning: 480,
    description: '校验最大允许耗时 (s)'
  },
  file_integrity_rate: {
    target: 99.99,
    warning: 99.995,
    description: '文件完整率 SLO'
  }
};

class SLIEngine {
  constructor(options = {}) {
    this.sloConfig = { ...DEFAULT_SLO, ...(options.sloConfig || {}) };
    this.history = [];
    this.alerts = [];
    this.maxHistory = options.maxHistory || 1000;
  }

  record(name, value, labels = {}) {
    const record = {
      name,
      value,
      labels,
      timestamp: Date.now()
    };

    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const slo = this.sloConfig[name];
    if (slo) {
      const breach = this._evaluateSLO(name, value, slo);
      if (breach) {
        this.alerts.push(breach);
      }
    }

    return record;
  }

  _evaluateSLO(name, value, slo) {
    const isRate = name.includes('rate');
    let severity = null;
    let breached = false;
    let actual = value;

    if (isRate) {
      if (value < slo.target) {
        severity = 'critical';
        breached = true;
      } else if (value < slo.warning) {
        severity = 'warning';
        breached = true;
      }
    } else {
      if (value > slo.target) {
        severity = 'critical';
        breached = true;
      } else if (value > slo.warning) {
        severity = 'warning';
        breached = true;
      }
    }

    if (!breached) return null;

    return {
      metric: name,
      severity,
      actual: value,
      target: slo.target,
      warning: slo.warning,
      description: slo.description,
      timestamp: Date.now()
    };
  }

  recordBackupResult(total, failed, duration) {
    const passed = total - failed;
    const successRate = total > 0 ? (passed / total) * 100 : 100;

    this.record('backup_success_rate', successRate, { operation: 'backup' });
    this.record('backup_duration_seconds', duration, { operation: 'backup' });

    return { successRate, passed, failed, total };
  }

  recordVerifyResult(total, failed, missing, duration) {
    const valid = total - failed - missing;
    const successRate = total > 0 ? (valid / total) * 100 : 100;
    const integrityRate = total > 0 ? ((total - failed) / total) * 100 : 100;

    this.record('verify_success_rate', successRate, { operation: 'verify' });
    this.record('verify_duration_seconds', duration, { operation: 'verify' });
    this.record('file_integrity_rate', integrityRate, { operation: 'verify' });

    return { successRate, integrityRate, valid, failed, missing, total };
  }

  recordDiffResult(total, changed, duration) {
    const discoveryRate = total > 0 ? 100 : 100;
    this.record('diff_discovery_rate', discoveryRate, { operation: 'diff' });
    return { discoveryRate, changed, total };
  }

  computeSLI(windowMs = null) {
    const now = Date.now();
    const records = windowMs
      ? this.history.filter(r => r.timestamp >= now - windowMs)
      : this.history;

    const byMetric = {};
    for (const r of records) {
      if (!byMetric[r.name]) byMetric[r.name] = [];
      byMetric[r.name].push(r.value);
    }

    const slis = {};
    for (const [name, values] of Object.entries(byMetric)) {
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      slis[name] = {
        average: Number(avg.toFixed(4)),
        min: Number(min.toFixed(4)),
        max: Number(max.toFixed(4)),
        samples: values.length
      };
    }

    return slis;
  }

  getAlerts(severity = null) {
    if (!severity) return [...this.alerts];
    return this.alerts.filter(a => a.severity === severity);
  }

  clearAlerts() {
    this.alerts = [];
  }

  getReport() {
    const slis = this.computeSLI();
    const critical = this.getAlerts('critical');
    const warnings = this.getAlerts('warning');

    return {
      timestamp: new Date().toISOString(),
      slis,
      sloStatus: {
        healthy: critical.length === 0,
        criticalCount: critical.length,
        warningCount: warnings.length
      },
      alerts: {
        critical,
        warning: warnings
      }
    };
  }

  static getDefaultSLO() {
    return JSON.parse(JSON.stringify(DEFAULT_SLO));
  }
}

let _defaultInstance = null;

export function getSLIEngine(options) {
  if (!_defaultInstance) {
    _defaultInstance = new SLIEngine(options);
  }
  return _defaultInstance;
}

export function resetSLIEngine() {
  _defaultInstance = null;
}

export { SLIEngine, DEFAULT_SLO };
export default SLIEngine;
