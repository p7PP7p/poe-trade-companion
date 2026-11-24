/**
 * options/options.js — 选项页逻辑（无第三方依赖）
 */
'use strict';

const DEFAULT_REMOTE_URL =
  'https://raw.githubusercontent.com/poe-trade-companion/poe-trade-companion/main/config/remote.json';

const DEFAULTS = {
  divineToChaos: 0,
  alertThreshold: 10,
  scanInterval: 30,
  shortcut: 'Ctrl+Shift+E',
  remoteConfigUrl: DEFAULT_REMOTE_URL,
  sidebarWidth: 420,
  autoExpand: false,
  sidebarEnabled: true,
  inlineBadge: true,
  floatingBall: true,
  // 官网汉化（v0.2.0）
  zhEnabled: true,
  zhLevel: 'full',
  zhDataHook: true,
  zhPatterns: true
};

const NUMBER_FIELDS = ['divineToChaos', 'alertThreshold', 'scanInterval', 'sidebarWidth'];
const TEXT_FIELDS = ['shortcut', 'remoteConfigUrl'];
const BOOL_FIELDS = [
  'inlineBadge',
  'floatingBall',
  'sidebarEnabled',
  'autoExpand',
  'zhEnabled',
  'zhDataHook',
  'zhPatterns'
];

const $ = (id) => document.getElementById(id);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function getSync(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, (got) => resolve(got || {})));
}

function setSync(obj) {
  return new Promise((resolve) => chrome.storage.sync.set(obj, () => resolve(true)));
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.classList.remove('ok', 'warn');
  if (kind) el.classList.add(kind);
}

function fillForm(settings) {
  const s = Object.assign({}, DEFAULTS, settings);
  NUMBER_FIELDS.forEach((k) => {
    $(k).value = String(s[k] === undefined || s[k] === null ? DEFAULTS[k] : s[k]);
  });
  TEXT_FIELDS.forEach((k) => {
    $(k).value = s[k] == null ? DEFAULTS[k] : String(s[k]);
  });
  BOOL_FIELDS.forEach((k) => {
    $(k).checked = s[k] !== undefined ? !!s[k] : !!DEFAULTS[k];
  });
  // 汉化范围下拉
  const levelSel = $('zhLevel');
  if (levelSel) levelSel.value = s.zhLevel === 'ui' ? 'ui' : 'full';
}

function readForm() {
  const out = {};
  NUMBER_FIELDS.forEach((k) => {
    out[k] = Number($(k).value);
  });
  TEXT_FIELDS.forEach((k) => {
    out[k] = String($(k).value || '').trim();
  });
  BOOL_FIELDS.forEach((k) => {
    out[k] = !!$(k).checked;
  });

  const levelSel = $('zhLevel');
  out.zhLevel = levelSel && levelSel.value === 'ui' ? 'ui' : 'full';

  // 归一化与兜底
  out.divineToChaos = clamp(out.divineToChaos, 0, 100000, DEFAULTS.divineToChaos);
  out.alertThreshold = clamp(out.alertThreshold, 1, 90, DEFAULTS.alertThreshold);
  out.scanInterval = clamp(out.scanInterval, 1, 120, DEFAULTS.scanInterval);
  out.sidebarWidth = clamp(out.sidebarWidth, 320, 720, DEFAULTS.sidebarWidth);
  if (!out.shortcut) out.shortcut = '';
  if (out.remoteConfigUrl && !/^https?:\/\//i.test(out.remoteConfigUrl)) {
    out.remoteConfigUrl = '';
  }
  return out;
}

/* ------------------------------------------------------------------ 初始化 */

async function init() {
  $('ver').textContent = chrome.runtime.getManifest().version;
  const settings = await getSync(Object.keys(DEFAULTS));
  fillForm(settings);
  setStatus('修改后请点击「保存设置」，并刷新市集页面使界面配置生效。');
}

/* ------------------------------------------------------------------ 保存 */

