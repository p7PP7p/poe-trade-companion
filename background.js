/**
 * background.js — Service Worker
 * 职责：
 *  1) divine→chaos 汇率解析（带 6h 缓存）
 *  2) 收藏降价追踪（定时 alarm + 手动触发），满足阈值发系统通知
 *  3) 远端赛季配置代理（避免页面侧直接跨域）
 *  4) 安装时打开 README 与选项页
 */
'use strict';

importScripts('lib/price-utils.js', 'lib/remote-config.js');

const PU = self.PTC.PriceUtils;
const RC = self.PTC.RemoteConfig;

const WATCH_KEY = 'watchlist';
const ALARM_WATCH = 'ptc-watch-check';
const TRADE_ORIGIN = 'https://www.pathofexile.com';
const ALERT_COOLDOWN = 30 * 60 * 1000; // 同一物品 30 分钟内不重复提醒

const DEFAULT_SETTINGS = {
  alertThreshold: 10,
  scanInterval: 30,
  remoteConfigUrl: RC.DEFAULT_URL,
  // 官网汉化（v0.2.0）：总开关 / 汉化级别 / 数据层热替换 / 词缀模式翻译
  zhEnabled: true,
  zhLevel: 'full',
  zhDataHook: true,
  zhPatterns: true
};

/* ------------------------------------------------------------------ 工具 */

function getSync(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (got) => resolve(got || {}));
  });
}

function getLocal(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (got) => resolve(got || {}));
  });
}

function setLocal(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve(true));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* -------------------------------------------------------------- 汇率 */

async function currentRate(league, force) {
  try {
    return await PU.resolveDivineRate({
      league: league || 'Standard',
      force: !!force,
      fetchImpl: (url, init) => fetch(url, init)
    });
  } catch (e) {
    return { rate: PU.FALLBACK_DIVINE, source: 'fallback' };
  }
}

/* -------------------------------------------------------- 远端配置代理 */

let remoteMemo = null;

async function remoteConfig(url, force) {
  if (remoteMemo && !force && Date.now() - remoteMemo.at < 5 * 60 * 1000) return remoteMemo.value;
  const res = await RC.load({ url, force: !!force });
  remoteMemo = { at: Date.now(), value: res };
  return res;
}

/* ---------------------------------------------------------- 收藏追踪 */

function tradeFetchUrl(ids, queryId) {
  const api = (remoteMemo && remoteMemo.value && remoteMemo.value.config && remoteMemo.value.config.api) || {};
  const path = api.fetchPath || '/api/trade/fetch/';
  const list = (Array.isArray(ids) ? ids : [ids]).slice(0, 10).join(',');
  return TRADE_ORIGIN + path + encodeURIComponent(list) + (queryId ? '?query=' + encodeURIComponent(queryId) : '');
}

async function fetchListing(item) {
  const url = tradeFetchUrl([item.id], item.savedQueryId);
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const row = json && Array.isArray(json.result) ? json.result[0] : null;
  if (!row) return null;
  const price = (row.listing && row.listing.price) || {};
  const rateInfo = await currentRate(item.league, false);
  const chaos = PU.normalizePrice(price.amount, price.currency, { divineRate: rateInfo.rate });
  return {
    chaos,
    amount: price.amount != null ? price.amount : null,
    currency: price.currency || null,
    seller: (row.listing && row.listing.account && row.listing.account.name) || null,
    whisper: (row.listing && row.listing.whisper) || null,
    online: !(row.listing && row.listing.account && row.listing.account.online === false)
  };
}

function notify(id, title, message) {
  try {
    chrome.notifications.create('ptc-' + id, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message,
      priority: 1
    });
  } catch (e) {
    /* 通知失败不影响主流程 */
  }
}

