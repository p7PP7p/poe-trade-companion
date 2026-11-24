/**
 * popup/popup.js — 扩展弹窗逻辑（无第三方依赖）
 */
'use strict';

const SETTING_KEYS = [
  'divineToChaos',
  'alertThreshold',
  'scanInterval',
  'shortcut',
  'remoteConfigUrl',
  'sidebarWidth',
  'autoExpand',
  'sidebarEnabled',
  'inlineBadge',
  'floatingBall'
];

const STATS_KEY = 'ptc_daily_stats';
const WATCH_KEY = 'watchlist';
const RATE_CACHE_KEY = 'ptc_rate_cache';
const REMOTE_KEY = 'remoteConfig';
/** 无法从标签页 URL 识别赛季时使用的兜底值（由远端配置刷新） */
let fallbackLeague = 'Covens';

const $ = (id) => document.getElementById(id);

function getSync(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, (got) => resolve(got || {})));
}

function setSync(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, () => resolve(true)));
}

function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (got) => resolve(got || {})));
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        // 读取 lastError 避免控制台报错
        void chrome.runtime.lastError;
        resolve(res || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setStatus(text, warn) {
  const el = $('status');
  el.textContent = text || '';
  el.classList.toggle('warn', !!warn);
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function parseLeagueFromUrl(url) {
  if (!url) return null;
  const m = /pathofexile\.com\/trade\/search\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

function activeTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve((tabs && tabs[0]) || null));
    } catch (e) {
      resolve(null);
    }
  });
}

/* ------------------------------------------------------------------ 渲染 */

/**
 * 比较两个版本号（a > b 返回 1，相等 0，小于 -1）。
 * 仅比较数字段，容忍 "0.1.0" / "0.1.0-beta" 等写法。
 */
