/**
 * PoE Trade Companion — 筛选器搜索「中英双向匹配」桥接（v0.3.5）
 *
 * 背景：官网市集筛选器的全量搜索框（含快捷列表下拉）由站点自身的组件完成匹配，
 * 官方匹配只看英文文案 / 英文 id（如 "turquoise amulet"、"accessories"），
 * 界面被汉化后用户输入「青玉护符/饰品」匹配不到任何选项，只能退回英文。
 *
 * 本脚本运行在 MAIN world（与 inject.js 同一世界，可读到 PTC_I18N 词库与被改写的
 * 筛选数据），做两件事，且两件事都**不改动任何选项的 id / type**，因此提交给官网的
 * 查询值仍是官网期望的英文枚举：
 *
 *   1) 优先：包一层站点组件的过滤函数（Vue 2 / Vue 3 的 filter 函数均尝试），
 *      使匹配同时接受「当前展示语言」与「另一种语言」——中文输入命中英文选项、
 *      英文输入命中已汉化选项，两向都能出结果，输入框里保留用户原文。
 *
 *   2) 兜底：若拿不到组件实例（站点改用闭包内匹配），监听搜索框输入，
 *      在「输入后依然没有候选」时，把查询词换成另一种语言的等价词再重新触发输入，
 *      让站点用自己的匹配逻辑跑出结果（框内文本可能变为该语言原文，属兜底路径）。
 *
 * 安全约束：只读 option 文案与 id；不写 id / type / 不构造查询参数；不动输入框以外的 DOM。
 */