async function checkWatchlist() {
  const gotLocal = await getLocal([WATCH_KEY]);
  const list = Array.isArray(gotLocal[WATCH_KEY]) ? gotLocal[WATCH_KEY] : [];
  if (!list.length) return { ok: true, checked: 0, alerts: 0 };

  const settings = Object.assign({}, DEFAULT_SETTINGS, await getSync(Object.keys(DEFAULT_SETTINGS)));
  const threshold = Number(settings.alertThreshold) > 0 ? Number(settings.alertThreshold) : 10;

  let checked = 0;
  let alerts = 0;
  let changed = false;

  for (const item of list) {
    if (!item || !item.id || !item.savedQueryId) continue;
    try {
      const info = await fetchListing(item);
      if (info && info.chaos > 0) {
        checked += 1;
        const saved = Number(item.savedPrice) > 0 ? Number(item.savedPrice) : info.chaos;
        item.currentPrice = info.chaos;
        item.lastChecked = Date.now();
        if (info.amount != null) {
          item.amount = info.amount;
          item.currency = info.currency;
        }
        if (info.seller) item.seller = info.seller;
        if (info.whisper) item.whisper = info.whisper;
        item.lowest = item.lowest && item.lowest > 0 ? Math.min(item.lowest, info.chaos) : info.chaos;

        const drop = saved > 0 ? ((saved - info.chaos) / saved) * 100 : 0;
        const lastAlert = Number(item.lastAlertAt) || 0;
        if (drop >= threshold && Date.now() - lastAlert > ALERT_COOLDOWN) {
          item.lastAlertAt = Date.now();
          alerts += 1;
          notify(
            item.id,
            '降价提醒：' + (item.name || '收藏物品'),
            '当前 ' + PU.formatChaos(info.chaos, 0) + '（约 ' + Math.round(info.chaos) + ' chaos），已较收藏价下跌 ' + Math.round(drop) + '%'
          );
        }
        changed = true;
      }
    } catch (e) {
      // 401/403 通常表示未登录或会话过期，静默跳过
      if (e && e.status === 429) await sleep(3000);
      else await sleep(400);
    }
    await sleep(500);
  }

  if (changed) await setLocal({ [WATCH_KEY]: list });

  // 角标显示待处理降价数量
  try {
    const pending = list.filter((it) => Number(it.lastAlertAt) > Date.now() - 24 * 3600 * 1000).length;
    chrome.action.setBadgeBackgroundColor({ color: '#b3905a' });
    chrome.action.setBadgeText({ text: pending > 0 ? String(pending) : '' });
  } catch (e) {
    /* ignore */
  }

  return { ok: true, checked, alerts };
}

/* -------------------------------------------------------------- 安装 */

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const settings = await getSync(Object.keys(DEFAULT_SETTINGS));
    const merged = Object.assign({}, DEFAULT_SETTINGS, settings);
    await new Promise((resolve) => chrome.storage.sync.set(merged, resolve));

    await setLocal({ ptc_installed_at: Date.now(), ptc_daily_stats: { date: todayKey(), count: 0 } });

    /* v0.2.2 迁移：旧默认档位 'ui' 只覆盖界面级词库，实测大量固定字段漏翻。
       升级时一次性把档位提升为 'full'（用户之后仍可在选项页手动改回 'ui'）。 */
    try {
      const mark = await getLocal(['ptcZhLevelMigrated']);
      if (!mark || !mark.ptcZhLevelMigrated) {
        if (settings.zhLevel === 'ui') {
          await new Promise((resolve) => chrome.storage.sync.set({ zhLevel: 'full' }, resolve));
        }
        await setLocal({ ptcZhLevelMigrated: '0.2.2' });
      }
    } catch (e) {
      /* 迁移失败不阻断扩展使用 */
    }

    ensureAlarm(Number(merged.scanInterval) || 30);

    if (details.reason === 'install') {
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL('README.md') });
        chrome.runtime.openOptionsPage();
      } catch (e) {
        /* 打开页面失败（如无 tabs 权限）时忽略 */
      }
    }
  } catch (e) {
    /* 安装钩子异常不阻断扩展使用 */
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = Object.assign({}, DEFAULT_SETTINGS, await getSync(Object.keys(DEFAULT_SETTINGS)));
  ensureAlarm(Number(settings.scanInterval) || 30);
});

function ensureAlarm(minutes) {
  try {
    const period = Math.min(120, Math.max(1, Number(minutes) || 30));
    chrome.alarms.get(ALARM_WATCH, (alarm) => {
      if (alarm && alarm.periodInMinutes === period) return;
      chrome.alarms.create(ALARM_WATCH, { periodInMinutes: period });
    });
  } catch (e) {
    /* ignore */
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== ALARM_WATCH) return;
  checkWatchlist().catch(() => {});
});

