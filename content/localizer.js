/**
 * PoE Trade Companion — 官网市集页面汉化（通道 B：DOM 层）v0.2.2
 *
 * 为什么需要重写（v0.2.2 根因）：
 *   官网是 React 渲染，按钮/标题会被拆成多个子元素与文本节点，
 *   例如 "Add Stat Filter" 实际是 <button><span>Add</span> <span>Stat</span> <span>Filter</span></button>，
 *   逐文本节点匹配时每个节点只有 "Add" / "Stat" / "Filter"，必然漏翻界面固定字段。
 *
 * 现有匹配流水线（严格按序，不允许跳级拼接）：
 *   1) 父元素聚合匹配：整块 textContent 归一化后匹配，命中则把子节点合并为单一文本节点
 *   2) TreeWalker 逐文本节点兜底：处理未被聚合命中的普通文本（保留为 v0.2.0 行为）
 *   3) 属性汉化：placeholder / title / aria-label
 *
 * 匹配纪律：词条精确 → 句式模板 → 未命中一律保留英文原样。
 * 严禁词块级拼接：模板结果若残留英文单词且未被标记 allowEnglish，直接放弃该模板，
 * 避免出现「获得 # 生命 每 敌人 Hit 带 攻击」这类半中半英文案。
 *
 * 可还原性：文本节点 / 属性 / 聚合元素三处的原文快照均保留，关闭汉化后逐条写回。
 */