(function () {
  if (window.__PTC_SEARCH_BRIDGE__) return;
  window.__PTC_SEARCH_BRIDGE__ = true;

  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  var MULTI_SEL = '.multiselect, [class*="multiselect"], [class*="select2"], [class*="search-select"]';
  var MAX_TRIED = 12;

  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[\u3000\s]+/g, ' ')
      .replace(/[\u2018\u2019]/g, "'")
      .trim()
      .toLowerCase();
  }

  function hasCJK(s) {
    return CJK.test(String(s || ''));
  }

  /* ------------------------------------------------------------ 词库反向索引 */

  var revZh2En = null;      // 中文（归一化）→ 英文小写词条
  var en2ZhDict = null;     // 英文小写词条 → 中文
  var preciseZh2En = null;  // 中文（归一化）→ 官网枚举 id / 选项英文原文（来自筛选词库，精确对齐）

  function buildIndex() {
    var I = window.PTC_I18N || {};
    var d = I.dict || {};
    en2ZhDict = d;
    revZh2En = Object.create(null);
    for (var en in d) {
      if (!Object.prototype.hasOwnProperty.call(d, en)) continue;
      var zh = d[en];
      if (typeof zh !== 'string' || !zh) continue;
      var k = norm(zh);
      if (!k) continue;
      if (!revZh2En[k] || String(en).length < revZh2En[k].length) revZh2En[k] = en;
    }
    buildPreciseIndex();
  }

  /**
   * 精确索引：筛选词库（PTC_FILTERS_ZH）里 option 映射的「非顺序键」就是官网发给
   * 服务端的枚举 id（如 accessories / turquoise-amulet），中文值即界面展示文案；
   * optionText 则是「选项英文原文 → 中文」。两者都比通用词库更贴近筛选项的真实取值，
   * 因此优先使用，长尾选项（词库未收录中文名）也能准确换算出英文查询值。
   */
  function buildPreciseIndex() {
    preciseZh2En = Object.create(null);
    var fz = window.PTC_FILTERS_ZH;
    if (!fz || typeof fz !== 'object') return;
    var put = function (zh, en) {
      var k = norm(zh);
      var e = norm(en);
      if (!k || !e) return;
      var arr = preciseZh2En[k] || (preciseZh2En[k] = []);
      if (arr.indexOf(e) < 0) arr.push(e);
    };
    var opt = fz.option || {};
    for (var g in opt) {
      if (!Object.prototype.hasOwnProperty.call(opt, g)) continue;
      var bag = opt[g];
      if (!bag || typeof bag !== 'object') continue;
      for (var key in bag) {
        if (!Object.prototype.hasOwnProperty.call(bag, key)) continue;
        if (key.indexOf('__') === 0) continue;   // 顺序键不是枚举标识，不可当作查询值
        if (typeof bag[key] === 'string' && bag[key]) put(bag[key], key);
      }
    }
    var ot = fz.optionText || {};
    for (var enText in ot) {
      if (!Object.prototype.hasOwnProperty.call(ot, enText)) continue;
      if (typeof ot[enText] === 'string' && ot[enText]) put(ot[enText], enText);
    }
  }

  /** 重建索引（词库异步到位后可手动刷新） */
  function rebuildIndex() {
    buildIndex();
    return true;
  }

  /** 中文查询 → 英文词条候选（精确优先，其次包含关系里最短的键） */
  function zhToEn(query, limit) {
    if (!revZh2En || !preciseZh2En) buildIndex();
    var q = norm(query);
    var out = [];
    if (!q) return out;
    var precise = preciseZh2En[q];
    if (precise) { for (var pi = 0; pi < precise.length; pi++) if (out.indexOf(precise[pi]) < 0) out.push(precise[pi]); }
    if (revZh2En[q] && out.indexOf(revZh2En[q]) < 0) out.push(revZh2En[q]);
    /* 精确库里的包含匹配优先（中文片段 → 对应枚举），再退通用词库 */
    var best = null;
    var bkey = null;
    for (var pk in preciseZh2En) {
      if (pk === q) continue;
      if (pk.indexOf(q) >= 0) {
        if (!best || pk.length < bkey.length) { best = preciseZh2En[pk][0]; bkey = pk; }
      }
    }
    if (best && out.indexOf(best) < 0) out.push(best);
    var bestEn = null;
    var bestKey = null;
    for (var k in revZh2En) {
      if (k === q) continue;
      if (k.indexOf(q) >= 0) {
        if (!bestEn || k.length < bestKey.length) { bestEn = revZh2En[k]; bestKey = k; }
      }
    }
    if (bestEn && out.indexOf(bestEn) < 0) out.push(bestEn);
    return out.slice(0, limit || 3);
  }

  /** 英文查询 → 中文词条候选 */
  function enToZh(query, limit) {
    if (!en2ZhDict) buildIndex();
    var q = norm(query);
    var out = [];
    if (!q) return out;
    if (en2ZhDict[q]) out.push(norm(en2ZhDict[q]));
    var best = null;
    for (var k in en2ZhDict) {
      if (k === q) continue;
      if (k.indexOf(q) >= 0) {
        if (!best || k.length < best.length) best = k;
      }
    }
    if (best && out.indexOf(norm(en2ZhDict[best])) < 0) out.push(norm(en2ZhDict[best]));
    return out.slice(0, limit || 3);
  }

  /* -------------------------------------------------------------- 选项匹配 */

  function optionStrings(option, label) {
    var arr = [];
    var push = function (v) {
      var s = norm(v);
      if (s && arr.indexOf(s) < 0) arr.push(s);
    };
    push(label);
    if (option && typeof option === 'object') {
      push(option.text);
      push(option.label);
      push(option.name);
      push(option.title);
      push(option.__ptcRaw);   // inject.js 在改写前记下的英文原文
      push(option.id);         // 官网提交用的枚举标识，英文，只读参与匹配
      push(option.type);
    } else {
      push(option);
    }
    return arr;
  }

  /** 单语种内匹配：任一语言候选包含查询即命中 */
  function matchStrings(hay, query) {
    var q = norm(query);
    if (!q) return true;
    for (var i = 0; i < hay.length; i++) {
      if (hay[i].indexOf(q) >= 0 || hay[i] === q) return true;
    }
    return false;
  }

  /**
   * 双向匹配核心：先按查询原文匹配（保留官网原生行为），
   * 未命中再把查询翻成另一种语言重试。
   */
  function matchOption(option, label, query) {
    var q = norm(query);
    if (!q) return true;
    var hay = optionStrings(option, label);
    if (matchStrings(hay, q)) return true;

    var alts = hasCJK(q) ? zhToEn(q, 3) : enToZh(q, 3);
    for (var i = 0; i < alts.length; i++) {
      if (alts[i] && matchStrings(hay, alts[i])) return true;
    }

    /* 多词查询：整体翻译没命中时，退化为逐词 AND（每词自身可跨语言匹配） */
    var tokens = q.split(' ').filter(Boolean);
    if (tokens.length > 1) {
      for (var t = 0; t < tokens.length; t++) {
        if (!matchOption(option, label, tokens[t])) return false;
      }
      return true;
    }
    return false;
  }

  /* -------------------------------------------------------- 组件实例定位 */

  function getVm(el) {
    var node = el;
    var guard = 0;
    while (node && guard++ < 8) {
      if (node.__vue__) return node.__vue__;                       // Vue 2
      if (node.__vueParentComponent) return node.__vueParentComponent;  // Vue 3
      node = node.parentElement;
    }
    return null;
  }

  function vmOptions(vm) {
    if (!vm) return [];
    var cands = [];
    if (Array.isArray(vm.options)) cands.push(vm.options);
    if (vm.$props && Array.isArray(vm.$props.options)) cands.push(vm.$props.options);
    if (vm.props && Array.isArray(vm.props.options)) cands.push(vm.props.options);
    if (vm.$data && Array.isArray(vm.$data.options)) cands.push(vm.$data.options);
    for (var i = 0; i < cands.length; i++) {
      if (cands[i] && cands[i].length) return cands[i];
    }
    return [];
  }

  function wrapFilter(orig) {
    return function (option, label, search) {
      var hit = false;
      try {
        if (typeof orig === 'function') hit = !!orig.call(this, option, label, search);
      } catch (e) {
        hit = false;
      }
      if (hit) return true;
      try {
        return matchOption(option, label, search);
      } catch (e) {
        return false;
      }
    };
  }

  /** 给组件的过滤函数套一层双向匹配；成功返回 true */
  function patchVm(vm) {
    if (!vm || vm.__ptcSearchPatched) return !!vm && vm.__ptcSearchPatched;
    var done = false;
    var slots = [];
    try { if (typeof vm.filter === 'function') slots.push({ objs: [vm], key: 'filter' }); } catch (e) { /* ignore */ }
    if (vm._props && typeof vm._props.filter === 'function') slots.push({ objs: [vm._props], key: 'filter' });
    if (vm.props && typeof vm.props.filter === 'function') slots.push({ objs: [vm.props], key: 'filter' });

    for (var i = 0; i < slots.length && !done; i++) {
      var s = slots[i];
      for (var j = 0; j < s.objs.length && !done; j++) {
        var obj = s.objs[j];
        try {
          var orig = obj[s.key];
          obj[s.key] = wrapFilter(orig);
          done = true;
          if (vm._props && vm._props !== obj && typeof vm._props.filter === 'function') {
            vm._props.filter = obj[s.key];
          }
        } catch (e) {
          /* 只读属性，换下一种途径 */
        }
      }
    }
    if (done) {
      try { vm.__ptcSearchPatched = true; } catch (e) { /* ignore */ }
    }
    return done;
  }

  /**
   * 统计下拉里真实可选的候选数量。
   * vue-multiselect 在无结果时会渲染一个 class 含 --disabled 的占位提示项，
   * 该节点不算命中，故排除，否则「无结果」永远被判成「有结果」而挡住兜底转换。
   */
  function countOptions(root) {
    if (!root || !root.querySelectorAll) return 0;
    var nodes = root.querySelectorAll('.multiselect__option, [class*="option"]');
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var cls = String(nodes[i].className || '');
      if (cls.indexOf('--disabled') >= 0 || cls.indexOf('no-result') >= 0) continue;
      n += 1;
    }
    return n;
  }

  /* --------------------------------------------------------- 兜底：改写查询 */

  /**
   * 定位搜索框所属的组件容器。
   * 注意：搜索输入框自身的 class 往往就是 multiselect__input，会命中 [class*="multiselect"]，
   * 因此绝不能直接用 el.closest(MULTI_SEL)，否则容器会被误判为输入框本身，
   * 候选数永远是 0。必须从父节点开始向上找。
   */
  function searchRoot(el) {
    if (!el) return null;
    var node = el.parentElement;
    while (node && node.nodeType === 1) {
      var cls = String(node.className || '');
      if (cls === 'multiselect' || /(^|\s)multiselect(\s|$)/.test(cls)) return node;
      if (/multiselect|select2|search-select/.test(cls)) return node;
      node = node.parentElement;
    }
    return el.parentElement;
  }

  function isSearchInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var type = String(el.getAttribute('type') || 'text').toLowerCase();
    if (type !== 'text' && type !== 'search') return false;
    if (el.closest && el.closest(MULTI_SEL)) return true;
    var ph = String(el.getAttribute('placeholder') || '');
    return /搜索|查找|筛选|search|filter/i.test(ph);
  }

  function setNativeValue(el, value) {
    var desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  /** 从组件选项里找出与查询等价的另一种语言写法 */
  function equivalentQuery(el, query) {
    var q = norm(query);
    var vm = getVm(el);
    var opts = vmOptions(vm);
    var i, o, s;
    for (i = 0; i < opts.length; i++) {
      o = opts[i];
      var hay = optionStrings(o, o && (o.text || o.label));
      if (!matchStrings([hay[0] || ''], q) && hay.indexOf(q) < 0) continue;
      /* 命中当前展示语言：吐出英文原文（官网匹配目标）或反之 */
      var target = hasCJK(q) ? norm(o.__ptcRaw || o.id || '') : norm(o.text || o.label || '');
      if (target && target !== q) return target;
      s = hasCJK(q) ? zhToEn(q, 1)[0] : enToZh(q, 1)[0];
      if (s && s !== q) return s;
    }
    s = hasCJK(q) ? zhToEn(q, 1)[0] : enToZh(q, 1)[0];
    return s && s !== q ? s : null;
  }

  function onInput(e) {
    var el = e.target;
    if (!isSearchInput(el)) return;
    var q = String(el.value || '');
    if (!q.trim()) return;
    var st = el.__ptcSearchState || (el.__ptcSearchState = { tried: [], timer: 0 });
    if (st.tried.indexOf(q) >= 0) return;   // 同一个值不重复转换，避免中英来回抖动
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(function () {
      try {
        var root = searchRoot(el);
        if (countOptions(root) > 0) return;      // 站点自身已匹配出候选，无需介入
        var alt = equivalentQuery(el, q);
        if (!alt) return;
        if (st.tried.length >= MAX_TRIED) st.tried = [];
        st.tried.push(q);
        st.tried.push(alt);
        setNativeValue(el, alt);
        el.setAttribute('data-ptc-query-zh', q);
        el.title = (hasCJK(q) ? '中文检索：' + q + ' → ' + alt : '英文检索：' + q + ' → ' + alt);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err) {
        /* 兜底失败不影响站点原有行为 */
      }
    }, 90);
  }

  /* ---------------------------------------------------------------- 安装 */

  function patchAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll(MULTI_SEL);
    var n = 0;
    for (var i = 0; i < nodes.length; i++) {
      var vm = getVm(nodes[i]);
      if (patchVm(vm)) n += 1;
    }
    /* 组件根节点本身不在 querySelectorAll 结果里的情况（元素自己就是 .multiselect） */
    if (scope.nodeType === 1 && scope.matches && scope.matches(MULTI_SEL)) {
      if (patchVm(getVm(scope))) n += 1;
    }
    return n;
  }

  var observer = null;

  /**
   * 立即挂载：输入监听与 MutationObserver 只依赖 document 本身，
   * 在 document_start 阶段就要生效，避免页面尚未触发 DOMContentLoaded 时空窗。
   */
  function install() {
    buildIndex();
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
    if (observer) return;
    observer = new MutationObserver(function () {
      patchAll(document);
    });
    try {
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
    patchAll(document);
  }

  function installLater() {
    try {
      buildIndex();
      patchAll(document);
    } catch (e) {
      /* ignore */
    }
  }

  window.PTC_SEARCH = {
    install: install,
    patchAll: patchAll,
    patchVm: patchVm,
    matchOption: matchOption,
    zhToEn: zhToEn,
    enToZh: enToZh,
    rebuildIndex: rebuildIndex,
    countOptions: countOptions
  };

  install();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installLater, { once: true });
  }
  window.addEventListener('load', installLater, { once: true });
})();