/* -------------------------------------------------------------- 消息 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  const reply = (obj) => {
    try {
      sendResponse(obj || { ok: false });
    } catch (e) {
      /* ignore */
    }
  };

  if (message.type === 'ptc:get-rate') {
    currentRate(message.league, message.force)
      .then((res) => reply(Object.assign({ ok: true }, res)))
      .catch(() => reply({ ok: false, rate: PU.FALLBACK_DIVINE, source: 'fallback' }));
    return true;
  }

  if (message.type === 'ptc:check-watchlist') {
    checkWatchlist()
      .then((res) => reply(res))
      .catch((err) => reply({ ok: false, error: (err && err.message) || '检查失败' }));
    return true;
  }

  /** 远端词库：dictUrl 指向的 JSON（{ version, dict, byId }），缓存 6 小时，失败静默回退 */
  async function remoteI18nDict(url, force) {
    const KEY = 'ptcI18nCache';
    const TTL = 6 * 60 * 60 * 1000;
    const readCache = () =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.get([KEY], (got) => resolve((got && got[KEY]) || null));
        } catch (e) {
          resolve(null);
        }
      });
    const cached = await readCache();
    const now = Date.now();
    if (!force && cached && cached.dict && cached.savedAt && now - cached.savedAt < TTL && cached.url === url) {
      return { dict: cached.dict, byId: cached.byId || {}, source: 'cache', savedAt: cached.savedAt };
    }
    if (!url || !/^https:\/\//i.test(url)) {
      if (cached && cached.dict) return { dict: cached.dict, byId: cached.byId || {}, source: 'cache', savedAt: cached.savedAt };
      return { dict: {}, byId: {}, source: 'none' };
    }
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const pick = (bag) => {
        const out = {};
        if (!bag || typeof bag !== 'object') return out;
        Object.keys(bag).forEach((k) => {
          if (Object.keys(out).length >= 3000) return;
          const v = bag[k];
          if (typeof k !== 'string' || !k.trim() || k.length > 120) return;
          if (typeof v !== 'string') return;
          const val = v.trim();
          if (!val || val.length > 200) return;
          if (val.indexOf('<') >= 0 || val.indexOf('>') >= 0) return;
          out[k] = val;
        });
        return out;
      };
      /* v0.2.2 词库为分层结构（ui / category / static / terms / supplement）；
         这里按优先级从低到高依次摊平进一张 dict，保证旧版 dict 字段仍可用。 */
      const dict = {};
      const layers = ['supplement', 'ui_gap', 'ui', 'category', 'static', 'terms', 'dict'];
      for (let i = 0; i < layers.length; i++) {
        Object.assign(dict, pick(data && data[layers[i]]));
      }
      const byId = pick(data && data.byId);
      const savedAt = Date.now();
      try {
        chrome.storage.local.set({ [KEY]: { url, savedAt, dict, byId } });
      } catch (e) {
        /* ignore */
      }
      return { dict, byId, source: 'network', savedAt };
    } catch (e) {
      // 拉取失败：优先用过期缓存，否则空表（页面退回内置词库）
      if (cached && cached.dict) return { dict: cached.dict, byId: cached.byId || {}, source: 'stale', savedAt: cached.savedAt };
      return { dict: {}, byId: {}, source: 'error' };
    }
  }

  if (message.type === 'ptc:get-remote-config') {
    remoteConfig(message.url, message.force)
      .then((res) => reply({ ok: true, config: res.config, notice: res.notice, source: res.source, savedAt: res.savedAt }))
      .catch(() => reply({ ok: false }));
    return true;
  }

  if (message.type === 'ptc:get-i18n-dict') {
    (async () => {
      let dictUrl = message.url || '';
      if (!dictUrl) {
        try {
          const res = await remoteConfig(undefined, false);
          const cfg = res && res.config;
          if (cfg && cfg.i18n && typeof cfg.i18n.dictUrl === 'string') dictUrl = cfg.i18n.dictUrl;
        } catch (e) {
          /* ignore */
        }
      }
      const out = await remoteI18nDict(dictUrl, !!message.force);
      reply(Object.assign({ ok: true }, out));
    })();
    return true;
  }

  if (message.type === 'ptc:clear-cache') {
    (async () => {
      remoteMemo = null;
      try {
        await new Promise((resolve) => chrome.storage.local.remove([PU.RATE_CACHE_KEY, 'remoteConfig', 'ptcI18nCache'], resolve));
      } catch (e) {
        /* ignore */
      }
      reply({ ok: true });
    })();
    return true;
  }

  if (message.type === 'ptc:open-options') {
    try {
      chrome.runtime.openOptionsPage();
    } catch (e) {
      /* ignore */
    }
    reply({ ok: true });
    return false;
  }

  if (message.type === 'ptc:set-alarm') {
    ensureAlarm(message.minutes);
    reply({ ok: true });
    return false;
  }

  return false;
});

/* 点击扩展图标时不做跳转（由 popup 承载 UI） */
chrome.action.onClicked.addListener(() => {
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    /* ignore */
  }
});
