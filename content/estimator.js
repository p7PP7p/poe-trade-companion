/**
 * content/estimator.js
 * 估价引擎：物品文本 → 查询构造 → 搜索 → 拉取样例 → 统计与建议价。
 * 所有网络请求都通过 inject.js 代发（复用页面同源 session），并受 rate-limiter 节流。
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});
  const DEFAULT_API = { searchPath: '/api/trade/search/', fetchPath: '/api/trade/fetch/' };

  function apiPaths(api) {
    return Object.assign({}, DEFAULT_API, api && typeof api === 'object' ? api : {});
  }

  /** 归一化 fetch 响应里的挂单 */
  function normalizeEntries(rows, divineRate) {
    const list = Array.isArray(rows) ? rows : [];
    return list
      .map((row) => {
        try {
          const item = (row && row.item) || {};
          const listing = (row && row.listing) || {};
          const price = listing.price || {};
          const chaos = PTC.PriceUtils.normalizePrice(price.amount, price.currency, { divineRate });
          return {
            id: row && row.id,
            name: item.name || item.typeLine || '未知物品',
            baseType: item.typeLine || null,
            icon: item.icon || null,
            seller: (listing.account && listing.account.name) || null,
            online:
              !listing.account || listing.account.online === undefined
                ? true
                : !!listing.account.online,
            amount: price.amount != null ? price.amount : null,
            currency: price.currency || null,
            chaos,
            indexed: listing.indexed || null,
            whisper: listing.whisper || null,
            mods: Array.isArray(item.explicitMods) ? item.explicitMods : []
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  }

  function prices(entries) {
    return entries.map((e) => e.chaos).filter((v) => typeof v === 'number' && v > 0);
  }

  async function callBridge(payload) {
    if (!PTC.bridge || typeof PTC.bridge.call !== 'function') {
      return { ok: false, status: 0, error: '数据通道未就绪' };
    }
    try {
      const res = await PTC.bridge.call(payload);
      if (!res) return { ok: false, status: 0, error: '通道无响应' };
      return res;
    } catch (e) {
      // 断网 / 通道超时一律降级为失败结果，不向调用方抛错
      return { ok: false, status: 0, error: (e && e.message) || '网络异常' };
    }
  }

  /**
   * 对任意物品文本估价
   * @param {string} text 游戏内 Ctrl+C 复制的物品文本
   * @param {Object} opts {league, api, divineRate, sampleSize, onStage}
   * @returns {Promise<Object>}
   */
  async function estimateFromText(text, opts) {
    const options = opts || {};
    const stage = typeof options.onStage === 'function' ? options.onStage : function () {};
    const api = apiPaths(options.api);
    const divineRate = options.divineRate > 0 ? options.divineRate : PTC.PriceUtils.FALLBACK_DIVINE;
    const league = options.league || 'Standard';

    const parsed = PTC.ItemParser.parse(text || '');
    if (!parsed.valid) {
      return {
        ok: false,
        parsed,
        error: '未识别到物品，请确认是从游戏内复制的物品文本'
      };
    }

    stage('正在提交搜索…');
    const body = PTC.QueryBuilder.buildSearchQuery(parsed, league, { online: true });
    const searchUrl = PTC.QueryBuilder.buildSearchUrl(api.searchPath, league);
    const searchRes = await callBridge({ method: 'POST', url: searchUrl, body });

    if (!searchRes || !searchRes.ok || !searchRes.data) {
      const reason = searchRes && searchRes.status ? 'HTTP ' + searchRes.status : '网络异常';
      return { ok: false, parsed, error: '搜索失败（' + reason + '），请确认已登录市集页面后重试' };
    }

    const searchData = searchRes.data;
    const ids = Array.isArray(searchData.result) ? searchData.result : [];
    if (!ids.length) {
      return {
        ok: true,
        parsed,
        count: 0,
        total: searchData.total || 0,
        stats: null,
        samples: [],
        message: '未找到在线挂单，可尝试放宽筛选条件'
      };
    }

    stage('正在拉取挂单价格…');
    const sampleSize = Math.min(options.sampleSize || 20, 20);
    const fetchUrl = PTC.QueryBuilder.buildFetchUrl(api.fetchPath, ids.slice(0, sampleSize), searchData.id);
    const fetchRes = await callBridge({ method: 'GET', url: fetchUrl });

    if (!fetchRes || !fetchRes.ok || !fetchRes.data) {
      return { ok: false, parsed, error: '拉取挂单失败，请稍后重试' };
    }

    const entries = normalizeEntries(fetchRes.data.result, divineRate);
    const priceList = prices(entries);
    const stat = PTC.PriceUtils.stats(priceList);
    const suggested = PTC.PriceUtils.round2(PTC.PriceUtils.percentile(priceList.slice().sort((a, b) => a - b), 0.4));

    return {
      ok: true,
      parsed,
      league,
      searchId: searchData.id,
      total: searchData.total || ids.length,
      sampled: entries.length,
      stats: stat,
      suggested: suggested || null,
      low: stat.p25,
      high: stat.p75,
      samples: entries,
      message: null
    };
  }

  /**
   * 批量估价当前搜索结果（分批 10 个 id，最多 200 条）
   * @param {{searchId:string, ids:string[], league:string, api:Object, divineRate:number, onProgress:Function}} opts
   */
  async function estimateAll(opts) {
    const options = opts || {};
    const api = apiPaths(options.api);
    const divineRate = options.divineRate > 0 ? options.divineRate : PTC.PriceUtils.FALLBACK_DIVINE;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
    const ids = Array.isArray(options.ids) ? options.ids.slice(0, 200) : [];
    const searchId = options.searchId;

    if (!searchId || !ids.length) {
      return { ok: false, error: '暂无可估价的结果，请先执行一次市集搜索' };
    }

    const out = [];
    const batchSize = 10;
    const batches = Math.ceil(ids.length / batchSize);

    for (let i = 0; i < batches; i += 1) {
      const slice = ids.slice(i * batchSize, (i + 1) * batchSize);
      const url = PTC.QueryBuilder.buildFetchUrl(api.fetchPath, slice, searchId);
      let res = null;
      try {
        res = await callBridge({ method: 'GET', url });
      } catch (e) {
        res = null;
      }
      if (res && res.ok && res.data) {
        const entries = normalizeEntries(res.data.result, divineRate).filter((e) => e.online !== false);
        out.push.apply(out, entries);
      }
      onProgress({ done: Math.min((i + 1) * batchSize, ids.length), total: ids.length, percent: Math.round(((i + 1) / batches) * 100) });
    }

    const list = prices(out);
    const suggested = list.length
      ? PTC.PriceUtils.round2(PTC.PriceUtils.percentile(list.slice().sort((a, b) => a - b), 0.4))
      : null;

    return {
      ok: true,
      entries: out,
      stats: PTC.PriceUtils.stats(list),
      suggested,
      count: out.length,
      total: ids.length
    };
  }

  PTC.Estimator = { estimateFromText, estimateAll, normalizeEntries, prices, apiPaths };
})(typeof globalThis !== 'undefined' ? globalThis : self);