$('btnSave').addEventListener('click', async () => {
  const settings = readForm();
  await setSync(settings);
  fillForm(settings);
  try {
    chrome.runtime.sendMessage({ type: 'ptc:set-alarm', minutes: settings.scanInterval }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* 后台未响应时不影响已保存的设置 */
  }
  setStatus(
    '已保存。\n' +
      '· 汇率：' + (settings.divineToChaos > 0 ? '手动 ' + settings.divineToChaos : '自动（6 小时缓存）') + '\n' +
      '· 降价阈值：' + settings.alertThreshold + '%　检查间隔：' + settings.scanInterval + ' 分钟\n' +
      '· 侧栏宽度：' + settings.sidebarWidth + 'px　快捷键：' + (settings.shortcut || '未设置') + '\n' +
      '提示：已打开的市集页需刷新后才会应用界面相关改动。',
    'ok'
  );
});

/* ------------------------------------------------------------------ 重置 */

$('btnReset').addEventListener('click', async () => {
  fillForm(DEFAULTS);
  await setSync(DEFAULTS);
  try {
    chrome.runtime.sendMessage({ type: 'ptc:set-alarm', minutes: DEFAULTS.scanInterval }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {
    /* ignore */
  }
  setStatus('已恢复默认设置。', 'ok');
});

/* -------------------------------------------------------------- 测试远端 */

$('btnTest').addEventListener('click', async () => {
  const url = String($('remoteConfigUrl').value || '').trim();
  if (!url) {
    setStatus('未填写远端配置 URL：将完全使用扩展内置选择器。', 'warn');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    setStatus('URL 必须以 http:// 或 https:// 开头。', 'warn');
    return;
  }

  setStatus('正在拉取远端配置…');
  const res = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'ptc:get-remote-config', url, force: true }, (r) => {
        void chrome.runtime.lastError;
        resolve(r || null);
      });
    } catch (e) {
      resolve(null);
    }
  });

  if (!res || !res.ok || !res.config) {
    setStatus(
      '拉取失败：远端不可达、JSON 非法或字段校验未通过。\n扩展会自动回退到内置默认选择器，功能不受影响。',
      'warn'
    );
    return;
  }

  const cfg = res.config;
  const selectorKeys = cfg.selectors ? Object.keys(cfg.selectors) : [];
  const lines = [
    '拉取成功（来源：' + (res.source || 'remote') + '）。',
    '· schemaVersion：' + (cfg.schemaVersion != null ? cfg.schemaVersion : '-'),
    '· minExtensionVersion：' + (cfg.minExtensionVersion || '-'),
    '· 选择器覆盖项：' + (selectorKeys.length ? selectorKeys.join('、') : '无'),
    '· 搜索接口：' + ((cfg.api && cfg.api.searchPath) || '-'),
    '· 取样接口：' + ((cfg.api && cfg.api.fetchPath) || '-')
  ];
  if (cfg.notice) lines.push('· 公告：' + cfg.notice);
  if (res.savedAt) {
    const d = new Date(res.savedAt);
    lines.push('· 缓存时间：' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0'));
  }
  lines.push('刷新市集页面后生效。');
  setStatus(lines.join('\n'), 'ok');
});

/* -------------------------------------------------------------- 清缓存 */

$('btnClearCache').addEventListener('click', async () => {
  const res = await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'ptc:clear-cache' }, (r) => {
        void chrome.runtime.lastError;
        resolve(r || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
  if (res && res.ok) setStatus('已清空汇率缓存与远端配置缓存，下次使用时会重新拉取。', 'ok');
  else setStatus('清空失败：后台无响应，请重新加载扩展后再试。', 'warn');
});

/* ---------------------------------------------------- 双栏联动的小优化 */

$('sidebarEnabled').addEventListener('change', (e) => {
  if (!e.target.checked) {
    // 侧栏关闭时，浮动球与自动展开实际不再生效，仅做视觉提示
    setStatus('已关闭侧栏：保存后仅保留行内价格增强，浮动球与自动展开不再生效。', 'warn');
  } else {
    setStatus('已启用侧栏，保存后刷新页面即可看到入口。');
  }
});

/* ---------------------------------------------------- 汉化词库管理 */

const DICT_KEY = 'ptcUserDict';

/** 与 content/localizer.js 保持同一套清洗规则，避免脏数据进入页面 */
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

/** textarea 文本 → 词库对象；每行「英文=中文」，允许 # 开头注释与空行 */
function parseDictText(text) {
  const dict = {};
  const invalid = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line, idx) => {
      const raw = line.trim();
      if (!raw || raw.charAt(0) === '#') return;
      const pos = raw.indexOf('=');
      if (pos <= 0) {
        invalid.push(idx + 1);
        return;
      }
      const k = raw.slice(0, pos).trim();
      const v = raw.slice(pos + 1).trim();
      if (!k || !v) {
        invalid.push(idx + 1);
        return;
      }
      dict[k] = v;
    });
  return { dict: sanitizeUserDict(dict), invalid };
}

function dictToText(dict) {
  return Object.keys(dict || {})
    .map((k) => k + '=' + dict[k])
    .join('\n');
}

function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (got) => resolve(got || {})));
}

function setLocal(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve(true)));
}

function setDictMsg(text, kind) {
  const el = $('zhDictMsg');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'warn');
  if (kind) el.classList.add(kind);
}