function compareVersion(a, b) {
  const pa = String(a || '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 远端配置要求的最低版本高于当前版本时，显示黄色提示横幅 */
function renderUpdateBanner(remoteEntry, currentVersion) {
  const box = $('updateBanner');
  if (!box) return;
  try {
    // 存储结构为 { url, data, savedAt }，兼容直接存配置对象的旧格式
    const remoteConfig = remoteEntry && remoteEntry.data ? remoteEntry.data : remoteEntry;
    const minVersion = remoteConfig && remoteConfig.minExtensionVersion;
    const needUpdate = minVersion && compareVersion(minVersion, currentVersion) > 0;
    if (!needUpdate) {
      box.hidden = true;
      return;
    }
    const cur = $('updateCurrent');
    const latest = $('updateLatest');
    if (cur) cur.textContent = currentVersion;
    if (latest) latest.textContent = minVersion;
    box.hidden = false;
    box.title = (remoteConfig && remoteConfig.notice) || '';
  } catch (e) {
    box.hidden = true;
  }
}

async function render() {
  const settings = Object.assign({}, await getSync(SETTING_KEYS));
  const local = await getLocal([STATS_KEY, WATCH_KEY, RATE_CACHE_KEY, REMOTE_KEY]);

  // 版本
  const currentVersion = chrome.runtime.getManifest().version;
  $('version').textContent = 'v' + currentVersion;
  renderUpdateBanner(local[REMOTE_KEY], currentVersion);
  const remoteCfg = local[REMOTE_KEY] && local[REMOTE_KEY].data ? local[REMOTE_KEY].data : local[REMOTE_KEY];
  if (remoteCfg && remoteCfg.league) fallbackLeague = remoteCfg.league;

  // 开关
  $('toggleInline').checked = settings.inlineBadge !== false;
  $('toggleBall').checked = settings.floatingBall !== false;
  $('toggleAuto').checked = settings.autoExpand === true;

  // 今日增强次数
  const stats = local[STATS_KEY];
  const today = stats && stats.date === todayKey() ? Number(stats.count) || 0 : 0;
  $('todayCount').textContent = String(today);

  // 收藏与提醒
  const list = Array.isArray(local[WATCH_KEY]) ? local[WATCH_KEY] : [];
  $('watchCount').textContent = String(list.length);
  const alerts = list.filter((it) => Number(it.lastAlertAt) > Date.now() - 24 * 3600 * 1000).length;
  $('alertCount').textContent = String(alerts);

  // 联赛
  const tab = await activeTab();
  const league = parseLeagueFromUrl(tab && tab.url) || fallbackLeague;
  $('leagueLine').textContent = '联赛：' + league;

  // 汇率（优先缓存，0 表示自动解析）
  const cached = local[RATE_CACHE_KEY];
  if (Number(settings.divineToChaos) > 0) {
    $('rateValue').textContent = String(Math.round(Number(settings.divineToChaos)));
  } else if (cached && cached.rate > 0) {
    $('rateValue').textContent = String(Math.round(cached.rate));
  } else {
    $('rateValue').textContent = '…';
    const res = await send({ type: 'ptc:get-rate', league, force: false });
    if (res && res.rate > 0) $('rateValue').textContent = String(Math.round(res.rate));
  }

  if (!list.length) setStatus('收藏为空：在侧栏收藏标签页添加物品后可自动追踪降价。');
  else if (alerts > 0) setStatus('近 24 小时有 ' + alerts + ' 件收藏触发降价提醒。');
  else setStatus('就绪 · 快捷键 ' + (settings.shortcut || 'Ctrl+Shift+E') + ' 唤起面板');
}

/* ------------------------------------------------------------------ 事件 */

$('toggleInline').addEventListener('change', async (e) => {
  await setSync({ inlineBadge: e.target.checked });
  setStatus(e.target.checked ? '已开启行内价格增强（刷新市集页生效）' : '已关闭行内价格增强（刷新市集页生效）');
});

$('toggleBall').addEventListener('change', async (e) => {
  await setSync({ floatingBall: e.target.checked });
  setStatus(e.target.checked ? '已显示浮动入口球（刷新市集页生效）' : '已隐藏浮动入口球（刷新市集页生效）');
});

$('toggleAuto').addEventListener('change', async (e) => {
  await setSync({ autoExpand: e.target.checked });
  setStatus(e.target.checked ? '进入市集页将自动展开侧栏（刷新生效）' : '已关闭自动展开（刷新生效）');
});

$('btnOpenTrade').addEventListener('click', async () => {
  const tab = await activeTab();
  const league = parseLeagueFromUrl(tab && tab.url) || fallbackLeague;
  chrome.tabs.create({ url: 'https://www.pathofexile.com/trade/search/' + encodeURIComponent(league) });
  window.close();
});

$('btnCheck').addEventListener('click', async () => {
  const btn = $('btnCheck');
  btn.disabled = true;
  setStatus('正在检查收藏价格…');
  const res = await send({ type: 'ptc:check-watchlist' });
  btn.disabled = false;
  if (!res || !res.ok) {
    setStatus('检查失败：' + ((res && res.error) || '后台无响应'), true);
    return;
  }
  setStatus('检查完成：成功 ' + res.checked + ' 件，触发提醒 ' + res.alerts + ' 件');
  render();
});

$('btnRate').addEventListener('click', async () => {
  const btn = $('btnRate');
  btn.disabled = true;
  setStatus('正在刷新 divine→chaos 汇率…');
  const tab = await activeTab();
  const league = parseLeagueFromUrl(tab && tab.url) || fallbackLeague;
  const res = await send({ type: 'ptc:get-rate', league, force: true });
  btn.disabled = false;
  if (res && res.rate > 0) {
    $('rateValue').textContent = String(Math.round(res.rate));
    const sourceText = res.source === 'user' ? '手动设置' : res.source === 'ninja' ? 'poe.ninja' : '内置兜底值';
    setStatus('汇率已更新：1 divine ≈ ' + Math.round(res.rate) + ' chaos（来源：' + sourceText + '）', res.source === 'fallback');
  } else {
    setStatus('汇率刷新失败，稍后重试或手动设置', true);
  }
});

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

render().catch((err) => setStatus('初始化异常：' + ((err && err.message) || '未知错误'), true));
