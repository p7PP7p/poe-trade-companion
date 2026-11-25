/**
 * content/inject.js — MAIN world 数据层
 * hook window.fetch / XMLHttpRequest，拦截市集搜索与详情请求，
 * 并把结果通过 postMessage 交给 ISOLATED world 的 content.js。
 *
 * 所有 hook 均包 try/catch：扩展异常绝不能影响官网页面。
 */
(function () {
  'use strict';

  if (window.__PTC_INJECTED__) return;
  window.__PTC_INJECTED__ = true;

  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  /** API 路径（可被 ISOLATED world 通过 postMessage 覆盖，以适配赛季改版） */
  const apiConfig = {
    searchPath: '/api/trade/search/',
    fetchPath: '/api/trade/fetch/'
  };

  const POST_LIMIT = 1.5 * 1024 * 1024; // 超过此体积走精简结构，避免拖慢页面

  /* ---------------- 通道 A：数据层汉化（/api/trade/data/*） ---------------- */

  /** 数据层生效配置：内置 PTC_I18N + 远端/用户覆盖，由 ISOLATED world 下发 */
  const i18nConfig = {
    enabled: false,
    level: 'ui',
    patterns: true,
    dict: Object.create(null),
    dictLower: Object.create(null),
    patternsList: [],
    byId: Object.create(null),
    byIdVersion: '',
    statsDictLoaded: true,
    stats: { rewritten: 0, requests: 0 }
  };

  /**
   * 词缀词库就绪闸门。
   * 词库约 1.8 万条、1.2MB，由 ISOLATED world 异步加载；首次 /api/trade/data/stats
   * 请求可能早于词库到达，这里挂起至多 2.5 秒等词库就绪，保证筛选器一次就是中文。
   */
  let statsReadyResolve = null;
  const statsReady = new Promise((resolve) => {
    statsReadyResolve = resolve;
  });

  function markStatsReady() {
    if (typeof statsReadyResolve === 'function') {
      statsReadyResolve();
      statsReadyResolve = null;
    }
  }

  function waitStatsReady(ms) {
    return Promise.race([statsReady, new Promise((resolve) => setTimeout(resolve, ms || 2500))]);
  }

  /**
   * 汉化开关的同源镜像。
   * inject.js 在 document_start 注入，早于 ISOLATED world 下发配置；
   * 首屏的 /api/trade/data/stats 请求往往就发生在这个空档，若不提前知道开关，
   * 首次筛选器会漏翻。content.js 在应用设置时写 localStorage，两边同源共享。
   */
  const ZH_HINT_KEY = 'ptc:zhEnabled';

  function readZhHint() {
    try {
      const v = localStorage.getItem(ZH_HINT_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {
      /* 隐私模式或存储被禁时忽略 */
    }
    return null;
  }

  function writeZhHint(on) {
    try {
      if (on) localStorage.setItem(ZH_HINT_KEY, '1');
      else localStorage.removeItem(ZH_HINT_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  const DATA_PATH = '/api/trade/data/';
  const DATA_SEGMENTS = ['stats', 'items', 'static', 'filters'];

  /** 识别数据接口：stats / items / static / other，非数据接口返回 null */
  function classifyData(url) {
    const u = String(url || '');
    if (u.indexOf(DATA_PATH) < 0) return null;
    for (let i = 0; i < DATA_SEGMENTS.length; i++) {
      if (u.indexOf(DATA_PATH + DATA_SEGMENTS[i]) >= 0) return DATA_SEGMENTS[i];
    }
    return 'other';
  }

  /** 页面本身已配置中文时不再二次翻译 */
  function pageAlreadyLocalized() {
    try {
      const lang = (document.documentElement && document.documentElement.getAttribute('lang')) || '';
      return /^zh/i.test(lang);
    } catch (e) {
      return false;
    }
  }

  function mergePlain(target, src) {
    if (!src) return;
    for (const k in src) {
      if (typeof src[k] === 'string') target[k] = src[k];
    }
  }

  /* ---------------- 内置词缀词库（MAIN world 同步展开，v0.3.4） ----------------
     历史成因：词缀库（1.8 万条 / 1.2MB）此前只由 ISOLATED world 异步加载、再 postMessage 下发，
     而首屏 /api/trade/data/stats 往往早于它到达，闸门最多等 2.5 秒仍可能超时放行，
     于是属性筛选下拉大面积英文、首屏筛选器只翻半截。
     修复：同一份 lib/i18n-stats-zh.js 也注入 MAIN world，由 window.PTC_STATS_ZH 同步展开，
     首屏即可用于 stats 响应；ISOLATED 下发的 byId 仍作为覆盖层（含用户自定义/远端更新）。 */
  const builtinStatsById = (function () {
    const out = Object.create(null);
    try {
      const payload = (typeof window === 'object' && window.PTC_STATS_ZH) || null;
      const groups = payload && payload.g;
      if (!groups) return out;
      const prefixes = Object.keys(groups);
      for (let i = 0; i < prefixes.length; i++) {
        const prefix = prefixes[i];
        const bag = groups[prefix];
        if (!bag) continue;
        for (const key in bag) {
          const zh = bag[key];
          if (typeof zh !== 'string' || !zh) continue;
          // 官方 id 形如 pseudo.pseudo_xxx / explicit.stat_xxx；词库键省略了分组前缀，
          // 两种写法都登记，宁可多一条映射也不要漏认。
          out[key.indexOf('stat_') === 0 ? prefix + key : prefix + key] = zh;
          if (key.indexOf('stat_') === 0) out[key] = zh;
        }
      }
    } catch (e) {
      /* 词库缺失时退回等待 ISOLATED 下发 */
    }
    return out;
  })();
  const builtinStatsReady = Object.keys(builtinStatsById).length > 0;

  function buildI18n(payload) {
    const builtin = (typeof window.PTC_I18N === 'object' && window.PTC_I18N) || {};
    const level = payload && payload.level === 'full' ? 'full' : 'ui';
    const dict = Object.create(null);
    // 数据层与 DOM 层保持同一档位语义：ui 只叠界面级词库，full 才叠全量
    if (level === 'full') {
      mergePlain(dict, builtin.dict);
      mergePlain(dict, builtin.fullDict);
    } else {
      mergePlain(dict, builtin.uiDict);
      mergePlain(dict, builtin.dict);
    }
    mergePlain(dict, payload && payload.dict);
    const lower = Object.create(null);
    for (const k in dict) lower[k.toLowerCase()] = dict[k];

    i18nConfig.level = level;
    i18nConfig.dict = dict;
    i18nConfig.dictLower = lower;
    i18nConfig.patterns = !payload || payload.patterns !== false;
    i18nConfig.patternsList = Array.isArray(builtin.patterns) ? builtin.patterns : [];

    // 词缀词库（约 1.8 万条）：按版本号判断是否需要重建，避免每次下发都重算大表
    const incomingById = payload && payload.byId;
    const incomingVer = payload && payload.byIdVersion ? String(payload.byIdVersion) : '';
    // v0.3.4：MAIN world 已能同步展开词缀库时，不再标记“未就绪”，
    // 首屏 stats 请求无需等待 ISOLATED 下发，避免闸门超时只翻半截。
    i18nConfig.statsDictLoaded = builtinStatsReady || !payload || payload.statsDictLoaded !== false;
    if (incomingById && incomingVer !== i18nConfig.byIdVersion) {
      i18nConfig.byId = Object.create(null);
      mergePlain(i18nConfig.byId, builtinStatsById);
      mergePlain(i18nConfig.byId, builtin.byId);
      mergePlain(i18nConfig.byId, incomingById);
      i18nConfig.byIdVersion = incomingVer;
    } else if (!incomingById && incomingVer !== i18nConfig.byIdVersion) {
      // 未下发词缀库：保留 MAIN world 内置词缀库 + 内置 byId
      i18nConfig.byId = Object.create(null);
      mergePlain(i18nConfig.byId, builtinStatsById);
      mergePlain(i18nConfig.byId, builtin.byId);
      i18nConfig.byIdVersion = incomingVer;
    }

    i18nConfig.enabled = !!(payload && payload.enabled);
    if (i18nConfig.enabled && pageAlreadyLocalized()) i18nConfig.enabled = false;

    // 词库加载完毕（或明确无需再等）时放行挂起的 stats 请求
    if (i18nConfig.statsDictLoaded) markStatsReady();
  }

  // 分词组合兜底（v0.3.2）：下拉项多为「已知词条 + 已知词条」拼成，如
  // "One-Handed melee Weapon"、"Any Dagger"、"Claws (Claw)"、"Damage / 100%"。
  // 纪律：任一单词未命中即整体放弃（保留英文原样），绝不产出半中半英。
  const SEG_SPLIT = /([A-Za-z][A-Za-z'\u2019\-]*)/;

  function mapSep(sep) {
    const t = String(sep || '').replace(/[\s\u00a0]+/g, ' ').trim();
    if (!t) return '';
    let out = '';
    for (let i = 0; i < t.length; i += 1) {
      const c = t.charAt(i);
      if (c === '(') out += '（';
      else if (c === ')') out += '）';
      else if (c === ':') out += '：';
      else if (c === ',') out += '，';
      else if (c === ';') out += '；';
      else if (c === '!') out += '！';
      else if (c === '?') out += '？';
      else out += c;
    }
    if (/^[\/\d%+\-]/.test(t)) out = ' ' + out;
    return out;
  }

  function pickDict(phrase) {
    const v = i18nConfig.dict[phrase];
    if (v !== undefined) return v;
    const lv = i18nConfig.dictLower[phrase.toLowerCase()];
    return lv === undefined ? null : lv;
  }

  function segmentTranslate(core) {
    if (!core || core.length > 64) return null;
    const parts = core.split(SEG_SPLIT);
    const words = [];
    const seps = [];
    let buf = '';
    for (let i = 0; i < parts.length; i += 1) {
      const seg = parts[i];
      if (seg === '') continue;
      if (i % 2 === 0) {
        buf += seg;
      } else {
        seps.push(buf);
        buf = '';
        words.push(seg);
      }
    }
    seps.push(buf);
    if (!words.length || words.length > 8 || seps.length !== words.length + 1) return null;

    const picks = [];
    let idx = 0;
    while (idx < words.length) {
      let hit = null;
      let used = 0;
      for (let len = Math.min(5, words.length - idx); len >= 1; len -= 1) {
        const phrase = words.slice(idx, idx + len).join(' ');
        let v = pickDict(phrase);
        if (v === null && len === 1) v = pickDict(phrase + 's');
        if (v !== null) {
          hit = v;
          used = len;
          break;
        }
      }
      if (hit === null) return null;
      picks.push(hit);
      idx += used;
    }
    if (picks.length !== words.length) return null;

    let out = '';
    for (let w = 0; w < words.length; w += 1) {
      out += mapSep(seps[w]) + picks[w];
    }
    out += mapSep(seps[words.length]);
    if (!out || out === core) return null;
    if (/[A-Za-z]{2,}/.test(out)) return null;
    return out;
  }

  function translateText(text) {
    // 价格备注 / 私聊语法里的 "~price"、"~b/o" 属于机器标记，不译
    if (String(text).indexOf('~') >= 0) return null;
    if (!i18nConfig.enabled) return null;
    const core = String(text).replace(/[\s\u00a0]+/g, ' ').trim();
    if (!core) return null;
    if (/[\u4e00-\u9fff]/.test(core)) return null;
    if (!/[A-Za-z]{2}/.test(core)) return null;
    const hit = i18nConfig.dict[core];
    if (hit !== undefined) return hit;
    const low = i18nConfig.dictLower[core.toLowerCase()];
    if (low !== undefined) return low;
    if (i18nConfig.patterns) {
      for (let i = 0; i < i18nConfig.patternsList.length; i++) {
        const p = i18nConfig.patternsList[i];
        if (!p || !p.re) continue;
        const m = core.match(p.re);
        if (!m) continue;
        if (typeof p.fn === 'function') {
          const fnOut = p.fn(m);
          if (fnOut) return fnOut;
          continue;
        }
        const tpl = typeof p.tpl === 'string' ? p.tpl : (typeof p.replace === 'string' ? p.replace : '');
        if (!tpl) continue;
        // $n 参数优先用词条翻译；残留英文且模板未标记 allowEnglish 时放弃（不出半中半英）
        const out = tpl.replace(/\$(\d+)/g, (_, n) => {
          const v = m[Number(n)];
          if (v === undefined || v === null) return '';
          const pHit = i18nConfig.dict[v] !== undefined ? i18nConfig.dict[v] : i18nConfig.dictLower[v.toLowerCase()];
          return pHit === undefined ? v : pHit;
        });
        if (!out || out === core) continue;
        if (!p.allowEnglish && /[A-Za-z]{2,}/.test(out)) continue;
        return out;
      }
    }
    // 最后一层：分词组合兜底（全部单词命中才输出，否则保留英文原样）
    return segmentTranslate(core);
  }

  /** 只改词典能命中的展示字段；枚举值（如 armour.chest）不在词典中，天然不受影响 */
  // label/title 为筛选器分组标题（如 "Item Category"），text 为选项文案；type 等枚举值天然不在词典中
  const HAS_CJK = /[\u4e00-\u9fff]/;
  const TEXT_FIELDS = ['label', 'title', 'text'];

  // 机器枚举值：出现在 stats 数据的 type 字段中，是查询构造依据，绝不能按文本改写
  const ENUM_VALUES = [
    'explicit', 'implicit', 'crafted', 'enchant', 'pseudo', 'fractured', 'scourge',
    'delve', 'veiled', 'mercenary', 'sanctum', 'crucible', 'ultimatum', 'imbued',
    'monster', 'skill', 'map', 'sentinel', 'tattoo'
  ];

  // 物品词缀行（explicitMods 等）只有文本、没有 stat id，用 stats 响应顺手建一张
  // “归一化英文模板 → 中文模板”反查表，再把 # 回填成实际数值即可翻译；
  // 这是把装备词缀长尾从“只能保留英文”变成可译的关键，且完全在数据层完成，无 DOM 时序问题。
  const statTextMap = Object.create(null);
  // v0.3.4：内置「英文模板 → 中文模板」表（lib/i18n-stats-tpl.js，由国际服/国服 stats 按 id 对齐生成）。
  // 旧版反查表只在用户真正拉过 stats 响应后才可用，首次打开结果页时词缀仍全英文；
  // 内置表让词缀行在页面初始化阶段就能译出，且不再依赖请求先后顺序。
  const tplMapLower = Object.create(null);
  (function loadBuiltinTplMap() {
    const raw = (typeof window === 'object' && window.PTC_STATS_TPL) || null;
    if (!raw) return;
    for (const k in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
      tplMapLower[k] = raw[k];
    }
  })();
  let statTextReady = Object.keys(tplMapLower).length > 0;
  let textMapResolve = null;
  const textMapReady = new Promise((resolve) => {
    textMapResolve = resolve;
  });

  // 当前正在处理的数据段（stats / items / static），用于区分「展示文案」与「查询枚举」
  let activeSegment = '';

  const MOD_FIELDS = [
    'explicitMods', 'implicitMods', 'craftedMods', 'enchantMods', 'scourgeMods',
    'veiledMods', 'fracturedMods', 'utilityMods', 'desecratedMods', 'crucibleMods'
  ];

  /** 把行内数值替换为 #，同时记下原值用于回填 */
  function templateKey(text) {
    const nums = [];
    const key = String(text)
      .replace(/[\s\u00a0]+/g, ' ')
      .trim()
      .replace(/[+-]?\d+(?:\.\d+)?/g, (m) => {
        nums.push(m);
        return '#';
      });
    return { key, nums };
  }

  /** 按顺序回填 #，占位数量对不上就整行放弃（宁可保留英文，不出错值） */
  function fillTemplate(tpl, nums) {
    const holes = tpl.split('#').length - 1;
    if (holes !== nums.length) return null;
    let i = 0;
    return tpl.replace(/#/g, (m, offset) => {
      let val = nums[i++];
      if (!val) return '';
      // 中文模板自带正负号（如 "+#"）时，去掉数值自身的符号，避免出现 "++21"
      const prev = tpl.charAt(offset - 1);
      if ((prev === '+' || prev === '-') && (val.charAt(0) === '+' || val.charAt(0) === '-')) {
        val = val.slice(1);
      }
      return val;
    });
  }

  function translateModLine(line) {
    const t = templateKey(line);
    const tpl = statTextMap[t.key] || statTextMap[t.key.toLowerCase()] || tplMapLower[t.key.toLowerCase()];
    if (!tpl) return null;
    return fillTemplate(tpl, t.nums);
  }

  // 新版接口的 explicitMods 是对象数组，自带 hash（stat.explicit.stat_xxx），
  // 可直接用 id 查词库，比英文模板反查更准；老版是纯字符串数组，走模板反查兜底。
  function modToZh(mod) {
    if (typeof mod === 'string') return translateModLine(mod);
    if (!mod || typeof mod !== 'object') return null;
    const desc = typeof mod.description === 'string' ? mod.description : '';
    if (!desc || /[\u4e00-\u9fff]/.test(desc)) return null;
    const hash = typeof mod.hash === 'string' ? mod.hash.replace(/^stat\./, '') : '';
    const tpl = hash ? i18nConfig.byId[hash] : null;
    if (tpl) {
      const t = templateKey(desc);
      const out = fillTemplate(tpl, t.nums);
      if (out) return out;
    }
    return translateModLine(desc);
  }

  function rewriteMods(item, stats) {
    if (!statTextReady || !item || typeof item !== 'object') return;
    for (let i = 0; i < MOD_FIELDS.length; i++) {
      const arr = item[MOD_FIELDS[i]];
      if (!Array.isArray(arr)) continue;
      for (let j = 0; j < arr.length; j++) {
        const mod = arr[j];
        const zh = modToZh(mod);
        if (!zh) continue;
        if (typeof mod === 'string') {
          if (zh === mod) continue;
          arr[j] = zh;
        } else {
          if (zh === mod.description) continue;
          mod.description = zh;
        }
        stats.rewritten += 1;
      }
    }
  }

  // 物品属性条目（护甲/能量护盾/需求等级等）的 name 是界面词，需要翻译；
  // 物品本体的 name 是专有名词（如 "Mind Wool"），walkI18n 已整体跳过，不会误伤。
  const NAMED_LIST_FIELDS = ['properties', 'requirements', 'additionalProperties', 'nextLevelRequirements'];

  function rewriteNamedList(item, stats) {
    for (let i = 0; i < NAMED_LIST_FIELDS.length; i++) {
      const arr = item[NAMED_LIST_FIELDS[i]];
      if (!Array.isArray(arr)) continue;
      for (let j = 0; j < arr.length; j++) {
        const row = arr[j];
        if (!row || typeof row !== 'object') continue;
        const nm = row.name;
        if (typeof nm !== 'string' || !nm) continue;
        const zh = translateText(nm);
        if (!zh || zh === nm) continue;
        row.name = zh;
        stats.rewritten += 1;
      }
    }
  }

  function rewriteEntry(entry, stats) {
    const keyId = typeof entry.id === 'string' ? entry.id : '';
    for (let i = 0; i < TEXT_FIELDS.length; i++) {
      const field = TEXT_FIELDS[i];
      const val = entry[field];
      if (typeof val !== 'string' || !val) continue;
      // type 是查询用的机器枚举值，词库里有同名界面词（"Explicit"→"显式"、"Claw"→"爪"），
      // 若按文本改写，页面会构造出 type="爪" 的非法查询以致搜索失效。
      // 物品/类别数据的 type 就是基底/分类查询值（"Chaos Orb"、"Rune Dagger"），同等对待，绝不改写；
      // 界面显示走的是 text / label 字段，翻译不受影响。
      // v0.3.3：只改展示字段（label/title/text），机器枚举字段 type 一律不碰。
      // 官网用 price.type('~price' / '~b/o') 等枚举渲染结果行，改写后变成无法识别的枚举，
      // 结果区渲染中断并永久停在加载态（v0.3.2 分词兜底把 "~price" 译成 "~价格" 即此类事故）。
      if (val.indexOf('~') >= 0) continue;
      const byIdHit = keyId && field === 'text'
        ? i18nConfig.byId[keyId] || builtinStatsById[keyId] || null
        : null;
      const zh = byIdHit || translateText(val);
      if (!zh || zh === val) continue;
      // 顺带沉淀“英文模板 → 中文模板”，供物品词缀行反查
      if (field === 'text' && byIdHit) {
        const t = templateKey(val);
        if (t.key && !(t.key in statTextMap)) statTextMap[t.key] = zh;
      }
      entry[field] = zh;
      stats.rewritten += 1;
    }
  }

  /**
   * 查询结果行「物品名 / 基底名」汉化（v0.3.4）。
   * 旧版把结果区 name/typeLine 一律保留英文，用户看到的列表内容因此全英文。
   * 现在只走「权威专名词库精确命中」这一条通道：命中即译（宝石 Rain of Arrows→箭雨、
   * 通货 Chaos Orb→混沌石），未命中一律保留英文原样，绝不做分词猜测，避免暗金名被拼错。
   */
  const ITEM_NAME_FIELDS = ['typeLine', 'baseType'];

  /* 物品说明类文本（v0.3.4 收尾）：descrText 是固定的技能使用说明，
     secDescrText 是技能长描述。只走词条精确命中，命中即译，未命中保留英文。 */
  const ITEM_TEXT_FIELDS = ['descrText', 'secDescrText'];

  function rewriteItemTexts(item, stats) {
    for (let i = 0; i < ITEM_TEXT_FIELDS.length; i++) {
      const field = ITEM_TEXT_FIELDS[i];
      const val = item[field];
      if (typeof val !== 'string' || !val || HAS_CJK.test(val)) continue;
      const zh = i18nConfig.dict[val] || i18nConfig.dictLower[val.toLowerCase()];
      if (typeof zh !== 'string' || !zh || zh === val) continue;
      item[field] = zh;
      stats.rewritten += 1;
    }
  }

  function rewriteItemName(item, stats) {
    for (let i = 0; i < ITEM_NAME_FIELDS.length; i++) {
      const field = ITEM_NAME_FIELDS[i];
      const val = item[field];
      if (typeof val !== 'string' || !val) continue;
      if (HAS_CJK.test(val)) continue;
      let zh = i18nConfig.dict[val];
      if (zh === undefined) zh = i18nConfig.dictLower[val.toLowerCase()];
      if (typeof zh !== 'string' || !zh || zh === val) continue;
      item[field] = zh;
      stats.rewritten += 1;
    }
  }

  /**
   * 结果行属性值汉化（v0.3.4）：properties[].values 里的纯文本片段
   * （"Attack, AoE, Projectile, Bow"、"Main Hand" 等）走分词兜底；
   * 含数字的值（"48% of base"、"19"）保持原样，避免破坏数值可读性与页面解析。
   */
  /* 数值型属性值（v0.3.4 收尾）："48% of base" / "6 Mana" / "4 per Second" 这类
     「数字 + 单位短语」只用于展示、不参与页面解析，按写死的规则表安全译出；
     规则未命中一律保留原样，绝不做猜测性拼接。 */
  const VALUE_RULES = [
    [/^([\d.,]+%?)\s+of\s+base$/i, (m) => '基础值的 ' + m[1]],
    [/^([\d.,]+)\s+Mana$/i, (m) => m[1] + ' 魔力'],
    [/^([\d.,]+)\s+Life$/i, (m) => m[1] + ' 生命'],
    [/^([\d.,]+)\s+per\s+Second\s+per\s+Charge$/i, (m) => '每充能每秒 ' + m[1]],
    [/^([\d.,]+)\s+per\s+Second$/i, (m) => '每秒 ' + m[1]],
    [/^([\d.,]+)%\s+increased$/i, (m) => '提高 ' + m[1] + '%'],
    [/^([\d.,]+)%\s+reduced$/i, (m) => '降低 ' + m[1] + '%'],
    [/^(.+)\s+per\s+Second$/i, (m) => '每秒 ' + m[1]]
  ];

  function translateValueText(txt) {
    for (let i = 0; i < VALUE_RULES.length; i++) {
      const hit = VALUE_RULES[i][0].exec(txt);
      if (hit) return VALUE_RULES[i][1](hit);
    }
    if (/[0-9]/.test(txt)) return null;
    return translateText(txt);
  }

  function rewritePropertyValues(item, stats) {
    const rows = item.properties;
    if (!Array.isArray(rows)) return;
    for (let i = 0; i < rows.length; i++) {
      const vals = rows[i] && rows[i].values;
      if (!Array.isArray(vals)) continue;
      for (let j = 0; j < vals.length; j++) {
        const pair = vals[j];
        if (!Array.isArray(pair)) continue;
        const txt = pair[0];
        if (typeof txt !== 'string' || !txt) continue;
        if (HAS_CJK.test(txt)) continue;
        const zh = translateValueText(txt);
        if (!zh || zh === txt) continue;
        pair[0] = zh;
        stats.rewritten += 1;
      }
    }
  }

  /* ---------------- items 通道的基底展示名（v0.3.4） ----------------
     成因：/api/trade/data/items 的条目形如 { type: "Chain Gloves" }，type 在这里是
     物品基底展示名（物品类别下拉、基底下拉都取自它），而 stats 通道的 type 是
     explicit / pseudo 这类查询枚举 —— 同名不同义。历史修复为防加载回归把 type 整体
     排除在 TEXT_FIELDS 之外，于是基底下拉全英文。
     修复：仅在 items 段对 type 做「整串精确命中词库」的改写，并显式拒绝纯小写枚举
     与含 ~ 的机器值，既不误伤 query 参数，也不会再触发枚举被翻译的加载回归。 */
  /**
   * items 段 type 不再改写（v0.3.4 修正）。
   * 成因复盘：官网物品类别下拉的选项条目形如 { type: "Chaos Orb" }，没有独立 id，
   * React 选中后直接把该项的 type 原文写进查询 JSON 的 query.type。v0.3.4 早期版本
   * 把 type 改成中文后，界面看着是中文了，但发出的请求带着 type="混沌石"，
   * 接口按未知类别处理，静默返回空结果 —— 与「一直加载」属同一类事故。
   * 因此这里彻底关闭数据层 type 改写：item 类别下拉的中文化改由 filters 通道
   * （按 id 对齐，参见 rewriteFilters）与 DOM 层词库共同完成，展示照样是中文，
   * 但查询参数永远是英文枚举。
   */
  function rewriteItemEntries() {
    return;
  }

  /* ---------------- 筛选项 id 级汉化（v0.3.4） ----------------
     成因：筛选器下拉的选项文案由 /api/trade/data/filters 下发，长尾选项
     （Any Celestial Variant / Any Voidborn Variant / Amethyst / Captured Beast 等）
     在国际服英文侧没有稳定的词库对应物，纯文本匹配必然漏翻。
     国服同接口的分组 id / 筛选项 id / 选项 id 与国际服一致，故改按 id 对齐；
     只改展示用的 title / text，不动 id，避免影响筛选请求参数与 React 取值。 */
  const filterZh = (typeof window === 'object' && window.PTC_FILTERS_ZH) || null;

  function rewriteFilters(payload, stats) {
    if (!filterZh || !payload || !Array.isArray(payload.result)) return;
    const gmap = filterZh.group || {};
    const fmap = filterZh.filter || {};
    const omap = filterZh.option || {};
    const optionText = filterZh.optionText || {};
    const groups = payload.result;
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      if (!group || typeof group !== 'object') continue;
      if (group.id && gmap[group.id] && group.title !== gmap[group.id]) {
        group.title = gmap[group.id];
        stats.rewritten += 1;
      } else if (!group.id && group.title) {
        const gz = translateText(group.title);
        if (gz && gz !== group.title) { group.title = gz; stats.rewritten += 1; }
      }
      const filters = group.filters;
      if (!Array.isArray(filters)) continue;
      for (let fi = 0; fi < filters.length; fi++) {
        const f = filters[fi];
        if (!f || typeof f !== 'object' || !f.id) continue;
        const fid = String(f.id);
        if (fmap[fid] && f.text !== fmap[fid]) {
          f.text = fmap[fid];
          stats.rewritten += 1;
        } else if (!fmap[fid]) {
          const fz = translateText(f.text);
          if (fz && fz !== f.text) { f.text = fz; stats.rewritten += 1; }
        }
        const bag = omap[fid];
        const opts = f.option && Array.isArray(f.option.options) ? f.option.options : null;
        if (!opts) continue;
        for (let oi = 0; oi < opts.length; oi++) {
          const o = opts[oi];
          if (!o || typeof o !== 'object') continue;
          const key = o.id === null || o.id === undefined ? '__' + oi : String(o.id);
          /* 四路兜底（v0.3.4 收尾）：id → 同位置顺序键 → 英文原文键 → 分词词库。
             成因：国际服选项普遍带 id、国服同一选项 id 常为 null，仅按 id 对齐会成片漏翻；
             国服没有对应筛选项时（如 map_series / heist_objective_value）再退回文案匹配。 */
          let zh = bag ? bag[key] : null;
          if (typeof zh !== 'string' || !zh) {
            const seq = bag && bag['__' + oi];
            if (typeof seq === 'string' && seq) zh = seq;
          }
          if (typeof zh !== 'string' || !zh) {
            const byText = optionText[String(o.text || '').replace(/\s+/g, ' ').trim().toLowerCase()];
            if (typeof byText === 'string' && byText) zh = byText;
          }
          if (typeof zh !== 'string' || !zh) {
            const guess = translateText(o.text);
            if (guess && guess !== o.text) zh = guess;
          }
          if (typeof zh === 'string' && zh && o.text !== zh) {
            o.text = zh;
            stats.rewritten += 1;
          }
        }
      }
    }
  }

  function walkI18n(node, stats, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walkI18n(node[i], stats, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    // 每个层级都尝试改写展示字段：分组对象也可能只有 label（如 "Item Category"）而无 text
    rewriteEntry(node, stats);
    // 物品对象：顺带把显式/固有等词缀行按数值模板翻译
    if (node.explicitMods || node.implicitMods || node.craftedMods || node.enchantMods) {
      rewriteMods(node, stats);
    }
    // 属性条目（护甲/能量护盾/需求等级）名称中文化
    if (node.properties || node.requirements) rewriteNamedList(node, stats);
    // v0.3.4：结果行展示内容（物品名 / 基底名 / 属性值文本）中文化
    if (node.typeLine || node.baseType) rewriteItemName(node, stats);
    if (node.descrText || node.secDescrText) rewriteItemTexts(node, stats);
    if (node.properties) rewritePropertyValues(node, stats);
    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      // 图标/私聊原文/角色名不属于界面文案，绝不改写
      if (k === 'icon' || k === 'whisper' || k === 'name') continue;
      const v = node[k];
      if (v && typeof v === 'object') walkI18n(v, stats, depth + 1);
    }
  }

  function localizePayload(payload, segment) {
    const stats = { rewritten: 0 };
    const prevSegment = activeSegment;
    activeSegment = segment || '';
    try {
      i18nConfig.stats.requests += 1;
      if (!i18nConfig.enabled) return { payload, changed: 0 };
      // 筛选器通道优先走 id 对齐，再做文本词库兜底
      if (segment === 'filters') rewriteFilters(payload, stats);
      walkI18n(payload, stats, 0);
      // items 通道的 type 是查询参数原文，禁止改写（见 rewriteItemEntries 注释）
      i18nConfig.stats.rewritten += stats.rewritten;
      // stats 响应处理完即视为反查表就绪，放行此前挂起的物品响应
      if (segment === 'stats' && !statTextReady) {
        statTextReady = true;
        if (textMapResolve) textMapResolve();
      }
    } catch (e) {
      if (segment === 'stats' && !statTextReady) {
        statTextReady = true;
        if (textMapResolve) textMapResolve();
      }
      return { payload, changed: 0 };
    } finally {
      activeSegment = prevSegment;
    }
    return { payload, changed: stats.rewritten };
  }

  /**
   * 用改写后的 Response 替换原响应。
   * 入参是 fetch 返回的 Promise（不是 Response），必须先在 then 里取真实响应；
   * 去掉 content-length/content-encoding，避免与新体积冲突。
   * @param {Promise<Response>} promise
   * @param {string} segment stats / items / static / other
   */
  function localizeResponse(promise, segment, notify) {
    // 兜底下发：改写未生效时也要把原始数据交回 content script，避免侧栏收不到数据
    const fallback = (res) => {
      if (!notify || !res || typeof res.clone !== 'function') return;
      try {
        res
          .clone()
          .json()
          .then((d) => notify(d, res))
          .catch(() => {
            /* 非 JSON 响应忽略 */
          });
      } catch (e) {
        /* ignore */
      }
    };
    try {
      if (!promise || typeof promise.then !== 'function') return promise;
      return promise.then((res) => {
        if (!res || !res.ok || typeof res.clone !== 'function') {
          fallback(res);
          return res;
        }
        if (!i18nConfig.enabled) {
          fallback(res);
          return res;
        }

        // 首次 stats 请求可能早于词库到达：挂起等待，但绝不无限阻塞页面。
        // 物品/详情响应需要 stats 反查表才能翻词缀，最多等一下（通常 stats 已在百毫秒内返回）
        let ready;
        if (segment === 'stats' && !i18nConfig.statsDictLoaded) {
          ready = waitStatsReady(2500);
        } else if (segment !== 'stats' && !statTextReady) {
          ready = Promise.race([
            textMapReady,
            new Promise((resolve) => setTimeout(resolve, 1200))
          ]);
        } else {
          ready = Promise.resolve();
        }

        return ready
          .then(() => res.clone().json())
          .then((data) => {
            const out = localizePayload(data, segment);
            // 交给侧栏的是已汉化的数据，保持页面与自绘 UI 文案一致
            if (notify) {
              try {
                notify(out.payload, res);
              } catch (e) {
                /* ignore */
              }
            }
            if (!out.changed) return res;
            const headers = new Headers();
            try {
              res.headers.forEach((v, k) => {
                const key = String(k).toLowerCase();
                if (key === 'content-length' || key === 'content-encoding') return;
                headers.set(k, v);
              });
            } catch (e) {
              /* header 拷贝失败则用空头 */
            }
            return new Response(JSON.stringify(out.payload), {
              status: res.status,
              statusText: res.statusText,
              headers
            });
          })
          .catch(() => {
            fallback(res);
            return res;
          });
      });
    } catch (e) {
      return promise;
    }
  }

  function classify(url) {
    const u = String(url || '');
    try {
      if (u.indexOf(apiConfig.fetchPath) >= 0) return 'fetch';
      if (u.indexOf(apiConfig.searchPath) >= 0) return 'search';
    } catch (e) {
      return null;
    }
    return null;
  }

  function safeParseBody(body) {
    if (!body) return null;
    if (typeof body === 'object') {
      try {
        return JSON.parse(JSON.stringify(body));
      } catch (e) {
        return null;
      }
    }
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function headersToObject(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => {
          const k = String(key).toLowerCase();
          if (k.indexOf('x-rate-limit') === 0 || k === 'retry-after' || k === 'content-type') {
            out[k] = value;
          }
        });
        return out;
      }
      if (typeof headers === 'string') {
        headers.split(/\r?\n/).forEach((line) => {
          const idx = line.indexOf(':');
          if (idx < 0) return;
          const k = line.slice(0, idx).trim().toLowerCase();
          if (k.indexOf('x-rate-limit') === 0 || k === 'retry-after' || k === 'content-type') {
            out[k] = line.slice(idx + 1).trim();
          }
        });
      }
    } catch (e) {
      /* 拿不到头部时下发空对象 */
    }
    return out;
  }

  function xhrHeaders(xhr) {
    try {
      return headersToObject(xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : '');
    } catch (e) {
      return {};
    }
  }

  /** 精简版响应（仅在体量过大时使用），保留扩展所需字段 */
  function slim(kind, payload) {
    try {
      if (kind === 'search') {
        return {
          id: payload.id,
          total: payload.total,
          result: Array.isArray(payload.result) ? payload.result : [],
          complexity: payload.complexity
        };
      }
      const list = Array.isArray(payload.result) ? payload.result : [];
      return {
        result: list.map((row) => ({
          id: row && row.id,
          item: row && row.item
            ? {
                name: row.item.name,
                typeLine: row.item.typeLine,
                icon: row.item.icon,
                explicitMods: row.item.explicitMods,
                frameType: row.item.frameType
              }
            : null,
          listing: row && row.listing
            ? {
                indexed: row.listing.indexed,
                price: row.listing.price,
                account: row.listing.account,
                whisper: row.listing.whisper
              }
            : null
        }))
      };
    } catch (e) {
      return null;
    }
  }

  function post(kind, url, request, response, headers) {
    try {
      let payload = response;
      try {
        if (JSON.stringify(response).length > POST_LIMIT) payload = slim(kind, response) || response;
      } catch (e) {
        /* stringify 失败时原样下发 */
      }
      window.postMessage(
        {
          source: 'ptc',
          type: 'trade-response',
          kind,
          url: String(url || ''),
          request: request || null,
          response: payload,
          headers: headers || {},
          at: Date.now()
        },
        '*'
      );
    } catch (e) {
      /* 消息通道异常不影响页面 */
    }
  }

  /* ------------------------- fetch hook ------------------------- */
  try {
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const kind = classify(url);

        let request = null;
        if (kind) {
          try {
            request = safeParseBody(init && init.body);
          } catch (e) {
            request = null;
          }
        }

        const promise = origFetch.apply(this, arguments);

        // 业务通道统一先挂 notify：改写路径与直通路径都能把数据与响应头交回侧栏
        const notify = kind
          ? (payload, res) => {
              let headers = {};
              try {
                headers = headersToObject(res.headers);
              } catch (e) {
                headers = {};
              }
              post(kind, url, request, payload, headers);
            }
          : null;

        // 通道 A：筛选器词条 / 物品数据接口，改写展示文案后再交回页面
        const dataSegment = classifyData(url);
        if (dataSegment) return localizeResponse(promise, dataSegment, notify);
        // 搜索结果与详情响应（/api/trade/fetch/）里的物品词缀同样走改写
        if (kind === 'fetch') return localizeResponse(promise, 'fetch', notify);

        if (!kind) return promise;

        try {
          promise.then((res) => {
            try {
              const clone = res.clone();
              const headers = headersToObject(clone.headers);
              clone
                .json()
                .then((data) => post(kind, url, request, data, headers))
                .catch(() => {
                  /* 非 JSON 响应忽略 */
                });
            } catch (e) {
              /* clone 失败忽略 */
            }
          });
        } catch (e) {
          /* then 绑定失败忽略 */
        }
        return promise;
      };
    }
  } catch (e) {
    /* fetch 不可 hook 时静默降级 */
  }

  /* ------------------------- XHR hook ------------------------- */
  try {
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__ptcMeta = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      } catch (e) {
        /* ignore */
      }
      return origXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        const meta = this.__ptcMeta;
        const kind = meta && classify(meta.url);
        if (kind) {
          const request = safeParseBody(body);
          const xhr = this;
          xhr.addEventListener('load', function () {
            try {
              const text = xhr.responseText;
              let data = null;
              try {
                data = JSON.parse(text);
              } catch (e) {
                data = null;
              }
              if (data) post(kind, meta.url, request, data, xhrHeaders(xhr));
            } catch (e) {
              /* ignore */
            }
          });
        }
      } catch (e) {
        /* ignore */
      }
      return origXhrSend.apply(this, arguments);
    };
  } catch (e) {
    /* XHR 不可 hook 时静默降级 */
  }

  /* ------------- 接收 ISOLATED world 的指令（同一源 cookie） ------------- */
  window.addEventListener('message', function (event) {
    try {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'ptc-cmd') return;

      if (data.cmd === 'config' && data.payload) {
        if (typeof data.payload.searchPath === 'string') apiConfig.searchPath = data.payload.searchPath;
        if (typeof data.payload.fetchPath === 'string') apiConfig.fetchPath = data.payload.fetchPath;
        return;
      }

      if (data.cmd === 'request' || data.cmd === 'search') {
        handleRequest(data.payload || {});
      }
    } catch (e) {
      /* ignore */
    }
  });

  async function handleRequest(payload) {
    const reqId = payload.reqId;
    const method = String(payload.method || 'GET').toUpperCase();
    let url = String(payload.url || '');
    try {
      url = new URL(url, location.origin).href;
    } catch (e) {
      /* 保留原始相对路径 */
    }

    const init = {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    };
    if (method !== 'GET' && payload.body !== undefined && payload.body !== null) {
      init.body = JSON.stringify(payload.body);
    }

    try {
      const res = await origFetch.call(window, url, init);
      const headers = headersToObject(res.headers);
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
      reply({ reqId, ok: res.ok, status: res.status, data, headers });
    } catch (err) {
      reply({ reqId, ok: false, status: 0, error: String((err && err.message) || err), headers: {} });
    }
  }

  function reply(result) {
    try {
      window.postMessage(Object.assign({ source: 'ptc', type: 'trade-result' }, result), '*');
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------- 汉化配置下发（ISOLATED world → MAIN world） ------------- */
  try {
    window.addEventListener('message', (ev) => {
      try {
        if (ev.source !== window) return;
        const data = ev.data;
        if (!data || data.source !== 'ptc-cmd' || data.cmd !== 'i18n') return;
        buildI18n(data.payload || {});
        window.postMessage(
          {
            source: 'ptc',
            type: 'i18n-ready',
            payload: {
              enabled: i18nConfig.enabled,
              level: i18nConfig.level,
              dictSize: Object.keys(i18nConfig.dict).length
            }
          },
          '*'
        );
      } catch (e) {
        /* ignore */
      }
    });
  } catch (e) {
    /* ignore */
  }

  // 先载入内置词典：开关取同源镜像（未记录过则默认开启），content.js 随后会下发权威配置覆盖
  // statsDictLoaded: false —— 首屏 stats 请求需等词缀词库（约 1.8 万条）到货，否则首次筛选器只翻半截
  try {
    const hint = readZhHint();
    buildI18n({ enabled: hint !== false, statsDictLoaded: false });
  } catch (e) {
    /* ignore */
  }

  // 调试/自测入口（只读）
  try {
    window.__PTC_DATA_HOOK__ = {
      config: i18nConfig,
      translate: translateText,
      classifyData,
      localizePayload
    };
  } catch (e) {
    /* ignore */
  }

  // 握手：让 content.js 确认 MAIN world 注入成功（Chrome <111 时可据此走 fallback）
  try {
    window.postMessage({ source: 'ptc', type: 'ready' }, '*');
  } catch (e) {
    /* ignore */
  }
})();
