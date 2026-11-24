/**
 * lib/price-utils.js
 * 价格归一化、统计、汇率解析（带 6 小时缓存）。
 *
 * 汇率优先级：
 *   1) 用户手动设置 divineToChaos（>0 时直接使用）
 *   2) poe.ninja currencyoverview 的 Divine Orb chaosEquivalent（缓存 6 小时）
 *   3) 兜底 1 divine = 200 chaos，UI 标注「汇率为估算」
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  const FALLBACK_DIVINE = 200;
  const RATE_CACHE_KEY = 'ptc_rate_cache';
  const RATE_TTL = 6 * 60 * 60 * 1000;
  const NINJA_URL = 'https://poe.ninja/api/data/currencyoverview?league={league}&type=Currency';

  /** 通货名称归一化表（英文客户端 / 中文客户端 / 简写） */
  const CURRENCY_ALIASES = {
    chaos: 'chaos',
    '混沌石': 'chaos',
    'chaos orb': 'chaos',
    c: 'chaos',
    divine: 'divine',
    '神圣石': 'divine',
    'divine orb': 'divine',
    div: 'divine',
    exalted: 'exalted',
    '崇高石': 'exalted',
    'exalted orb': 'exalted',
    ex: 'exalted',
    alchemy: 'alchemy',
    '点金石': 'alchemy',
    'orb of alchemy': 'alchemy',
    alteration: 'alteration',
    '改造石': 'alteration',
    'orb of alteration': 'alteration',
    fusing: 'fusing',
    '链接石': 'fusing',
    'orb of fusing': 'fusing',
    vaal: 'vaal',
    '瓦尔宝珠': 'vaal',
    'vaal orb': 'vaal',
    mirror: 'mirror',
    '卡兰德魔镜': 'mirror',
    'mirror of kalandra': 'mirror',
    'gemcutter': 'gcp',
    '宝石匠的棱镜': 'gcp',
    'gemcutter\u2019s prism': 'gcp',
    'gemcutter\'s prism': 'gcp'
  };

  /** 仅 chaos / divine 有可靠等值；其余通货只标记名称，不做等值换算 */
  const RELIABLE = { chaos: 1, divine: 1 };

  function normalizeCurrency(raw) {
    if (!raw) return null;
    const key = String(raw).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key) return null;
    if (CURRENCY_ALIASES[key]) return CURRENCY_ALIASES[key];
    // 容忍 "12 chaos" 之类混入数量的文本
    for (const alias of Object.keys(CURRENCY_ALIASES)) {
      if (key === alias || key.indexOf(alias) >= 0) return CURRENCY_ALIASES[alias];
    }
    return key;
  }

  /**
   * 把 (amount, currency) 归一化为 chaos 等值
   * @param {number} amount
   * @param {string} currency
   * @param {{divineRate?:number}} [opts]
   * @returns {number|null} 无法可靠换算时返回 null
   */
  function normalizePrice(amount, currency, opts) {
    const value = typeof amount === 'number' ? amount : parseFloat(amount);
    if (!isFinite(value) || value <= 0) return null;
    const key = normalizeCurrency(currency);
    if (!key) return null;
    if (key === 'chaos') return round2(value);
    if (key === 'divine') {
      const rate = opts && opts.divineRate > 0 ? opts.divineRate : FALLBACK_DIVINE;
      return round2(value * rate);
    }
    // 其他通货：退化为"无量纲数值"，仅用于同币种比较，不做跨币种汇总
    return RELIABLE[key] ? round2(value) : null;
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  /**
   * 从价格文本中解析出 {amount, currency, raw}
   * 例："12.5 chaos" / "1 divine" / "3 神圣石"
   */
  function parsePriceText(text) {
    if (!text) return null;
    const cleaned = String(text)
      .replace(/,/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const m = cleaned.match(/([\d]+(?:\.\d+)?)\s*([A-Za-z\u4e00-\u9fa5'’. ]{2,24})/);
    if (!m) return null;
    const amount = parseFloat(m[1]);
    if (!isFinite(amount) || amount <= 0) return null;
    const currency = normalizeCurrency(m[2]);
    return { amount, currency, raw: cleaned };
  }

  /** 升序数组的百分位（线性插值） */
  function percentile(sortedAsc, p) {
    if (!sortedAsc || !sortedAsc.length) return 0;
    const idx = (sortedAsc.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedAsc[lo];
    return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  }

  /**
   * 价格统计：剔除 >3 倍中位数的离群点后计算
   * @param {number[]} prices chaos 等值数组
   * @returns {{min:number,max:number,median:number,p25:number,p75:number,count:number,top5:number[],filtered:number,rawCount:number}}
   */
  function stats(prices) {
    const raw = (prices || []).filter((v) => typeof v === 'number' && isFinite(v) && v > 0);
    const empty = {
      min: 0,
      max: 0,
      median: 0,
      p25: 0,
      p75: 0,
      count: 0,
      top5: [],
      filtered: 0,
      rawCount: raw.length
    };
    if (!raw.length) return empty;

    const sorted = raw.slice().sort((a, b) => a - b);
    const median0 = percentile(sorted, 0.5);
    // 只剔除上侧极端离群点（低价挂单通常是真机会，不能剔）
    const kept = sorted.filter((v) => v <= median0 * 3);
    const filtered = sorted.length - kept.length;
    const list = kept.length ? kept : sorted;

    return {
      min: round2(list[0]),
      max: round2(list[list.length - 1]),
      median: round2(percentile(list, 0.5)),
      p25: round2(percentile(list, 0.25)),
      p75: round2(percentile(list, 0.75)),
      count: list.length,
      top5: list.slice(0, 5).map(round2),
      filtered,
      rawCount: raw.length
    };
  }

  /** chaos 展示：达到 1 divine 阈值时自动换算 */
  function formatChaos(value, divineRate) {
    const v = typeof value === 'number' ? value : parseFloat(value);
    if (!isFinite(v) || v <= 0) return '—';
    const rate = divineRate > 0 ? divineRate : FALLBACK_DIVINE;
    if (v >= rate) {
      const div = v / rate;
      return (div >= 10 ? div.toFixed(0) : div.toFixed(1)) + ' div';
    }
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' c';
  }

  /** 相对中位数的涨跌百分比（正数=更便宜） */
  function deltaPercent(price, median) {
    if (!(price > 0) || !(median > 0)) return null;
    return round2(((median - price) / median) * 100);
  }

  /* ---------------- 汇率解析（异步，带缓存） ---------------- */

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  async function readCache() {
    if (!hasStorage()) return null;
    try {
      const got = await chrome.storage.local.get(RATE_CACHE_KEY);
      const cache = got && got[RATE_CACHE_KEY];
      if (cache && cache.savedAt && Date.now() - cache.savedAt < RATE_TTL) return cache;
      return null;
    } catch (e) {
      return null;
    }
  }

  async function writeCache(payload) {
    if (!hasStorage()) return;
    try {
      await chrome.storage.local.set({ [RATE_CACHE_KEY]: Object.assign({}, payload, { savedAt: Date.now() }) });
    } catch (e) {
      /* 缓存写入失败不影响主流程 */
    }
  }

  async function fetchNinjaRate(league, fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch || !league) return null;
    const url = NINJA_URL.replace('{league}', encodeURIComponent(league));
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      const res = await doFetch(url, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) return null;
      const data = await res.json();
      const lines = (data && data.lines) || [];
      const divine = lines.find(
        (l) => l && (l.currencyTypeName === 'Divine Orb' || l.currencyTypeName === '神圣石')
      );
      const value = divine && Number(divine.chaosEquivalent);
      if (!value || !isFinite(value) || value <= 0) return null;
      return round2(value);
    } catch (e) {
      return null;
    }
  }

  /**
   * 解析当前会话使用的 divine→chaos 汇率
   * @param {{league?:string, force?:boolean, fetchImpl?:Function}} opts
   * @returns {Promise<{rate:number, source:'user'|'ninja'|'fallback', savedAt?:number}>}
   */
  async function resolveDivineRate(opts) {
    const options = opts || {};
    const league = options.league || 'Standard';

    // 1) 用户手动设置优先
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      try {
        const got = await chrome.storage.sync.get(['divineToChaos']);
        const userRate = Number(got && got.divineToChaos);
        if (isFinite(userRate) && userRate > 0) {
          return { rate: round2(userRate), source: 'user' };
        }
      } catch (e) {
        /* 忽略，继续自动解析 */
      }
    }

    // 2) 缓存优先（6 小时内）
    if (!options.force) {
      const cache = await readCache();
      if (cache && cache.league === league && cache.rate > 0) {
        return { rate: cache.rate, source: 'ninja', savedAt: cache.savedAt };
      }
    }

    // 3) 在线拉取
    const fetched = await fetchNinjaRate(league, options.fetchImpl);
    if (fetched) {
      await writeCache({ league, rate: fetched });
      return { rate: fetched, source: 'ninja' };
    }

    // 4) 过期缓存兜底
    if (hasStorage()) {
      try {
        const got = await chrome.storage.local.get(RATE_CACHE_KEY);
        const cache = got && got[RATE_CACHE_KEY];
        if (cache && cache.rate > 0) return { rate: cache.rate, source: 'ninja', savedAt: cache.savedAt };
      } catch (e) {
        /* ignore */
      }
    }

    return { rate: FALLBACK_DIVINE, source: 'fallback' };
  }

  PTC.PriceUtils = {
    FALLBACK_DIVINE,
    RATE_CACHE_KEY,
    RATE_TTL,
    normalizeCurrency,
    normalizePrice,
    parsePriceText,
    percentile,
    stats,
    formatChaos,
    deltaPercent,
    resolveDivineRate,
    round2
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