/** 通知已打开的市集页面即时生效（失败静默，页面刷新后同样生效） */
async function broadcastI18n(enabled, level) {
  try {
    const tabs = await new Promise((resolve) =>
      chrome.tabs.query({ url: ['https://www.pathofexile.com/trade/*', 'https://*.pathofexile.com/trade/*'] }, (list) => resolve(list || []))
    );
    tabs.forEach((tab) => {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'ptc:set-i18n', enabled, level }, () => void chrome.runtime.lastError);
    });
  } catch (e) {
    /* 无标签页权限或页面未注入时忽略 */
  }
}

async function refreshUserDict() {
  const got = await getLocal([DICT_KEY]);
  const dict = sanitizeUserDict(got && got[DICT_KEY]);
  const ta = $('zhUserDict');
  if (ta) ta.value = dictToText(dict);
  const stat = $('zhDictStat');
  if (stat) stat.textContent = '自定义词库：' + Object.keys(dict).length + ' 条（保存后对已打开页面即时生效）';
  return dict;
}

/** 显示内置/远端/自定义三栏统计 */
async function showI18nStat() {
  const el = $('i18nStat');
  if (!el) return;
  const d = window.PTC_I18N;
  const userDict = sanitizeUserDict((await getLocal([DICT_KEY]))[DICT_KEY]);
  const userCount = Object.keys(userDict).length;
  let remoteCount = 0;
  try {
    const cached = await getLocal(['ptcI18nCache']);
    const cache = cached && cached.ptcI18nCache;
    if (cache && cache.dict && typeof cache.dict === 'object') remoteCount = Object.keys(cache.dict).length;
  } catch (e) {
    /* ignore */
  }
  if (!d || !d.stats) {
    el.textContent = '内置词库：未加载；远端 ' + remoteCount + ' 条 / 自定义 ' + userCount + ' 条';
    return;
  }
  const s = d.stats;
  el.textContent =
    '当前词库：内置精确词条 ' + s.fullDict + ' 条（其中界面档 ' + s.uiDict + ' 条；界面 ' + s.ui +
    ' / 类别 ' + s.category + ' / 通货名 ' + s.static + ' / 术语 ' + s.terms + ' / 补漏 ' + s.uiGap +
    ' / 补充 ' + s.supplement + '）＋ 句式模板 ' + s.patterns + ' 条（含动态 ' + s.dynamicPatterns +
    ' 条），精确 id ' + s.byId + ' 条 / 远端 ' + remoteCount + ' 条 / 自定义 ' + userCount +
    ' 条；远端词库从配置的 i18n 地址拉取，失败时静默回退内置。';
}

(function bindDictActions() {
  const save = $('zhSaveDict');
  if (save) {
    save.addEventListener('click', async () => {
      const parsed = parseDictText($('zhUserDict') ? $('zhUserDict').value : '');
      const count = Object.keys(parsed.dict).length;
      if (parsed.invalid.length) {
        setDictMsg('已保存 ' + count + ' 条；第 ' + parsed.invalid.slice(0, 10).join('、') + ' 行格式不正确（应为「英文=中文」），已跳过。', 'warn');
      } else {
        setDictMsg('已校验并保存 ' + count + ' 条自定义词条。', 'ok');
      }
      await setLocal({ [DICT_KEY]: parsed.dict });
      await refreshUserDict();
      await showI18nStat();
      broadcastI18n();
    });
  }

  const clear = $('zhClearDict');
  if (clear) {
    clear.addEventListener('click', async () => {
      await setLocal({ [DICT_KEY]: {} });
      await refreshUserDict();
      await showI18nStat();
      setDictMsg('已清空自定义词库，界面回退到内置与远端词条。', 'ok');
      broadcastI18n();
    });
  }

  const restore = $('zhRestoreNow');
  if (restore) {
    restore.addEventListener('click', async () => {
      await setSync({ zhEnabled: false });
      $('zhEnabled').checked = false;
      broadcastI18n(false);
      setStatus('已关闭汉化：已打开的市集页面即时还原英文，无需刷新。', 'warn');
      setDictMsg('已下发还原指令；若页面未响应，刷新一次市集页面即可。', 'ok');
    });
  }

  const toggle = $('zhEnabled');
  if (toggle) {
    toggle.addEventListener('change', () => {
      const on = !!toggle.checked;
      setStatus(on ? '汉化已开启：保存设置后（或点击保存）即可看到中文界面。' : '汉化已关闭：保存后页面恢复英文原样。', on ? '' : 'warn');
    });
  }
})();

init()
  .then(async () => {
    await refreshUserDict();
    await showI18nStat();
  })
  .catch((err) => setStatus('初始化异常：' + ((err && err.message) || '未知错误'), 'warn'));
