/**
 * content/content.js — ISOLATED world 编排层
 *  - 解析 league、加载设置与远端配置
 *  - 接收 inject.js 的数据，计算价格统计，事件分发给 panel.js
 *  - 行内 badge 增强（MutationObserver 节流 200ms，连续失败 5 次降级为侧栏模式）
 *  - 浮动球 + 快捷键入口
 *  - 提供 bridge，供 estimator 通过 inject.js 代发请求
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});
  if (window.__PTC_CONTENT_LOADED__) return;
  window.__PTC_CONTENT_LOADED__ = true;

  const bus = (PTC.bus = PTC.bus || new EventTarget());
  const Selectors = PTC.Selectors;
  const PriceUtils = PTC.PriceUtils;
  const RemoteConfig = PTC.RemoteConfig;

  const DEFAULT_SETTINGS = {
    divineToChaos: 0,
    alertThreshold: 10,
    scanInterval: 30,
    shortcut: 'Ctrl+Shift+E',
    remoteConfigUrl: RemoteConfig.DEFAULT_URL,
    sidebarWidth: 420,
    autoExpand: false,
    sidebarEnabled: true,
    inlineBadge: true,
    floatingBall: true,
    // 汉化设置（与 background / options 三处保持一致）
    zhEnabled: true,
    zhLevel: 'full',
    zhDataHook: true,
    zhPatterns: true
  };

  const STATS_KEY = 'ptc_daily_stats';
  const BADGE_FAIL_LIMIT = 5;

  const state = {
    league: 'Standard',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    remote: null,
    remoteNotice: '',
    userDict: {},
    i18nDict: {},
    // 词缀词库（约 1.8 万条）：内置 JSON 兜底 + 远端赛季更新
    statsById: null,
    statsVersion: '',
    statsCount: 0,
    statsLoaded: false,
    statsLoading: false,
    api: { searchPath: '/api/trade/search/', fetchPath: '/api/trade/fetch/' },
    divineRate: { rate: PriceUtils.FALLBACK_DIVINE, source: 'fallback' },
    searchId: null,
    searchTotal: 0,
    searchIds: [],
    entries: [],
    stats: null,
    badgeFail: 0,
    badgeDisabled: false,
    injected: false,
    pending: new Map(),
    reqSeq: 0,
    badgeObserver: null,
    statBuffer: 0
  };
  PTC.state = state;

  /* -------------------------------------------------- 基础工具 */

  function detectLeague() {
    try {
      const m = location.pathname.match(/\/trade2?\/search\/([^/?#]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
    } catch (e) {
      /* ignore */
    }
    // URL 里没有赛季名时，用远端配置下发的默认赛季
    const remote = state.remote || {};
    return remote.league || 'Covens';
  }

  /**
   * 按远端的 leagueAliases 把旧赛季名映射到新赛季。
   * 赛季更名后，用户收藏的老链接会自动指向新赛季接口，无需改代码发版。
   */
  function resolveLeagueAlias(league) {
    try {
      const aliases = (state.remote && state.remote.leagueAliases) || {};
      const target = aliases[league];
      return typeof target === 'string' && target ? target : league;
    } catch (e) {
      return league;
    }
  }

  /** 赛季变化后同步给侧栏，并重新拉一次该赛季的汇率 */
  function applyLeague(league) {
    const next = resolveLeagueAlias(league);
    if (!next || next === state.league) return;
    state.league = next;
    dispatch('league', { league: next });
  }

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function getSync(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(keys, (got) => {
          resolve(got || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function setSync(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.set(obj, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  function getLocal(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (got) => resolve(got || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function setLocal(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve(true));
      } catch (e) {
        resolve(false);
      }
    });
  }

  function dispatch(type, detail) {
    try {
      bus.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (e) {
      /* ignore */
    }
  }

  /* -------------------------------------------------- 初始化 */

  async function loadSettings() {
    const got = await getSync(Object.keys(DEFAULT_SETTINGS));
    state.settings = Object.assign({}, DEFAULT_SETTINGS, got || {});
    state.settings.sidebarWidth = Math.min(720, Math.max(320, Number(state.settings.sidebarWidth) || 420));
    return state.settings;
  }

  /** 读取用户自定义词库（storage.local.ptcUserDict），失败时退回空表 */
  async function loadUserDict() {
    try {
      const got = await getLocal(['ptcUserDict']);
      state.userDict = sanitizeUserDict(got && got.ptcUserDict);
    } catch (e) {
      state.userDict = {};
    }
    return state.userDict;
  }

  /** 远端词库（config/i18n-zh.json）：由 background 拉取并缓存 6 小时，失败时返回空表 */
  async function loadRemoteI18nDict(force) {
    const cfg = (state.remote && state.remote.i18n) || {};
    const dictUrl = typeof cfg.dictUrl === 'string' ? cfg.dictUrl : '';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ptc:get-i18n-dict', url: dictUrl, force: !!force });
      const dict = res && res.dict && typeof res.dict === 'object' ? res.dict : {};
      const byId = res && res.byId && typeof res.byId === 'object' ? res.byId : {};
      state.i18nDict = dict;
      state.i18nById = byId;
      return { dict, byId, source: (res && res.source) || 'none' };
    } catch (e) {
      state.i18nDict = {};
      return { dict: {}, byId: {}, source: 'error' };
    }
  }

  /* -------------------------------------------------- 汉化（页面文案） */

  /**
   * 词缀词库（约 1.8 万条）：内置 config/i18n-stats-zh.json 兜底，远端按赛季覆盖。
   * 体量约 1.2MB，异步加载，不阻塞首屏；到货后返回 true 触发一次重新应用。
   */
  async function loadStatsDict(force) {
    const StatsDict = PTC.StatsDict;
    if (!StatsDict) {
      // 模块缺失（旧版 manifest 未打包 stats-dict.js）：直接放行，避免 data 层请求被挂起
      state.statsLoaded = true;
      return false;
    }
    if (state.statsLoading) return false;

    state.statsLoading = true;
    const before = state.statsVersion;
    try {
      const cfg = (state.remote && state.remote.i18n) || {};
      const result = await StatsDict.load({
        statsUrl: typeof cfg.statsUrl === 'string' ? cfg.statsUrl : '',
        enabled: state.settings.zhEnabled !== false,
        force: !!force
      });
      if (result && result.byId) {
        state.statsById = result.byId;
        state.statsVersion = result.version || '';
        state.statsCount = result.count || 0;
        state.statsSource = result.source || 'builtin';
      }
    } catch (e) {
      /* 词库不可用时保留既有表，汉化降级为 UI 词库 */
    } finally {
      state.statsLoading = false;
      state.statsLoaded = true;
    }
    return before !== state.statsVersion;
  }

  /** 内置词库（由 lib/i18n-dict.js 挂到 window.PTC_I18N） */
  function i18nBuiltin() {
    const d = window.PTC_I18N;
    return d && typeof d === 'object' ? d : null;
  }

  /** 用户自定义词库（options 保存到 storage.local.ptcUserDict） */
  function sanitizeUserDict(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach((k) => {
      const key = String(k || '').trim();
      const val = raw[k];
      if (!key || key.length > 120) return;
      if (typeof val !== 'string') return;
      const v = val.trim();
      if (!v || v.length > 200) return;
      if (v.indexOf('<') !== -1 || v.indexOf('>') !== -1) return;
      out[key] = v;
    });
    return out;
  }

  /**
   * 按当前设置应用汉化：
   *  - 通道 A：把开关与词典下发给 MAIN world 的 inject.js，改写 /api/trade/data/* 响应
   *  - 通道 B：配置 DOM 层 Localizer（文本节点 + placeholder/title/aria-label）
   * 词典优先级：用户自定义 > 远端配置 > 内置；zhLevel='ui' 只译界面文案。
   */
  function applyI18n() {
    const s = state.settings || {};
    const builtin = i18nBuiltin() || {};
    const level = s.zhLevel === 'ui' ? 'ui' : 'full';
    const remoteI18n = (state.remote && state.remote.i18n) || {};
    // 词库叠加顺序：远端词库文件 < remote.json 内联词条（后者覆盖前者）
    const overlay = Object.assign({}, state.i18nDict || {}, remoteI18n.dict && typeof remoteI18n.dict === 'object' ? remoteI18n.dict : {});
    const userDict = sanitizeUserDict(state.userDict);
    const enabled = !!s.zhEnabled;
    // 写入同源镜像，供 MAIN world 在 document_start 阶段提前得知开关（首屏 stats 请求不漏翻）
    try {
      if (enabled) localStorage.setItem('ptc:zhEnabled', '1');
      else localStorage.removeItem('ptc:zhEnabled');
    } catch (e) {
      /* 存储被禁时忽略 */
    }
    const hookEnabled = enabled && !!s.zhDataHook;
    const patterns = s.zhPatterns !== false;
    // 词缀词库（约 1.8 万条）与版本号，注入到两条通道
    const statsById = state.statsById && state.statsCount > 0 ? state.statsById : null;
    const statsVer = state.statsVersion || '';

    // 通道 A：数据层（MAIN world）
    try {
      window.postMessage(
        {
          source: 'ptc-cmd',
          cmd: 'i18n',
          payload: {
            enabled: hookEnabled,
            level,
            patterns,
            dict: Object.keys(overlay).length || Object.keys(userDict).length
              ? Object.assign({}, overlay, userDict)
              : null,
            // 词缀词库 + 版本号：inject.js 按版本判断是否重建大表
            byId: statsById,
            byIdVersion: statsVer,
            statsDictLoaded: state.statsLoaded !== false
          }
        },
        '*'
      );
    } catch (e) {
      /* ignore */
    }

    // 通道 B：页面层（ISOLATED world）
    const Localizer = PTC.Localizer;
    if (!Localizer) return null;
    let byId = Object.assign({}, builtin.byId || {}, state.i18nById || {});
    if (remoteI18n.byId) byId = Object.assign({}, byId, remoteI18n.byId);
    if (statsById) byId = Object.assign({}, byId, statsById);
    try {
      return Localizer.configure({
        enabled,
        level,
        patterns,
        dict: builtin.dict || {},
        uiDict: builtin.uiDict || builtin.dict || {},
        fullDict: builtin.fullDict || {},
        remoteDict: overlay,
        userDict,
        patternsList: builtin.patterns || [],
        byId
      });
    } catch (e) {
      return null;
    }
  }

  async function loadRemoteConfig(force) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ptc:get-remote-config',
        force: !!force,
        url: state.settings.remoteConfigUrl
      });
      if (res && res.config) {
        state.remote = res.config;
        state.remoteNotice = res.notice || '';
        state.api = Object.assign({}, state.api, res.config.api || {});
        // 选择器覆盖（远端优先，本地候选兜底）
        Selectors.applyRemote(res.config.selectors);
        // 把 API 路径同步给 MAIN world
        window.postMessage({ source: 'ptc-cmd', cmd: 'config', payload: state.api }, '*');
        // 赛季别名映射（旧赛季名 → 新赛季名），变化时重新拉汇率
        const resolved = resolveLeagueAlias(state.league);
        if (resolved && resolved !== state.league) {
          state.league = resolved;
          dispatch('league', { league: resolved });
          loadRate(false);
        }
      }
    } catch (e) {
      /* 背景不可用时使用本地默认值 */
    }
  }

  async function loadRate(force) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ptc:get-rate', league: state.league, force: !!force });
      if (res && res.rate > 0) {
        state.divineRate = { rate: res.rate, source: res.source || 'ninja' };
      }
    } catch (e) {
      /* 留用兜底汇率 */
    }
    dispatch('rate', state.divineRate);
  }

  /* -------------------------------------------------- 数据桥 */

  function bridgeCall(payload) {
    return PTC.rateLimiter.run(
      () =>
        new Promise((resolve, reject) => {
          const reqId = 'q' + Date.now().toString(36) + '_' + (state.reqSeq += 1);
          const timer = setTimeout(() => {
            state.pending.delete(reqId);
            reject(new Error('请求超时'));
          }, 20000);
          state.pending.set(reqId, { resolve, reject, timer });
          try {
            window.postMessage(
              { source: 'ptc-cmd', cmd: 'request', payload: Object.assign({}, payload, { reqId }) },
              '*'
            );
          } catch (e) {
            clearTimeout(timer);
            state.pending.delete(reqId);
            reject(e);
          }
        })
    );
  }

  PTC.bridge = { call: bridgeCall };

  /* -------------------------------------------------- 消息接收 */

  function onWindowMessage(event) {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'ptc') return;

      if (data.type === 'ready') {
        state.injected = true;
        window.postMessage({ source: 'ptc-cmd', cmd: 'config', payload: state.api }, '*');
        // MAIN world 就绪后补发一次汉化配置（init 可能早于 inject 注入完成）
        setTimeout(() => applyI18n(), 0);
        return;
      }

      if (data.type === 'i18n-ready') {
        // 数据层词典已载入，记录一次以便面板/选项页展示
        state.i18nData = data.payload || null;
        return;
      }

      if (data.type === 'trade-result') {
        const item = state.pending.get(data.reqId);
        if (!item) return;
        state.pending.delete(data.reqId);
        clearTimeout(item.timer);
        if (data.headers) {
          try {
            PTC.rateLimiter.updateFromHeaders(data.headers);
          } catch (e) {
            /* ignore */
          }
        }
        item.resolve({ ok: !!data.ok, status: data.status || 0, data: data.data || null, headers: data.headers || {} });
        return;
      }

      if (data.type === 'trade-response') {
        handleTradeResponse(data);
      }
    } catch (e) {
      /* 消息处理异常不影响页面 */
    }
  }

  function handleTradeResponse(msg) {
    const response = msg.response;
    if (!response) return;

    if (msg.kind === 'search') {
      state.searchId = response.id || null;
      state.searchTotal = typeof response.total === 'number' ? response.total : 0;
      state.searchIds = Array.isArray(response.result) ? response.result.slice(0, 200) : [];
      // 新一轮搜索：重置降级状态，允许再次尝试行内增强
      state.badgeFail = 0;
      state.badgeDisabled = false;
      dispatch('search', {
        searchId: state.searchId,
        total: state.searchTotal,
        ids: state.searchIds,
        league: state.league
      });
      return;
    }

    if (msg.kind === 'fetch') {
      const entries = PTC.Estimator.normalizeEntries(response.result, state.divineRate.rate);
      const list = entries.map((e) => e.chaos).filter((v) => typeof v === 'number' && v > 0);
      state.entries = entries;
      state.stats = PriceUtils.stats(list);
      dispatch('data', {
        entries,
        stats: state.stats,
        total: state.searchTotal || entries.length,
        searchId: state.searchId,
        league: state.league,
        rate: state.divineRate
      });
      if (state.settings.autoExpand && PTC.Panel) PTC.Panel.open();
    }
  }

  /* -------------------------------------------------- 行内徽标 */

  function bumpStat(count) {
    state.statBuffer += count || 0;
    if (state.statBuffer < 5) return;
    const inc = state.statBuffer;
    state.statBuffer = 0;
    (async () => {
      const got = await getLocal([STATS_KEY]);
      const today = todayKey();
      const cur = got[STATS_KEY] || {};
      const entry = cur.date === today ? cur : { date: today, count: 0 };
      entry.count = (entry.count || 0) + inc;
      await setLocal({ [STATS_KEY]: entry });
      dispatch('stats', entry);
    })();
  }

  function formatBadge(chaos) {
    return '≈ ' + PriceUtils.formatChaos(chaos, state.divineRate.rate);
  }

  function collectRows() {
    let rows = Selectors.findAll(document, Selectors.SELECTORS.resultRow);
    if (!rows.length) return [];
    // 过滤掉明显不是结果行的元素（必须含价格或物品名）
    const filtered = rows.filter((row) => {
      try {
        if (!(row instanceof HTMLElement)) return false;
        if (row.querySelector(SELECTORS_PRICE_SELECTOR)) return true;
        return !!Selectors.findFirst(row, Selectors.SELECTORS.itemNameInRow);
      } catch (e) {
        return false;
      }
    });
    return filtered.length ? filtered : rows;
  }

  let SELECTORS_PRICE_SELECTOR = '.price, [class*="price"], .details .price';

  function enhanceRows() {
    if (!state.settings.inlineBadge || state.badgeDisabled) return;
    try {
      SELECTORS_PRICE_SELECTOR = Selectors.SELECTORS.priceInRow[0] || '.price';
      const rows = collectRows();
      if (!rows.length) return;

      let inserted = 0;
      rows.forEach((row, index) => {
        try {
          if (row.dataset && row.dataset.ptcEnhanced === '1') {
            inserted += 1;
            return;
          }
          const priceEl = Selectors.findFirst(row, Selectors.SELECTORS.priceInRow);
          if (!priceEl) return;
          const parsedPrice = PriceUtils.parsePriceText(Selectors.textOf(priceEl));
          if (!parsedPrice) return;
          const chaos = PriceUtils.normalizePrice(parsedPrice.amount, parsedPrice.currency, {
            divineRate: state.divineRate.rate
          });
          if (!chaos) return;

          const badge = document.createElement('span');
          badge.className = 'ptc-inline-badge';
          badge.textContent = formatBadge(chaos);
          badge.title = 'PoE Trade Companion：估算 chaos 等值，点击打开价格面板';
          badge.style.cssText =
            'display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;' +
            'background:rgba(200,161,101,.16);border:1px solid rgba(200,161,101,.55);' +
            'color:#c8a165;font-size:11px;line-height:16px;font-family:system-ui,"Microsoft YaHei",sans-serif;' +
            'white-space:nowrap;cursor:pointer;vertical-align:middle;';

          badge.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (PTC.Panel) PTC.Panel.open();
            const entry = state.entries[index];
            if (entry && entry.whisper) {
              PTC.Panel.copyText(entry.whisper);
              PTC.Panel.toast('已复制私聊文本');
            }
          });

          if (priceEl.parentElement && priceEl.insertAdjacentElement) {
            priceEl.insertAdjacentElement('afterend', badge);
          } else {
            priceEl.appendChild(badge);
          }

          if (row.dataset) row.dataset.ptcEnhanced = '1';
          inserted += 1;
        } catch (e) {
          /* 单行失败不影响其它行 */
        }
      });

      if (inserted > 0) {
        state.badgeFail = 0;
        bumpStat(inserted);
      } else if (rows.length > 0) {
        state.badgeFail += 1;
        if (state.badgeFail >= BADGE_FAIL_LIMIT && !state.badgeDisabled) {
          state.badgeDisabled = true;
          dispatch('notice', {
            level: 'warn',
            message: '页面结构可能已更新，已切换为侧栏模式'
          });
        }
      }
    } catch (e) {
      /* 整体失败也只是少了徽标 */
    }
  }

  function startObserver() {
    if (state.badgeObserver) return;
    let timer = null;
    try {
      state.badgeObserver = new MutationObserver(() => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          enhanceRows();
        }, 200); // 节流 200ms
      });
      state.badgeObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      /* 观察器不可用时放弃行内增强 */
    }
  }

  /* -------------------------------------------------- 入口与快捷键 */

  function parseShortcut(str) {
    const parts = String(str || 'Ctrl+Shift+E')
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    return {
      ctrl: parts.indexOf('ctrl') >= 0,
      shift: parts.indexOf('shift') >= 0,
      alt: parts.indexOf('alt') >= 0,
      meta: parts.indexOf('meta') >= 0,
      key: parts.filter((p) => ['ctrl', 'shift', 'alt', 'meta'].indexOf(p) < 0)[0] || 'e'
    };
  }

  function matchShortcut(ev) {
    const s = parseShortcut(state.settings.shortcut);
    const key = String(ev.key || '').toLowerCase();
    if (key !== s.key) return false;
    return (
      ev.ctrlKey === s.ctrl &&
      ev.shiftKey === s.shift &&
      ev.altKey === s.alt &&
      ev.metaKey === s.meta
    );
  }

  function onKeydown(ev) {
    try {
      const target = ev.target;
      const tag = target && target.tagName ? target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
      if (matchShortcut(ev)) {
        ev.preventDefault();
        if (PTC.Panel) PTC.Panel.toggle();
      }
    } catch (e) {
      /* ignore */
    }
  }

  /* -------------------------------------------------- 启动 */

  async function init() {
    state.league = detectLeague();

    await loadSettings();
    await loadRate(false);
    await loadRemoteConfig(false);
    await loadRemoteI18nDict(false);
    await loadUserDict();
    applyI18n();

    // 词缀词库（约 1.2MB）异步加载，不阻塞首屏；到货后补齐筛选器与词缀汉化
    loadStatsDict(false)
      .then((changed) => {
        if (changed || state.statsCount > 0) applyI18n();
      })
      .catch(() => {});

    if (PTC.Panel && typeof PTC.Panel.init === 'function') {
      PTC.Panel.init({
        league: state.league,
        settings: state.settings,
        divineRate: state.divineRate
      });
    }

    window.addEventListener('message', onWindowMessage, false);
    document.addEventListener('keydown', onKeydown, true);

    // MAIN world 注入兜底：Chrome <111 或 world:MAIN 未生效时手动注入脚本
    setTimeout(() => {
      if (state.injected) return;
      try {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('content/inject.js');
        script.onload = () => {
          try {
            script.remove();
          } catch (e) {
            /* ignore */
          }
        };
        (document.head || document.documentElement).appendChild(script);
      } catch (e) {
        /* 兜底失败则仅使用侧栏功能（手动粘贴文本估价） */
      }
    }, 1200);

    startObserver();
    setTimeout(enhanceRows, 800);

    // 设置变更后实时生效
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          // 用户词库或远端词库缓存更新：重新应用汉化（含"清空自定义词库"场景）
          if (changes.ptcUserDict) {
            state.userDict = sanitizeUserDict(changes.ptcUserDict.newValue);
            applyI18n();
          } else if (changes.ptcI18nCache) {
            applyI18n();
          } else if (changes.ptcStatsDict) {
            // 远端词缀词库缓存更新（新赛季词条）：重新展开并应用
            loadStatsDict(false)
              .then(() => applyI18n())
              .catch(() => {});
          }
          return;
        }
        if (area !== 'sync') return;
        let touched = false;
        Object.keys(changes).forEach((key) => {
          if (key in DEFAULT_SETTINGS) {
            state.settings[key] = changes[key].newValue;
            touched = true;
          }
        });
        if (!touched) return;
        if (PTC.Panel) PTC.Panel.applySettings(state.settings);
        applyI18n();
        if (state.settings.inlineBadge && state.badgeDisabled) {
          state.badgeFail = 0;
          state.badgeDisabled = false;
        }
        enhanceRows();
      });
    } catch (e) {
      /* ignore */
    }

    // 选项页「立即还原英文 / 重新启用汉化」即时生效，无需刷新页面
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.type !== 'ptc:set-i18n') return undefined;
        if (typeof msg.enabled === 'boolean') {
          state.settings.zhEnabled = msg.enabled;
          setSync({ zhEnabled: msg.enabled }).catch(() => {});
        }
        if (msg.level === 'ui' || msg.level === 'full') state.settings.zhLevel = msg.level;
        applyI18n();
        sendResponse({ ok: true, summary: (PTC.Localizer && PTC.Localizer.summary()) || null });
        return true;
      });
    } catch (e) {
      /* ignore */
    }

    dispatch('league', { league: state.league });
    dispatch('notice', { level: 'info', message: state.remoteNotice || '' });

    // 定期刷新汇率（1 小时）
    setInterval(() => loadRate(false), 60 * 60 * 1000);
  }

  PTC.content = { state, enhanceRows, init, dispatch, applyI18n, loadStatsDict };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
