/**
 * lib/rate-limiter.js
 * 全局单例队列 + 最小间隔节流。所有对外网络请求必须经过 run()。
 *
 * 特性：
 *  - 默认最小间隔 260ms
 *  - 解析 X-Rate-Limit-Rules / X-Rate-Limit-* / *-State 响应头
 *  - 剩余配额 ≤20%（利用率 ≥80%）时自动放缓至 1000ms
 *  - HTTP 429 时读取 Retry-After，暂停队列并自动重试（最多 3 次）
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  const DEFAULT_MIN_INTERVAL = 260;
  const SLOW_INTERVAL = 1000;
  const SLOW_THRESHOLD = 0.8; // 利用率达到 80% 即视为剩余配额 ≤20%
  const MAX_RETRY = 3;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  /**
   * 解析 "hits:period:restricted" 形式的策略串
   * @returns {{hits:number, period:number, restricted:number}[]}
   */
  function parsePolicyList(value) {
    if (!value) return [];
    return String(value)
      .split(',')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const parts = chunk.split(':').map((n) => parseInt(n, 10));
        return { hits: parts[0] || 0, period: parts[1] || 0, restricted: parts[2] || 0 };
      })
      .filter((p) => p.period > 0);
  }

  /** 把响应头（Headers 或普通对象或 getAllResponseHeaders 文本）统一成普通对象 */
  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
        headers.forEach((v, k) => {
          out[String(k).toLowerCase()] = v;
        });
        return out;
      }
      if (typeof headers === 'string') {
        headers.split(/\r?\n/).forEach((line) => {
          const idx = line.indexOf(':');
          if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        });
        return out;
      }
      if (typeof headers === 'object') {
        Object.keys(headers).forEach((k) => {
          out[String(k).toLowerCase()] = headers[k];
        });
      }
    } catch (e) {
      /* 解析失败返回已收集部分 */
    }
    return out;
  }

  class RateLimiter {
    constructor(options) {
      const opts = options || {};
      this.minInterval = opts.minInterval || DEFAULT_MIN_INTERVAL;
      this.currentInterval = this.minInterval;
      this.queue = [];
      this.nextAt = 0;
      this.pauseUntil = 0;
      this.pumping = false;
      this.policies = {}; // name -> 默认值（来自 X-Rate-Limit-<Name>）
      this.utilization = 0;
    }

    /** 提交任务：await limiter.run(async () => {...}) */
    run(task) {
      if (typeof task !== 'function') return Promise.reject(new TypeError('task must be a function'));
      return new Promise((resolve, reject) => {
        this.queue.push({ task, resolve, reject, attempt: 0 });
        this._pump();
      });
    }

    async _pump() {
      if (this.pumping) return;
      this.pumping = true;
      try {
        while (this.queue.length) {
          const job = this.queue.shift();
          const wait = Math.max(0, this.nextAt - Date.now(), this.pauseUntil - Date.now());
          if (wait > 0) await sleep(wait);
          try {
            const value = await job.task();
            job.resolve(value);
          } catch (err) {
            const retryAfter = err && err.retryAfterMs;
            if (retryAfter && job.attempt < MAX_RETRY) {
              job.attempt += 1;
              this.pause(Math.ceil(retryAfter / 1000));
              // 429 后重排到队首，避免阻塞其它任务太久
              this.queue.unshift(job);
            } else {
              job.reject(err);
            }
          }
          this.nextAt = Date.now() + this.currentInterval;
        }
      } finally {
        this.pumping = false;
      }
    }

    /** 暂停队列若干秒（用于 429） */
    pause(seconds) {
      const ms = Math.max(0, Number(seconds) || 0) * 1000;
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms);
      this.currentInterval = SLOW_INTERVAL;
    }

    /** 根据响应头调整节流间隔 */
    updateFromHeaders(headers) {
      const map = typeof headers === 'string' || headers instanceof Object ? headersToObject(headers) : {};
      const rulesRaw = map['x-rate-limit-rules'];
      const names = rulesRaw
        ? String(rulesRaw)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : Object.keys(map)
            .filter((k) => /^x-rate-limit-[\w-]+-state$/.test(k))
            .map((k) => k.replace(/^x-rate-limit-/, '').replace(/-state$/, ''));

      let worst = 0;
      names.forEach((name) => {
        const lower = name.toLowerCase();
        const policy = parsePolicyList(map['x-rate-limit-' + lower]);
        const state = parsePolicyList(map['x-rate-limit-' + lower + '-state']);
        if (!policy.length || !state.length) return;
        // 用 period 对齐 policy 与 state
        state.forEach((st) => {
          const match = policy.find((p) => p.period === st.period) || policy[0];
          if (!match || !match.hits) return;
          const ratio = Math.min(1, st.hits / match.hits);
          if (ratio > worst) worst = ratio;
          // 若官方已标记 restricted，直接进入慢速
          if (st.restricted > 0) worst = Math.max(worst, 1);
        });
      });

      this.utilization = worst;
      if (worst >= SLOW_THRESHOLD) {
        this.currentInterval = SLOW_INTERVAL;
      } else if (worst < 0.5) {
        this.currentInterval = this.minInterval;
      }
      return this.utilization;
    }

    /** 剩余配额比例（1 = 全新，0 = 用尽） */
    remainingRatio() {
      return Math.max(0, 1 - this.utilization);
    }

    stats() {
      return {
        queueLength: this.queue.length,
        interval: this.currentInterval,
        utilization: Number(this.utilization.toFixed(2)),
        paused: this.pauseUntil > Date.now()
      };
    }
  }

  /** 全局限流器单例（每个执行环境内一个） */
  const shared = new RateLimiter();
  PTC.rateLimiter = PTC.rateLimiter || shared;
  PTC.RateLimiter = RateLimiter;
  PTC.RateLimiterUtil = { sleep, headersToObject, parsePolicyList };
})(typeof globalThis !== 'undefined' ? globalThis : self);