(function () {
  'use strict';

  var SELF = (window.PTC = window.PTC || {});

  var SKIP_TAGS = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    TEXTAREA: 1,
    CODE: 1,
    PRE: 1,
    IFRAME: 1,
    SVG: 1,
    CANVAS: 1,
    INPUT: 1,
    SELECT: 1
  };

  var SKIP_SELECTOR = '#ptc-root, [data-ptc-skip], .ptc-panel, .ptc-tooltip, .ptc-badge, .ptc-toast, .itemName, .itemTypeLine, .typeLine, [class*="itemName"], [class*="itemTypeLine"]';
  // ↑ 末段为结果区「物品名 + 基底名」：这两类内容刻意保留英文（暗金名/基底名不译），
  //   即使词库中存在同名筛选项（如 Rune Dagger）也不得改写结果行，避免玩家对不上英文物品。

  /* 允许做"整块聚合"的元素：纯文本容器类标签 */
  var AGG_TAGS = {
    BUTTON: 1, A: 1, SPAN: 1, DIV: 1, LABEL: 1, LI: 1, P: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    TD: 1, TH: 1, DT: 1, DD: 1, CAPTION: 1, LEGEND: 1, SUMMARY: 1,
    STRONG: 1, EM: 1, B: 1, I: 1, SMALL: 1, FIGCAPTION: 1, OPTION: 1,
    SECTION: 1, ARTICLE: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, NAV: 1, MAIN: 1
  };

  /* 聚合时需要避开的内部元素：一旦内部出现这些，放弃聚合，退回逐节点处理，绝不破坏结构与表单值 */
  var AGG_BLOCK_TAGS = {
    INPUT: 1, SELECT: 1, TEXTAREA: 1,
    IFRAME: 1, CODE: 1, PRE: 1, SCRIPT: 1, STYLE: 1, OBJECT: 1, EMBED: 1,
    TABLE: 1, FORM: 1, UL: 1, OL: 1
  };

  /* 图标类子元素：聚合时原位保留（不删不换），排在译文之前/之后均可，避免按钮图标消失 */
  var AGG_KEEP_TAGS = {
    IMG: 1, SVG: 1, USE: 1, PICTURE: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1, I: 1
  };

  /* 整块文本长度上限：超长说明是容器而非单个字段，宁可漏翻也不误伤 */
  var MAX_AGG_LEN = 160;

  /* 参与汉化的属性；input 的 value 一律不处理，避免破坏表单值与提交参数 */
  var ATTRS = ['placeholder', 'title', 'aria-label'];

  /* 单批处理上限（requestIdleCallback 分片，避免主线程长任务卡顿搜索页） */
  var BATCH_LIMIT = 400;

  var state = {
    enabled: false,
    level: 'full',
    patterns: true,
    dict: {},
    dictLower: {},
    patternsList: [],
    byId: {},
    records: new WeakMap(),      // textNode -> { origin, output }
    attrRecords: new WeakMap(),  // element -> { attrName: { origin, output } }
    collapseIndex: new WeakMap(),// element -> collapse record
    collapses: [],               // 聚合元素记录（WeakMap 不可遍历，故另存数组）
    observer: null,
    applying: false,
    stats: { nodes: 0, translated: 0, collapsed: 0 }
  };

  function normalize(str) {
    return String(str == null ? '' : str).replace(/[\s\u00a0]+/g, ' ').trim();
  }

  /** 纯英文文本判定：含 CJK 或完全无字母则跳过 */
  function isCandidate(text) {
    if (!text) return false;
    if (/[\u4e00-\u9fff]/.test(text)) return false;      // 已含中文
    return /[A-Za-z]{2}/.test(text);
  }

  /** 英文残留判定：模板结果里出现两个以上连续字母即视为未译透 */
  function hasResidualEnglish(text) {
    return /[A-Za-z]{2,}/.test(text);
  }

  /* ------------------------------------------------------------ 词条匹配（纯函数，无词块拼接） */

  function pick(dict, dictLower, core) {
    if (!dict) return null;
    var v = dict[core];
    if (typeof v === 'string' && v) return v;
    if (dictLower) {
      var lv = dictLower[core.toLowerCase()];
      if (typeof lv === 'string' && lv) return lv;
    }
    return null;
  }

  /**
   * 单条句式模板应用：
   *   - $n 参数先尝试用词条精确翻译，翻译不到就保留原参数
   *   - 结果残留英文且模板未标记 allowEnglish 时整体放弃（宁可漏翻，不出半中半英）
   */
  function applyPattern(p, core) {
    if (!p || !p.re) return null;
    var m = p.re.exec(core);
    if (!m) return null;
    var out = String(p.tpl || '').replace(/\$(\d+)/g, function (_, n) {
      var v = m[Number(n)];
      if (v === undefined || v === null) return '';
      var hit = pick(state.dict, state.dictLower, v);
      return hit === null ? v : hit;
    });
    if (!out || out === core) return null;
    if (!p.allowEnglish && hasResidualEnglish(out)) return null;
    return out;
  }

  /* ------------------------------------------------------------ 分词组合兜底（v0.3.2） */

  var SEG_SPLIT = /([A-Za-z][A-Za-z'\u2019\-]*)/;

  /** 分隔符归一化：括号/冒号转全角，数字与斜杠前补空格 */
  function mapSep(sep) {
    var t = String(sep || '').replace(/[\s\u00a0]+/g, ' ').trim();
    if (!t) return '';
    var out = '';
    for (var i = 0; i < t.length; i += 1) {
      var c = t.charAt(i);
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

  /**
   * 分词组合匹配：官方市集大量下拉项是「已知词条 + 已知词条」拼成的
   * （One-Handed melee Weapon / Any Dagger / Claws (Claw) / Damage / 100%），
   * 逐条登记组合会无限膨胀，故按单词贪心最长匹配拼装。
   * 纪律：任一单词未命中即整体放弃（保留英文原样），绝不产出半中半英。
   */
  function segmentMatch(core) {
    if (!core || core.length > 64) return null;
    var parts = core.split(SEG_SPLIT);
    var words = [];
    var seps = [];
    var buf = '';
    for (var i = 0; i < parts.length; i += 1) {
      var seg = parts[i];
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

    var picks = [];
    var idx = 0;
    while (idx < words.length) {
      var hit = null;
      var used = 0;
      for (var len = Math.min(5, words.length - idx); len >= 1; len -= 1) {
        var phrase = words.slice(idx, idx + len).join(' ');
        var v = pick(state.dict, state.dictLower, phrase);
        if (v === null && len === 1) v = pick(state.dict, state.dictLower, phrase + 's');
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

    var out = '';
    for (var w = 0; w < words.length; w += 1) {
      out += mapSep(seps[w]) + picks[w];
    }
    out += mapSep(seps[words.length]);
    if (!out || out === core) return null;
    if (hasResidualEnglish(out)) return null;
    return out;
  }

  /** 核心匹配：词条精确 → 句式模板 → null（调用方保留英文原样） */
  function matchCore(core) {
    if (!core) return null;
    var hit = pick(state.dict, state.dictLower, core);
    if (hit !== null) return hit;
    if (state.patterns && state.patternsList.length) {
      for (var i = 0; i < state.patternsList.length; i++) {
        var out = applyPattern(state.patternsList[i], core);
        if (out !== null) return out;
      }
    }
    /* 最后一层：分词组合兜底（全部单词命中才输出） */
    return segmentMatch(core);
  }


  /* ------------------------------------------------------------ 数值型文本兜底（v0.3.4 收尾） */
  /* 与数据层同一套写死规则：仅处理「数字 + 固定单位短语」的展示文本
     （"48% of base" / "6 Mana" / "4 per Second"），规则未命中一律返回 null，
     调用方保留英文原样，避免把价格、等级、随机数值误译。 */
  var VALUE_RULES = [
    [/^([\d.,]+%?)\s+of\s+base$/i, function (m) { return '基础值的 ' + m[1]; }],
    [/^([\d.,]+)\s+Mana$/i, function (m) { return m[1] + ' 魔力'; }],
    [/^([\d.,]+)\s+Life$/i, function (m) { return m[1] + ' 生命'; }],
    [/^([\d.,]+)\s+per\s+Second$/i, function (m) { return '每秒 ' + m[1]; }],
    [/^([\d.,]+)%\s+increased$/i, function (m) { return '提高 ' + m[1] + '%'; }],
    [/^([\d.,]+)%\s+reduced$/i, function (m) { return '降低 ' + m[1] + '%'; }]
  ];

  function translateValueCore(core) {
    for (var i = 0; i < VALUE_RULES.length; i += 1) {
      var hit = VALUE_RULES[i][0].exec(core);
      if (hit) return VALUE_RULES[i][1](hit);
    }
    return null;
  }

  /**
   * 对外翻译入口：保留首尾空白，供文本节点写回。
   * 未命中返回 null（调用方必须保留英文原样，不得做任何降级拼接）。
   */
  function translate(raw) {
    var text = String(raw == null ? '' : raw);
    var core = normalize(text);
    if (!core || !isCandidate(core)) return null;
    /* 机器标记（~price / ~b/o 等）一律不译，避免影响官网自身的枚举展示 */
    if (core.indexOf('~') >= 0) return null;
    /* 数字开头的展示值优先走写死的数值规则，比句式模板更贴近中文语序
       （"48% of base" → "基础值的 48%"，模板会得到"48%的基础"这类生硬结果） */
    var zh = /^[0-9+\-.]/.test(core) ? translateValueCore(core) : null;
    if (zh === null) zh = matchCore(core);
    if (zh === null) zh = translateValueCore(core);
    if (zh === null) return null;
    var lead = text.match(/^\s*/)[0];
    var trail = text.match(/\s*$/)[0];
    return lead + zh + trail;
  }

  /* ------------------------------------------------------------------ 词典装配 */

  /** 模板归一化：内置已编译（re/tpl/allowEnglish），远端 JSON 可能是原始 {p, r} */
  function normalizePatterns(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p) continue;
      if (p.re instanceof RegExp && typeof p.tpl === 'string') {
        out.push({ re: p.re, tpl: p.tpl, allowEnglish: !!p.allowEnglish });
        continue;
      }
      if (typeof p.r === 'string' && (typeof p.p === 'string' || p.re instanceof RegExp)) {
        var allow = p.r.charAt(0) === '!';
        var tpl = allow ? p.r.slice(1) : p.r;
        var re = p.re instanceof RegExp ? p.re : compileSource(p.p);
        if (re) out.push({ re: re, tpl: tpl, allowEnglish: allow });
        continue;
      }
      /* 兼容 v0.2.0 的 { re, replace } / { re, fn } 写法 */
      if (p.re instanceof RegExp && typeof p.replace === 'string') {
        out.push({ re: p.re, tpl: p.replace, allowEnglish: hasResidualEnglish(p.replace) });
      }
    }
    return out;
  }

  /** 原始 p 串编译：裸 # 视作数值占位符，$n 序号随之后移 */
  function compileSource(p) {
    var out = [], i = 0, orig = 0, cur = 0, map = {}, nums = [], n = p.length;
    var NUM = '[+-]?\\d+(?:\\.\\d+)?';
    while (i < n) {
      var c = p.charAt(i);
      if (c === '\\') {
        out.push(p.substr(i, 2));
        i += 2;
        continue;
      }
      if (c === '[') {
        var j = i + 1;
        if (p.charAt(j) === '^') j += 1;
        if (p.charAt(j) === ']') j += 1;
        while (j < n && p.charAt(j) !== ']') {
          if (p.charAt(j) === '\\') j += 1;
          j += 1;
        }
        out.push(p.slice(i, j + 1));
        i = j + 1;
        continue;
      }
      if (c === '#') {
        cur += 1;
        nums.push(cur);
        out.push('(' + NUM + ')');
        i += 1;
        continue;
      }
      if (c === '(') {
        if (p.substr(i + 1, 2) === '?<') {
          cur += 1;
          orig += 1;
          map[orig] = cur;
        } else if (p.charAt(i + 1) !== '?') {
          cur += 1;
          orig += 1;
          map[orig] = cur;
        }
        out.push(c);
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
    }
    try {
      return new RegExp(out.join(''), 'i');
    } catch (e) {
      return null;
    }
  }

  /**
   * 设置词典与开关。
   * 词典覆盖顺序：内置（ui/full）< 远端 < 用户自定义。
   * zhLevel='ui' 只用界面级词库（UI + 类别 + 通货名），'full' 用全量（再叠加术语）。
   */
  function configure(opt) {
    opt = opt || {};
    var full = opt.level !== 'ui';
    var layers = [];

    if (full) {
      if (opt.fullDict) layers.push(opt.fullDict);
      else if (opt.dict) layers.push(opt.dict);
      if (opt.terms) layers.push(opt.terms);
    } else {
      if (opt.uiDict) layers.push(opt.uiDict);
      else if (opt.dict) layers.push(opt.dict);
    }
    if (opt.remoteDict) layers.push(opt.remoteDict);
    if (opt.userDict) layers.push(opt.userDict);

    var merged = {};
    for (var i = 0; i < layers.length; i++) {
      var src = layers[i];
      if (!src || typeof src !== 'object') continue;
      for (var k in src) {
        if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
        if (typeof src[k] === 'string' && src[k]) merged[k] = src[k];
      }
    }
    var lower = {};
    for (var key in merged) lower[key.toLowerCase()] = merged[key];

    state.dict = merged;
    state.dictLower = lower;
    state.byId = opt.byId || {};
    state.patternsList = normalizePatterns(opt.patternsList);
    state.level = full ? 'full' : 'ui';
    state.patterns = opt.patterns !== false;

    var wasEnabled = state.enabled;
    state.enabled = !!opt.enabled;

    if (!state.enabled) {
      if (wasEnabled) restore();
      return summary();
    }
    start();
    applyAll();
    return summary();
  }

  /* ------------------------------------------------------------------ 跳过规则 */

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName]) return true;
    if (el.id === 'ptc-root') return true;
    if (el.getAttribute && el.getAttribute('data-ptc-skip') === '1') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function warnSkipped(el) {
    return !!(el && el.closest && el.closest(SKIP_SELECTOR));
  }

  /**
   * 属性汉化目标判定：与文本节点不同，placeholder / title / aria-label 常挂在
   * input / select / textarea 上，因此这里不能套用 SKIP_TAGS（只排除本扩展自身 UI 与预格式区）。
   */
  function isAttrTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS[el.tagName] && el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') {
      return false;
    }
    if (el.id === 'ptc-root') return false;
    if (el.getAttribute && el.getAttribute('data-ptc-skip') === '1') return false;
    if (warnSkipped(el)) return false;
    return true;
  }

  /** 聚合安全自检：内部含表单控件/媒体/预格式文本时，放弃聚合（退回逐节点） */
  function hasBlockedDescendant(el) {
    var kids = el.querySelectorAll ? el.querySelectorAll('*') : [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (AGG_BLOCK_TAGS[k.tagName]) return true;
      if (k.getAttribute && k.getAttribute('data-ptc-skip') === '1') return true;
    }
    if (el.querySelector && el.querySelector(SKIP_SELECTOR)) return true;
    return false;
  }

  /* ----------------------------------------------------- 第一层：父元素聚合匹配（React 拆节点修复） */

  function isAggCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!AGG_TAGS[el.tagName]) return false;
    if (el.childNodes.length < 2) return false;   // 单节点交给 TreeWalker
    if (!el.isConnected) return false;
    if (shouldSkipElement(el) || warnSkipped(el)) return false;
    var raw = el.textContent || '';
    if (!raw) return false;
    var core = normalize(raw);
    if (!core || core.length > MAX_AGG_LEN) return false;
    return isCandidate(core);
  }

  /**
   * 整块聚合：元素文本整体命中后，把子节点合并为单一文本节点。
   * 原文子节点保留在记录里，还原时原样塞回，可见内容与结构均能回退。
   */
  /** 收集元素内部可写文本节点（只收集，不增删节点） */
  function collectTextDesc(el, out) {
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { out.push(n); continue; }
      if (n.nodeType !== 1) continue;
      // 图标 / 图片类子元素内部没有界面文案，跳过
      if (AGG_KEEP_TAGS[n.tagName]) continue;
      collectTextDesc(n, out);
    }
    return out;
  }

  /** 写文本节点并维护还原快照（与 translateNode 共用 state.records） */
  function writeTextNode(node, value) {
    var rec = state.records.get(node);
    var current = node.nodeValue;
    if (rec && current !== rec.output) rec = { origin: current, output: current };
    if (!rec) rec = { origin: current, output: current };
    if (current !== value) node.nodeValue = value;
    rec.output = value;
    rec.locked = true;   // 聚合结果独占该节点，逐节点通道不得再覆盖
    state.records.set(node, rec);
  }

  /**
   * 父元素聚合匹配（v0.3.3 起为非破坏式）。
   * 旧实现把 el 的子节点整体摘除、再追加译文文本节点：官网（React）仍持有这些被摘走的
   * 节点引用，随后对它们做 removeChild / 复用时会抛 NotFoundError，结果区渲染链路中断，
   * 页面永久停在“加载中”。现在改为就地改写已有文本节点的 nodeValue，节点身份完全保留。
   */
  function aggregate(el) {
    if (!isAggCandidate(el) || hasBlockedDescendant(el)) return false;
    var core = normalize(el.textContent || '');
    if (!core) return false;
    var zh = matchCore(core);
    if (!zh || zh === core) return false;
    var nodes = collectTextDesc(el, []);
    if (!nodes.length) return false;
    var target = null;
    for (var i = 0; i < nodes.length; i++) {
      if (normalize(nodes[i].nodeValue || '')) { target = nodes[i]; break; }
    }
    if (!target) return false;
    if (nodes.length === 1 && normalize(target.nodeValue || '') === zh) return false;
    writeTextNode(target, zh);
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j] === target) continue;
      writeTextNode(nodes[j], '');
    }
    state.stats.collapsed += 1;
    return true;
  }

  var AGG_QUERY = 'button, a, span, div, label, li, p, h1, h2, h3, h4, h5, h6, td, th, dt, dd, ' +
    'strong, em, b, i, small, legend, summary, figcaption, caption, option, section, article, ' +
    'header, footer, aside, nav, main';

  /** 采集聚合候选：倒序遍历（子元素先于父元素），避免父元素先吃掉了子元素的精确匹配机会 */
  function collectAgg(root, out) {
    if (!state.enabled || !root) return out;
    var list = [];
    if (root.nodeType === 1) {
      if (AGG_TAGS[root.tagName]) list.push(root);
      if (root.querySelectorAll) {
        var all = root.querySelectorAll(AGG_QUERY);
        for (var i = all.length - 1; i >= 0; i--) list.push(all[i]);
      }
    } else if (root.nodeType === 3 && root.parentElement) {
      list.push(root.parentElement);
    }
    for (var j = 0; j < list.length; j++) {
      if (isAggCandidate(list[j])) out.push(list[j]);
    }
    return out;
  }

  /* -------------------------------------------------------- 第二层：文本节点与属性（兜底） */

  function translateNode(node) {
    if (!node || node.nodeType !== 3) return false;
    var origin = state.records.get(node);
    var current = node.nodeValue;
    if (origin && current !== origin.output) {
      origin = { origin: current, output: current };
      state.records.set(node, origin);
    }
    // 已被聚合写入（或聚合清空）的节点：保留聚合结果，避免两个通道互相覆盖
    if (origin && origin.locked) return false;
    var base = origin ? origin.origin : current;
    if (!isCandidate(normalize(base))) {
      if (!origin) state.records.set(node, { origin: current, output: current });
      return false;
    }
    var zh = translate(base);
    if (zh === null) {
      if (!origin) state.records.set(node, { origin: current, output: current });
      return false;
    }
    if (current !== zh) node.nodeValue = zh;
    var host = node.parentElement;
    if (host && host.setAttribute) {
      try {
        host.setAttribute('data-ptc-zh', '1');
      } catch (e) {
        /* ignore */
      }
    }
    state.records.set(node, { origin: base, output: zh });
    state.stats.translated += 1;
    return true;
  }

  function translateAttr(el, name) {
    var raw = el.getAttribute(name);
    if (raw === null || raw === '' || !isCandidate(normalize(raw))) return false;
    var store = state.attrRecords.get(el);
    if (!store) {
      store = {};
      state.attrRecords.set(el, store);
    }
    var rec = store[name];
    if (rec && raw !== rec.output) rec = store[name] = { origin: raw, output: raw };
    var base = rec ? rec.origin : raw;
    var zh = translate(base);
    if (zh === null) {
      if (!rec) store[name] = { origin: raw, output: raw };
      return false;
    }
    if (raw !== zh) el.setAttribute(name, zh);
    store[name] = { origin: base, output: zh };
    state.stats.translated += 1;
    return true;
  }

  function translateAttrs(el) {
    var n = 0;
    for (var i = 0; i < ATTRS.length; i++) {
      if (el.hasAttribute && el.hasAttribute(ATTRS[i]) && translateAttr(el, ATTRS[i])) n += 1;
    }
    return n;
  }

  /** 采集文本节点 + 属性，供分片处理 */
  function collectText(root, out) {
    if (!state.enabled || !root) return out;
    if (root.nodeType === 3) {
      var tp = root.parentElement;
      if (tp && !shouldSkipElement(tp) && !warnSkipped(tp)) out.push({ node: root });
      return out;
    }
    if (root.nodeType !== 1 || shouldSkipElement(root) || warnSkipped(root)) return out;

    if (root.hasAttribute && isAttrTarget(root)) out.push({ el: root });
    var els = root.querySelectorAll ? root.querySelectorAll('[placeholder], [title], [aria-label]') : [];
    for (var e = 0; e < els.length; e++) {
      if (isAttrTarget(els[e])) out.push({ el: els[e] });
    }

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var parent = node.parentElement;
      if (!parent || shouldSkipElement(parent) || warnSkipped(parent)) continue;
      out.push({ node: node });
    }
    return out;
  }

  /* -------------------------------------------------------------------- 调度 */

  var aggQueue = [];
  var textQueue = [];
  var pendingRoots = [];
  var textPassDone = false;
  var drainScheduled = false;

  function idle(cb) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(cb, { timeout: 200 });
    } else {
      setTimeout(cb, 0);
    }
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;
    idle(drain);
  }

  function drain() {
    drainScheduled = false;
    if (!state.enabled) {
      aggQueue = [];
      textQueue = [];
      pendingRoots = [];
      return;
    }
    var budget = BATCH_LIMIT;
    state.applying = true;
    try {
      /* 阶段一：父元素聚合（必须整体先跑，避免子节点被提前逐节点改写） */
      while (budget > 0 && aggQueue.length) {
        var el = aggQueue.shift();
        budget -= 1;
        if (!el || !el.isConnected) continue;
        aggregate(el);
      }
      /* 阶段二：文本节点与属性兜底 */
      if (budget > 0 && !aggQueue.length) {
        if (!textPassDone && document.body) {
          collectText(document.body, textQueue);
          textPassDone = true;
        }
        while (pendingRoots.length) {
          var r = pendingRoots.shift();
          if (r && r.isConnected) collectText(r, textQueue);
        }
        while (budget > 0 && textQueue.length) {
          var it = textQueue.shift();
          budget -= 1;
          if (it.node) {
            if (!it.node.isConnected) continue;
            state.stats.nodes += 1;
            translateNode(it.node);
          } else if (it.el) {
            if (!it.el.isConnected) continue;
            translateAttrs(it.el);
          }
        }
      }
    } finally {
      state.applying = false;
    }
    if (aggQueue.length || textQueue.length || pendingRoots.length) scheduleDrain();
  }

  function applyAll() {
    if (!state.enabled) return 0;
    aggQueue = [];
    textQueue = [];
    pendingRoots = [];
    textPassDone = false;
    collectAgg(document.body, aggQueue);
    scheduleDrain();
    return aggQueue.length;
  }

  /** 动态节点：先入聚合队列，文本采集延后到聚合阶段结束后 */
  function schedule(root) {
    if (!state.enabled || !root) return;
    if (!root.isConnected) return;
    collectAgg(root, aggQueue);
    if (pendingRoots.length < 200) pendingRoots.push(root);
    scheduleDrain();
  }

  /* -------------------------------------------------------------------- 还原 */

  function restoreCollapses() {
    for (var i = state.collapses.length - 1; i >= 0; i--) {
      var rec = state.collapses[i];
      var el = rec.el;
      if (!el || !el.isConnected) continue;
      if (normalize(el.textContent || '') !== normalize(rec.output)) continue;  // 页面已自行改写，不强行回写
      while (el.firstChild) el.removeChild(el.firstChild);
      for (var j = 0; j < rec.nodes.length; j++) el.appendChild(rec.nodes[j]);
      try {
        el.removeAttribute('data-ptc-zh');
      } catch (e) {
        /* ignore */
      }
    }
    state.collapses = [];
    state.collapseIndex = new WeakMap();
    state.stats.collapsed = 0;
  }

  function restore() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    aggQueue = [];
    textQueue = [];
    pendingRoots = [];
    textPassDone = false;
    drainScheduled = false;
    if (document.body) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        var rec = state.records.get(node);
        if (rec && rec.origin !== rec.output && node.nodeValue === rec.output) node.nodeValue = rec.origin;
        if (rec && rec.locked) rec.locked = false;
      }
      var els = document.body.querySelectorAll('[placeholder], [title], [aria-label]');
      for (var i = 0; i < els.length; i++) {
        var store = state.attrRecords.get(els[i]);
        if (!store) continue;
        for (var name in store) {
          if (!Object.prototype.hasOwnProperty.call(store, name)) continue;
          var arec = store[name];
          if (arec.origin !== arec.output && els[i].getAttribute(name) === arec.output) {
            els[i].setAttribute(name, arec.origin);
          }
        }
      }
    }
    restoreCollapses();
    state.enabled = false;
    state.stats = { nodes: 0, translated: 0, collapsed: 0 };
  }

  function start() {
    if (state.observer || !document.body) return;
    state.observer = new MutationObserver(function (records) {
      // 重入保护：自身改写触发的记录一律忽略，避免翻译→观察→再翻译的递归
      if (!state.enabled || state.applying) return;
      for (var i = 0; i < records.length; i++) {
        var rec = records[i];
        if (rec.type === 'childList') {
          for (var j = 0; j < rec.addedNodes.length; j++) {
            var node = rec.addedNodes[j];
            if (!node) continue;
            if (node.nodeType === 1) {
              schedule(node);
            } else if (node.nodeType === 3 && node.parentElement) {
              schedule(node.parentElement);
            }
          }
        } else if (rec.type === 'characterData') {
          // React 自行改写文本：可能重新拆分了子节点，先就地尝试整块聚合，再退回逐节点
          var target = rec.target;
          if (!target || !target.parentElement) continue;
          var host = target.parentElement;
          if (host.childNodes.length > 1) {
            state.applying = true;
            try {
              aggregate(host);
            } finally {
              state.applying = false;
            }
          }
          if (target.isConnected) translateNode(target);
        }
      }
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function summary() {
    return {
      enabled: state.enabled,
      level: state.level,
      patterns: state.patterns,
      dictSize: Object.keys(state.dict).length,
      patternCount: state.patternsList.length,
      translated: state.stats.translated,
      collapsed: state.stats.collapsed,
      scanned: state.stats.nodes
    };
  }

  function lookupById(id) {
    return state.byId[id] || null;
  }

  SELF.Localizer = {
    configure: configure,
    applyAll: applyAll,
    restore: restore,
    translate: translate,
    lookupById: lookupById,
    summary: summary,
    // 供单测观察内部状态
    _state: state
  };
})();
