/**
 * lib/remote-config.js
 * 赛季自适应：远端配置拉取 + 6 小时缓存 + 校验 + 静默降级。
 *
 * remote.json 结构：
 * {
 *   "schemaVersion": 1,
 *   "minExtensionVersion": "0.1.0",
 *   "selectors": { "resultRow": [...], "priceInRow": [...] },
 *   "api": { "searchPath": "/api/trade/search/", "fetchPath": "/api/trade/fetch/" },
 *   "notice": "2026-11-24 已适配 Covens 赛季"
 * }
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  const STORAGE_KEY = 'remoteConfig';
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const DEFAULT_URL =
    'https://raw.githubusercontent.com/poe-trade-companion/poe-trade-companion/main/config/remote.json';

  const DEFAULT_CONFIG = {
    schemaVersion: 1,
    minExtensionVersion: '0.1.0',
    selectors: {
      resultRow: ['.resultset', '[class*="resultset"]', '.results .row', '.results > *'],
      priceInRow: ['.price', '[class*="price"]', '.details .price'],
      itemNameInRow: ['.itemHeader .itemName', '.itemName', '[class*="itemName"]'],
      whisperBtn: ['.btns .btn', 'button.btn']
    },
    api: {
      searchPath: '/api/trade/search/',
      fetchPath: '/api/trade/fetch/'
    },
    // 默认赛季与旧赛季别名（赛季更名时把旧 URL 赛季名映射到新赛季）
    league: 'Covens',
    leagueAliases: {},
    // 汉化词库远端地址（随赛季热更新，无需重新发版）
    i18n: {
      // 界面词库
      dictUrl: 'https://raw.githubusercontent.com/poe-trade-companion/poe-trade-companion/main/config/i18n-zh.json',
      // 词缀词库（约 1.8 万条，由 tools/build_stats_dict.py 生成）
      statsUrl: 'https://raw.githubusercontent.com/poe-trade-companion/poe-trade-companion/main/config/i18n-stats-zh.json'
    },
    notice: ''
  };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** 深合并：远端值覆盖默认值，数组整体替换 */
  function deepMerge(base, patch, depth) {
    const level = depth || 0;
    if (level > 5) return patch;
    if (!isPlainObject(patch)) return patch === undefined ? base : patch;
    const out = isPlainObject(base) ? Object.assign({}, base) : {};
    Object.keys(patch).forEach((k) => {
      const pv = patch[k];
      const bv = out[k];
      out[k] = isPlainObject(pv) && isPlainObject(bv) ? deepMerge(bv, pv, level + 1) : pv;
    });
    return out;
  }

  /** 校验远端配置合法性，非法规避字段返回 null */
  function validate(remote) {
    if (!isPlainObject(remote)) return null;
    const schemaVersion = Number(remote.schemaVersion);
    if (!isFinite(schemaVersion) || schemaVersion > 1) return null;

    const cleaned = { schemaVersion: isFinite(schemaVersion) ? schemaVersion : 1 };

    if (typeof remote.minExtensionVersion === 'string') {
      cleaned.minExtensionVersion = remote.minExtensionVersion.trim();
    }
    if (typeof remote.notice === 'string') cleaned.notice = remote.notice.trim();

    // 默认赛季：仅接受不含斜杠的短字符串，避免被拼进接口路径造成注入
    if (typeof remote.league === 'string' && /^[\w\- ]{1,40}$/.test(remote.league.trim())) {
      cleaned.league = remote.league.trim();
    }

    // 旧赛季别名映射：{ "旧赛季名": "新赛季名" }
    if (isPlainObject(remote.leagueAliases)) {
      const aliases = {};
      Object.keys(remote.leagueAliases).forEach((k) => {
        const v = remote.leagueAliases[k];
        if (typeof k === 'string' && k.trim() && typeof v === 'string' && /^[\w\- ]{1,40}$/.test(v.trim())) {
          aliases[k.trim()] = v.trim();
        }
      });
      if (Object.keys(aliases).length) cleaned.leagueAliases = aliases;
    }

    // 汉化词典远端覆盖（随赛季热更新）：{ dict: {英文: 中文}, byId: {数据id: 中文} }
    // 约束：单字段最多 3000 条、键 ≤120 字符、值 ≤200 字符，且值不得含 HTML 尖括号
    if (isPlainObject(remote.i18n)) {
      const MAX_ENTRIES = 3000;
      const MAX_KEY = 120;
      const MAX_VALUE = 200;
      const i18nOut = {};
      ['dict', 'byId'].forEach((field) => {
        const src = remote.i18n[field];
        if (!isPlainObject(src)) return;
        const bag = {};
        let count = 0;
        Object.keys(src).forEach((k) => {
          if (count >= MAX_ENTRIES) return;
          const v = src[k];
          if (typeof k !== 'string' || !k.trim() || k.length > MAX_KEY) return;
          if (typeof v !== 'string') return;
          const val = v.trim();
          if (!val || val.length > MAX_VALUE) return;
          if (val.indexOf('<') >= 0 || val.indexOf('>') >= 0) return;
          bag[k] = val;
          count += 1;
        });
        if (count) i18nOut[field] = bag;
      });
      // 远端词库地址（随赛季热更新词条）：仅接受 https 地址
      // dictUrl = 界面词库；statsUrl = 词缀词库（约 1.8 万条，独立文件）
      ['dictUrl', 'statsUrl'].forEach((field) => {
        const url = remote.i18n[field];
        if (typeof url === 'string' && /^https:\/\/[\w\-.~/?#@!$&'()*+,;=%]+$/i.test(url.trim())) {
          i18nOut[field] = url.trim();
        }
      });
      const dictVersion = Number(remote.i18n.version);
      if (isFinite(dictVersion) && dictVersion > 0 && dictVersion <= 9999) {
        i18nOut.version = Math.floor(dictVersion);
      }
      if (Object.keys(i18nOut).length) cleaned.i18n = i18nOut;
    }

    if (isPlainObject(remote.selectors)) {
      const selectors = {};
      Object.keys(remote.selectors).forEach((k) => {
        const v = remote.selectors[k];
        const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
        const safe = list.filter((s) => typeof s === 'string' && s.trim());
        if (safe.length) selectors[k] = safe;
      });
      if (Object.keys(selectors).length) cleaned.selectors = selectors;
    }

    if (isPlainObject(remote.api)) {
      const api = {};
      ['searchPath', 'fetchPath'].forEach((k) => {
        const v = remote.api[k];
        if (typeof v === 'string' && /^\/[\w\-./]+$/.test(v.trim())) api[k] = v.trim();
      });
      if (Object.keys(api).length) cleaned.api = api;
    }
    return cleaned;
  }

  function compareVersions(a, b) {
    const pa = String(a || '0')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  function hasStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  async function readCache() {
    if (!hasStorage()) return null;
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const entry = got && got[STORAGE_KEY];
      if (entry && entry.data) return entry;
      return null;
    } catch (e) {
      return null;
    }
  }

  async function writeCache(url, data) {
    if (!hasStorage()) return;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: { url, data, savedAt: Date.now() } });
    } catch (e) {
      /* 忽略缓存写入失败 */
    }
  }

  async function fetchRemote(url) {
    if (!url || typeof fetch !== 'function') return null;
    try {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
      const res = await fetch(url, {
        cache: 'no-cache',
        credentials: 'omit',
        signal: ctrl ? ctrl.signal : undefined
      });
      if (timer) clearTimeout(timer);
      if (!res || !res.ok) return null;
      const json = await res.json();
      return validate(json);
    } catch (e) {
      // 断网 / CORS / JSON 解析失败均静默降级
      return null;
    }
  }

  /**
   * 获取生效配置（合并默认值）
   * @param {{url?:string, force?:boolean}} [opts]
   * @returns {Promise<{config:Object, source:'remote'|'cache'|'default', savedAt?:number, notice:string}>}
   */
  async function load(opts) {
    const options = opts || {};
    const cached = await readCache();
    const url = options.url === undefined ? (cached && cached.url) || DEFAULT_URL : options.url;

    // 留空 = 关闭远端配置
    if (!url) {
      return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), source: 'default', notice: '' };
    }

    const fresh = cached && cached.savedAt && Date.now() - cached.savedAt < CACHE_TTL;
    if (fresh && !options.force && cached.url === url) {
      return {
        config: deepMerge(DEFAULT_CONFIG, cached.data),
        source: 'remote',
        savedAt: cached.savedAt,
        notice: (cached.data && cached.data.notice) || ''
      };
    }

    const remote = await fetchRemote(url);
    if (remote) {
      await writeCache(url, remote);
      return { config: deepMerge(DEFAULT_CONFIG, remote), source: 'remote', savedAt: Date.now(), notice: remote.notice || '' };
    }

    if (cached && cached.data) {
      return {
        config: deepMerge(DEFAULT_CONFIG, cached.data),
        source: 'cache',
        savedAt: cached.savedAt,
        notice: (cached.data && cached.data.notice) || ''
      };
    }

    return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), source: 'default', notice: '' };
  }

  /** 同步读取缓存（无网络），用于 UI 立即渲染 */
  async function cachedOnly() {
    const cached = await readCache();
    if (cached && cached.data) {
      return { config: deepMerge(DEFAULT_CONFIG, cached.data), source: 'cache', savedAt: cached.savedAt, notice: cached.data.notice || '' };
    }
    return { config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)), source: 'default', notice: '' };
  }

  /** 是否存在新版本要求 */
  function needsUpdate(config, currentVersion) {
    if (!config || !config.minExtensionVersion) return false;
    return compareVersions(config.minExtensionVersion, currentVersion) > 0;
  }

  PTC.RemoteConfig = {
    DEFAULT_URL,
    DEFAULT_CONFIG,
    STORAGE_KEY,
    CACHE_TTL,
    load,
    cachedOnly,
    validate,
    deepMerge,
    compareVersions,
    needsUpdate
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
