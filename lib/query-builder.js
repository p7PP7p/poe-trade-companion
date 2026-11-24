/**
 * lib/query-builder.js
 * 由解析后的物品构造 /api/trade/search 请求体。
 * 值为 undefined 的键会被剔除，避免被官方 API 判为非法字段。
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 递归剔除 undefined，保留 null/0/false */
  function compact(obj) {
    if (Array.isArray(obj)) {
      const arr = obj.map(compact).filter((v) => v !== undefined);
      return arr;
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      Object.keys(obj).forEach((k) => {
        const v = compact(obj[k]);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    return obj;
  }

  /**
   * 构造 search 请求体
   * @param {{rarity?:string,name?:string,baseType?:string,itemLevel?:number,mods?:string[]}} parsed
   * @param {string} league
   * @param {{online?:boolean, statsFilters?:Array}} [opts]
   * @returns {{query:Object, sort:Object}}
   */
  function buildSearchQuery(parsed, league, opts) {
    const options = opts || {};
    const online = options.online !== false;
    const item = parsed || {};

    const nameFilter =
      item.rarity === 'Unique' && item.name ? '^' + escapeRegex(item.name) + '$' : undefined;

    const payload = {
      query: {
        status: online ? { option: 'online' } : undefined,
        name: nameFilter,
        type: item.baseType || undefined,
        stats: [{ type: 'and', filters: options.statsFilters || [] }]
      },
      sort: { price: 'asc' }
    };

    return compact(payload);
  }

  /** 仅需要 search id 时的极简体（用于批量估价复用同一 search） */
  function buildFetchUrl(fetchPath, ids, searchId) {
    const idPart = Array.isArray(ids) ? ids.join(',') : String(ids);
    // 没有 search id 时不能拼 ?query=null，否则服务端 400
    if (searchId === null || searchId === undefined || searchId === '') return fetchPath + idPart;
    return fetchPath + idPart + '?query=' + encodeURIComponent(String(searchId));
  }

  function buildSearchUrl(searchPath, league) {
    return searchPath + encodeURIComponent(league);
  }

  PTC.QueryBuilder = { buildSearchQuery, buildFetchUrl, buildSearchUrl, escapeRegex, compact };
})(typeof globalThis !== 'undefined' ? globalThis : self);
