/**
 * lib/stats-dict.js — 词缀词库加载与展开
 *
 * 词库结构（prefix-grouped，由 tools/build_stats_dict.py 生成）：
 *   { "_meta": {...}, "g": { "explicit.stat_": { "2422708892": "+#% 总冰霜抗性" } }, "misc": {...} }
 *
 * 加载策略：
 *   1. 内置 config/i18n-stats-zh.json —— 本地文件，随扩展打包，离线可用
 *   2. 远端 remote.json 的 i18n.statsUrl —— 赛季更新，6 小时缓存，失败静默回退
 * 词条量约 1.8 万条，异步加载不阻塞页面。
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  const BUILTIN_PATH = 'config/i18n-stats-zh.json';
  const CACHE_KEY = 'ptcStatsDict';
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  /** 把 prefix-grouped 结构展开成 { 完整id: 中文 } */
  function expand(payload) {
    const out = Object.create(null);
    if (!payload || typeof payload !== 'object') return out;

    const groups = payload.g;
    if (groups && typeof groups === 'object') {
      const prefixes = Object.keys(groups);
      for (let i = 0; i < prefixes.length; i += 1) {
        const prefix = prefixes[i];
        const bag = groups[prefix];
        if (!bag || typeof bag !== 'object') continue;
        const suffixes = Object.keys(bag);
        for (let j = 0; j < suffixes.length; j += 1) {
          const zh = bag[suffixes[j]];
          if (typeof zh === 'string' && zh) out[prefix + suffixes[j]] = zh;
        }
      }
    }

    const misc = payload.misc;
    if (misc && typeof misc === 'object') {
      const keys = Object.keys(misc);
      for (let i = 0; i < keys.length; i += 1) {
        const zh = misc[keys[i]];
        if (typeof zh === 'string' && zh) out[keys[i]] = zh;
      }
    }
    return out;
  }

  function countOf(obj) {
    return obj ? Object.keys(obj).length : 0;
  }

  async function fetchJson(url) {
    if (!url || typeof fetch !== 'function') return null;
    try {
      const res = await fetch(url, { cache: 'force-cache', credentials: 'omit' });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  /** 内置词库：扩展包内文件，必定可用 */
  async function loadBuiltin() {
    try {
      const url = chrome.runtime.getURL(BUILTIN_PATH);
      return await fetchJson(url);
    } catch (e) {
      return null;
    }
  }

  function readCache() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([CACHE_KEY], (got) => resolve((got && got[CACHE_KEY]) || null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  function writeCache(entry) {
    try {
      chrome.storage.local.set({ [CACHE_KEY]: entry });
    } catch (e) {
      /* 忽略写入失败 */
    }
  }

  /** 远端词库：优先缓存，过期后后台更新 */
  async function loadRemote(url, force) {
    if (!url || !/^https:\/\//i.test(url)) return null;
    const cached = await readCache();
    const now = Date.now();
    if (!force && cached && cached.payload && cached.url === url && now - cached.savedAt < CACHE_TTL) {
      return cached.payload;
    }
    const fresh = await fetchJson(url);
    if (fresh) {
      writeCache({ url, savedAt: Date.now(), payload: fresh });
      return fresh;
    }
    // 拉取失败用过期缓存
    return cached && cached.url === url ? cached.payload : null;
  }

  /**
   * 加载生效词库
   * @param {{statsUrl?:string, enabled?:boolean, force?:boolean}} [opts]
   * @returns {Promise<{byId:Object, version:string, count:number, source:string}>}
   */
  async function load(opts) {
    const options = opts || {};
    const base = await loadBuiltin();
    let byId = expand(base);
    let version = (base && base._meta && base._meta.builtAt) || 'builtin';
    let source = 'builtin';

    if (options.enabled !== false && options.statsUrl) {
      const remote = await loadRemote(options.statsUrl, !!options.force);
      if (remote) {
        const remoteMap = expand(remote);
        if (countOf(remoteMap) > 0) {
          // 远端覆盖内置（新赛季新增/修订词条）
          byId = Object.assign(Object.create(null), byId, remoteMap);
          version = (remote._meta && remote._meta.builtAt) || 'remote';
          source = 'remote';
        }
      }
    }

    return { byId, version, count: countOf(byId), source };
  }

  PTC.StatsDict = {
    BUILTIN_PATH,
    CACHE_KEY,
    expand,
    load,
    countOf
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
