/**
 * PoE Trade Companion — 筛选器搜索「中英双向匹配」桥接（v0.4.1）
 *
 * v0.4.1：中文检索改为「输入镜像」，彻底不依赖官网组件实例。
 * 旧版兜底要么等站点自己也匹配不出候选（countOptions 读取下拉数量，拿不到数量时
 * 永不触发），要么必须 patch 到 Vue 组件的 filter 函数；官网改版或组件闭包化后
 * 这两条路都会静默失效，用户输入「女王」只剩官网原生的「搜索 女王」一项。
 * 现在改为纯输入镜像：
 *   1) 监听筛选搜索框 input（IME 组合期一律不介入），输入含 CJK 且词库命中时，
 *      用「中文 → 英文」词库把输入值换算成官网原生过滤一定能命中的英文串，
 *      填入输入框并派发 input/change，站点下拉随即正常出现对应选项；
 *   2) 唯一强匹配（精确 / 前缀 / 正向子串）时在输入静止 MIRROR_DELAY 毫秒后自动换算，
 *      避免打断仍在继续的中文输入；多个候选时用自绘浮层列出「中文（English）」，
 *      由用户点选后填入英文原文；
 *   3) 浮层触发条件改为「输入含 CJK 且词库有匹配即显示」，不再读取官网候选数量，
 *      因此是否存在 Vue 实例、下拉是否已渲染都不影响中文检索；
 *   4) 输入框被换算成英文后，通过 data-ptc-query-zh / title / 输入框下方提示条
 *      保留用户可见的中文原文提示，避免「我打的中文怎么没了」；
 *   5) 逐次输入写入可观测日志（原始输入 / 是否含 CJK / 匹配数 / 替换值 / 模式 /
 *      是否依赖组件实例），进 data-ptc-diag 与 console，便于用户自查。
 * 不变量：官网下拉项文本仍是「中文（English）」双语、提交值恒为英文、
 * 纯英文输入零干预、IME 组合期零介入、不写任何 option 的 id/type。
 *
 * v0.4.0：挑战页判定纠偏。v0.3.8 用「页面存在 challenge-platform 脚本 / _cf_chl_opt /
 * 标题含安全验证」作为退出依据，但正常交易页同样常驻这些 Cloudflare 痕迹，导致桥接
 * 在正常页面从不启动、中文候选浮层与筛选匹配全部失效。现改为仅在文档确实被
 * Cloudflare 接管时退出（/cdn-cgi/ 路径、#challenge-form、#cf-challenge-running，
 * 或标题为挑战文案且页面无 PoE 应用根），且退出后由巡检持续观察，挑战消失即重新挂载。
 * 同时把启动状态（版本 / 是否启动 / 词库与索引条数 / hook 数 / 中止原因）发布到
 * window.__PTC_STATUS__ 与 documentElement[data-ptc-status]。
 *
 * v0.3.9：中文检索真正可用。①中文支持精确 / 前缀 / 子串匹配（如「女王的饥」可命中
 * 「女王的饥饿 → The Queen's Hunger」）；②候选浮层显示「中文（English 原文）」，
 * 选中后填入英文原文并派发 input/change，提交值保持英文；③不依赖 multiselect
 * 组件实例，patch 失败 / 非组件输入框零候选时自绘候选浮层兜底；④输入法组合期
 * 依然零介入；⑤纯英文输入绝不触发、不产生半中半英；⑥侧栏「诊断」页展示词库条数、
 * 反向索引条数、最近输入与命中数等桥接状态。
 *
 * v0.3.6：修复输入法（IME）组合输入被干扰。中文输入法尚未上屏（仍在候选/组合
 * 状态）时，本脚本不再介入：不改写输入框、不主动派发 input 事件、不扩展候选；
 * 只有 compositionend（字符真正上屏）之后才继续做中文候选补充。v0.3.5 的
 * 中英双向匹配能力与提交给官网的查询值（option.id / type 枚举）完全不变。
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
 *   2) 中文模糊匹配（v0.3.9）：zhScore 打分（精确 1000 / 前缀 720 / 子串 420 /
 *      反向包含 260·160），中文只需输入前缀或任意子串即可命中（「女王的饥」→「女王的饥饿」）；
 *      反向包含（用户多打字）要求键 ≥2 字且多出字数 ≤6，避免长串被单字键（如「的」）误命中。
 *
 *   3) 兜底：若拿不到组件实例（站点改用闭包内匹配）或 filter patch 失败，监听搜索框输入，
 *      在「输入后依然没有候选」时自绘候选浮层，按「中文（English 原文）」展示候选；
 *      点选后只往输入框填英文原文并派发 input + change，由站点原生逻辑提交，提交值始终为英文。
 *      纯英文输入不弹浮层、不改写；中文输入法组合期完全不介入。
 *
 *   4) 诊断（v0.3.9）：词库条数 / 反向索引条数 / 最近输入与命中数写入 data-ptc-diag，
 *      供侧栏「诊断」Tab 读取（MAIN world 与 content script 不共享 window，故走属性通道）。
 *
 * 安全约束：只读 option 文案与 id；不写 id / type / 不构造查询参数；不动输入框与浮层以外的 DOM。
 */
(function () {
  if (window.__PTC_SEARCH_BRIDGE__) return;
  window.__PTC_SEARCH_BRIDGE__ = true;

  /* ==========================================================================
   * v0.4.0 挑战页判定（纠偏 v0.3.8）
   *
   * 只有文档确实被 Cloudflare 接管才让出控制权：
   *   1) 地址进入 /cdn-cgi/ 边缘路径；
   *   2) DOM 存在 #challenge-form / #cf-challenge-running；
   *   3) 标题是挑战文案，且页面没有 PoE 应用根节点。
   * challenge-platform 脚本、challenges.cloudflare.com iframe、_cf_chl_opt
   * 在正常交易页同样常驻，只记为诊断信号，不再是退出依据。
   * 退出不写「一次性放弃」开关，巡检会持续观察并在挑战消失后重新挂载。
   * ========================================================================== */
  var VERSION = '0.4.1';
  var CHALLENGE_TITLE = /just a moment|请稍候|请稍後|正在验证|正在進行驗證|正在进行安全验证|安全验证|安全驗證|verifying you are human|checking your browser|attention required/i;
  var APP_ROOT_SELECTOR = '#trade, #app, #root, [data-trade-root], .trade-app';
  var BRIDGE = { started: false, installed: false, abortReason: '', guardTimer: null, ticks: 0, delay: 250 };
  var lastStatusJSON = '';

  function hasAppRoot() {
    try {
      if (document.querySelector(APP_ROOT_SELECTOR)) return true;
      var body = document.body;
      if (!body) return false;
      return !!(body.querySelector('nav, main, [class*="layout"], [class*="filter"]'));
    } catch (e) {
      return false;
    }
  }

  function challengeSignals() {
    var sig = [];
    try {
      if (/\/cdn-cgi\//.test(String(location.href || ''))) sig.push('url:/cdn-cgi/');
      if (document.getElementById('challenge-form')) sig.push('#challenge-form');
      if (document.getElementById('cf-challenge-running')) sig.push('#cf-challenge-running');
      var title = String(document.title || '');
      if (CHALLENGE_TITLE.test(title)) sig.push('title:' + title);
    } catch (e) { /* ignore */ }
    return sig;
  }

  function isChallengeTakeover() {
    try {
      var sig = challengeSignals();
      if (!sig.length) return false;
      for (var i = 0; i < sig.length; i++) {
        if (sig[i].indexOf('title:') !== 0) return true;
      }
      return !hasAppRoot();
    } catch (e) {
      return false;
    }
  }

  function isTradePath() {
    try {
      return /^\/(trade|trade2)(\/|$)/.test(String(location.pathname || ''));
    } catch (e) {
      return false;
    }
  }

  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  var MULTI_SEL = '.multiselect, [class*="multiselect"], [class*="select2"], [class*="search-select"]';
  var MAX_TRIED = 12;
  var INPUT_DELAY = 90;         // 普通输入后等待站点自身渲染候选的时间
  var POST_COMPOSE_DELAY = 60;  // 上屏（compositionend）后补做候选检查的延迟
  /* v0.4.1 输入镜像：唯一强匹配时在「输入静止」多久后把中文换算成英文填入 */
  var MIRROR_DELAY = 360;
  /* 只有精确（1000）/ 前缀（720-）/ 正向子串（420-）命中才自动镜像；
     反向包含（用户多打了字）分数更低，交给浮层由用户自己选，避免自动改错 */
  var MIRROR_AUTO_SCORE = 400;
  var MIRROR_LOG_MAX = 8;       // 逐次输入日志保留条数（诊断页展示用）
  var HINT_ID = 'ptc-zh-hint';  // 输入框被换成英文后，保留中文原文的小提示条

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
  var itemsZh2En = null;    // 中文（归一化）→ 物品名/基底名英文原文（v0.3.7 物品词库）
  var enDisplay = null;     // 英文（归一化）→ 原始英文文案（保留官网大小写，供镜像与浮层展示）

  /* v0.3.9：桥接诊断信息（供侧栏「诊断」页与用户自查，不参与匹配逻辑） */
  var DIAG = {
    version: VERSION,
    started: false,   // 桥接是否已启动（启动=已挂输入监听与观察器）
    installed: false, // 输入监听 / MutationObserver 是否在位
    abortReason: '',  // '' | challenge
    hooks: 0,         // 已 patch 的组件过滤函数数量
    dict: 0,        // 通用词库条数（英文 → 中文）
    rev: 0,         // 中文反向索引条数
    precise: 0,     // 筛选枚举精确索引条数
    items: 0,       // 物品/基底名索引条数
    lastQuery: '',  // 最近一次中文输入原文
    lastHits: 0,    // 最近一次输入命中的候选数
    lastEn: '',     // 最近一次命中的首选英文原文
    lastCommit: '', // 最近一次浮层选中提交（中文 → English）
    suggestShown: 0,// 浮层累计触发次数
    /* v0.4.1 输入镜像可观测字段 */
    mirrorCount: 0,     // 镜像累计执行次数（自动 + 浮层点选）
    lastMirror: '',     // 最近一次镜像：「中文 → 英文」
    mirrorMode: '',     // 'auto' 自动 | 'layer' 浮层点选 | 'vm' 组件等价换算 | 'none' 未命中
    depsVm: false,      // 镜像链路是否依赖官网组件实例（恒为 false）
    mirrorLog: [],      // 逐次输入日志，最近 MIRROR_LOG_MAX 条
    updatedAt: 0
  };

  function diagSnapshot() {
    if (!revZh2En) buildIndex();
    return {
      version: DIAG.version,
      started: DIAG.started,
      installed: DIAG.installed,
      abortReason: DIAG.abortReason,
      hooks: DIAG.hooks,
      dict: DIAG.dict,
      rev: DIAG.rev,
      precise: DIAG.precise,
      items: DIAG.items,
      lastQuery: DIAG.lastQuery,
      lastHits: DIAG.lastHits,
      lastEn: DIAG.lastEn,
      lastCommit: DIAG.lastCommit,
      suggestShown: DIAG.suggestShown,
      /* v0.4.1：镜像可观测字段（数组复制一份，避免外部直接改内部状态） */
      mirrorCount: DIAG.mirrorCount,
      lastMirror: DIAG.lastMirror,
      mirrorMode: DIAG.mirrorMode,
      depsVm: DIAG.depsVm,
      mirrorLog: DIAG.mirrorLog.slice(0),
      updatedAt: DIAG.updatedAt
    };
  }

  /**
   * 把诊断快照同时写到两个通道（ISOLATED world 读不到本世界的变量）：
   *   1) documentElement 的 data-ptc-diag 属性（content.js 可随时读）
   *   2) window 上的 ptc-bridge-diag 自定义事件（content.js 实时接收）
   */
  function syncDiag() {
    DIAG.updatedAt = Date.now();
    var d = diagSnapshot();
    try {
      document.documentElement.setAttribute('data-ptc-diag', JSON.stringify(d));
    } catch (e) { /* ignore */ }
    try {
      window.dispatchEvent(new CustomEvent('ptc-bridge-diag', { detail: d }));
    } catch (e) { /* ignore */ }
    publishStatus();
  }

  /**
   * v0.4.0：把启动状态合并进 documentElement[data-ptc-status]（与 inject / localizer 共用一条通道），
   * 同时在 console 打印一行摘要，便于用户端自查「桥接到底有没有跑起来」。
   */
  function publishStatus() {
    var snap;
    try {
      snap = {
        version: VERSION,
        started: !!BRIDGE.started,
        installed: !!BRIDGE.installed,
        abortReason: BRIDGE.abortReason,
        hooks: DIAG.hooks,
        dict: DIAG.dict,
        rev: DIAG.rev,
        precise: DIAG.precise,
        items: DIAG.items,
        lastQuery: DIAG.lastQuery,
        lastHits: DIAG.lastHits,
        mirrorCount: DIAG.mirrorCount,
        lastMirror: DIAG.lastMirror,
        mirrorMode: DIAG.mirrorMode,
        depsVm: DIAG.depsVm,
        challenge: {
          takeover: isChallengeTakeover(),
          hasAppRoot: hasAppRoot(),
          signals: challengeSignals(),
          title: String(document.title || ''),
          path: String(location.pathname || '')
        }
      };
      var S = window.__PTC_STATUS__ = window.__PTC_STATUS__ || {
        version: VERSION, world: 'main', startedAt: Date.now(), scripts: {}, challenge: null
      };
      S.version = S.version && S.version > VERSION ? S.version : VERSION;
      S.updatedAt = Date.now();
      S.challenge = snap.challenge;
      S.scripts = S.scripts || {};
      S.scripts.bridge = snap;

      var payload = { version: VERSION, world: 'main', challenge: snap.challenge, scripts: {} };
      try {
        var prev = JSON.parse(document.documentElement.getAttribute('data-ptc-status') || '{}');
        if (prev && prev.scripts && typeof prev.scripts === 'object') payload.scripts = prev.scripts;
      } catch (e) { /* 首次写入 */ }
      payload.scripts.bridge = {
        version: VERSION,
        started: snap.started,
        installed: snap.installed,
        abortReason: snap.abortReason,
        hooks: snap.hooks,
        dict: snap.dict,
        rev: snap.rev,
        precise: snap.precise,
        items: snap.items,
        /* v0.4.1：把镜像结果也带出 MAIN world，ISOLATED world 的侧栏可直接显示 */
        mirrorCount: snap.mirrorCount,
        lastMirror: snap.lastMirror,
        mirrorMode: snap.mirrorMode,
        depsVm: snap.depsVm
      };
      var json = JSON.stringify(payload);
      if (json !== lastStatusJSON) {
        lastStatusJSON = json;
        document.documentElement.setAttribute('data-ptc-status', json);
        if (typeof console !== 'undefined' && console.info) {
          console.info('[PTC v' + VERSION + '] bridge started=' + snap.started +
            ' installed=' + snap.installed +
            (snap.abortReason ? ' reason=' + snap.abortReason : '') +
            ' dict=' + snap.dict + ' rev=' + snap.rev + ' items=' + snap.items +
            ' hooks=' + snap.hooks +
            ' depsVm=' + DIAG.depsVm +
            (DIAG.lastMirror ? ' mirror=' + DIAG.lastMirror + '(' + DIAG.mirrorMode + ')' : '') +
            ' challenge=' + (snap.challenge.takeover ? 'yes(' + snap.challenge.signals.join(',') + ')' : 'no'));
        }
      }
    } catch (e) {
      /* 诊断失败不影响业务 */
    }
  }

  function buildIndex() {
    var I = window.PTC_I18N || {};
    var d = I.dict || {};
    en2ZhDict = d;
    revZh2En = Object.create(null);
    enDisplay = Object.create(null);   // v0.4.1：英文原始文案表（镜像展示与填充都取它）
    for (var en in d) {
      if (!Object.prototype.hasOwnProperty.call(d, en)) continue;
      var zh = d[en];
      if (typeof zh !== 'string' || !zh) continue;
      var k = norm(zh);
      if (!k) continue;
      if (!revZh2En[k] || String(en).length < revZh2En[k].length) revZh2En[k] = en;
    }
    for (var en0 in d) {
      if (!Object.prototype.hasOwnProperty.call(d, en0)) continue;
      var k0 = norm(en0);
      if (k0 && !enDisplay[k0]) enDisplay[k0] = en0;
    }
    buildPreciseIndex();
    buildItemsIndex();
    /* v0.3.9：记录各索引条数，供诊断页展示 */
    DIAG.dict = Object.keys(d).length;
    DIAG.rev = Object.keys(revZh2En).length;
    DIAG.precise = Object.keys(preciseZh2En).length;
    DIAG.items = Object.keys(itemsZh2En).length;
    syncDiag();
  }

  /**
   * v0.3.7 物品词库索引：中文物品名 / 基底名 → 英文原文。
   * 用于官网「Item name / Item type」搜索框：用户输入中文时换算成英文原文再检索。
   * 键为官方数据原文，值为中文译名；这里反转为「中文 → 英文原文（保留原始大小写）」。
   */
  function buildItemsIndex() {
    itemsZh2En = Object.create(null);
    var it = window.PTC_ITEMS_ZH;
    if (!it || typeof it !== 'object') return;
    var put = function (en, zh) {
      if (typeof en !== 'string' || !en) return;
      if (typeof zh !== 'string' || !zh) return;
      var k = norm(zh);
      if (!k) return;
      if (!itemsZh2En[k]) itemsZh2En[k] = en;
      var ek = norm(en);
      if (ek && enDisplay && !enDisplay[ek]) enDisplay[ek] = en;   // v0.4.1：留存英文原文大小写
    };
    var fill = function (src) {
      if (!src || typeof src !== 'object') return;
      for (var en in src) {
        if (!Object.prototype.hasOwnProperty.call(src, en)) continue;
        put(en, src[en]);
      }
    };
    fill(it.type);
    fill(it.name);   // 专有名后写，同中文名时优先专有词条
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
      /* v0.4.1：留存英文原文（optionText 的英文键带官方大小写；枚举 id 原样留） */
      if (enDisplay && !enDisplay[e]) enDisplay[e] = en;
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

  /**
   * v0.3.9：中文键与查询串的匹配度（0 = 不匹配）。
   * 精确 > 前缀 > 子串（越靠前分越高）> 反向包含（用户多打了字）。
   * 长度差作为惩罚，保证「女王的饥饿」优先于「女王的饥饿·瓦尔法衣」这类长键。
   */
  function zhScore(key, q) {
    if (!key || !q) return 0;
    if (key === q) return 1000;
    var lenDiff = Math.min(200, Math.abs(key.length - q.length));
    if (key.indexOf(q) === 0) return 720 - lenDiff;
    var idx = key.indexOf(q);
    if (idx > 0) return 420 - lenDiff - Math.min(80, idx * 4);
    /* 反向包含（用户多打了字）：键至少 2 个字且多打字数有限，
       否则「完全不存在的名字」这类长串会被单字键（如「的」）误命中，产出垃圾候选 */
    var revOk = key.length >= 2 && (q.length - key.length) <= 6;
    if (!revOk) return 0;
    if (q.indexOf(key) === 0) return 260 - lenDiff;
    if (q.indexOf(key) > 0) return 160 - lenDiff;
    return 0;
  }

  /**
   * v0.3.9：中文查询 → 候选列表 [{ zh, en, score, src }]，支持精确 / 前缀 / 子串匹配，
   * 因此「女王的饥」这种不完整输入也能命中「女王的饥饿 → The Queen's Hunger」。
   * 优先级：物品名/基底名词库（英文保留官网原文大小写）> 筛选枚举精确库 > 通用词库。
   */
  function zhLookup(query, limit) {
    if (!revZh2En || !preciseZh2En || !itemsZh2En) buildIndex();
    var q = norm(query);
    if (!q) return [];
    var best = Object.create(null);   // 归一化英文 → 候选（同一英文取最高分那条）
    var consider = function (zhKey, en, bonus, src) {
      if (typeof en !== 'string' || !en) return;
      var s = zhScore(zhKey, q);
      if (!s) return;
      var k = norm(en);
      if (!k) return;
      var score = s + bonus;
      if (best[k] && best[k].score >= score) return;
      best[k] = { zh: zhKey, en: en, score: score, src: src };
    };
    var collect = function (map, bonus, src) {
      if (!map) return;
      for (var key in map) {
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
        var v = map[key];
        if (typeof v === 'string') consider(key, v, bonus, src);
        else if (Array.isArray(v)) {
          for (var i = 0; i < v.length; i++) consider(key, v[i], bonus, src);
        }
      }
    };
    collect(itemsZh2En, 60, 'item');
    collect(preciseZh2En, 30, 'filter');
    collect(revZh2En, 0, 'dict');
    var arr = [];
    for (var k2 in best) arr.push(best[k2]);
    arr.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      if (a.zh.length !== b.zh.length) return a.zh.length - b.zh.length;
      return a.en < b.en ? -1 : a.en > b.en ? 1 : 0;
    });
    return arr.slice(0, limit || 6);
  }

  /** 该英文值是否适合作为候选展示（过滤 explicit.stat_123 / ~price 这类机器标识） */
  function isDisplayableEn(en) {
    var s = String(en || '');
    if (!s) return false;
    if (/[~_]/.test(s)) return false;
    if (/^[a-z]+\./.test(s)) return false;
    if (/\d{4,}/.test(s)) return false;
    return /[a-z]/i.test(s);
  }

  /* --------------------------------------------------- v0.4.1 英文字面值 */ 

  /** 枚举 id 形态（turquoise-amulet / two_toned_boots）转成官网可见的英文文案 */
  function prettyEn(s) {
    return String(s || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * 归一化英文 → 用于展示与填入的英文原文。
   * 优先取词库里保留官方大小写的原始文案（如 "The Queen's Hunger"、"Turquoise Amulet"），
   * 拿不到时退化为把枚举 id 的空格化结果，保证任何能进候选的英文都能被官网原生过滤命中。
   */
  function displayEn(en) {
    if (!revZh2En) buildIndex();
    var k = norm(en);
    if (!k) return '';
    var d = enDisplay && enDisplay[k];
    if (d && !/[~_]/.test(d)) return d;
    return prettyEn(en);
  }

  /** 中文查询 → 英文词条候选（物品词库精确优先，其次筛选精确库，再次通用词库） */
  function zhToEn(query, limit) {
    if (!revZh2En || !preciseZh2En) buildIndex();
    var q = norm(query);
    var out = [];
    if (!q) return out;
    var seen = Object.create(null);
    var push = function (v) {
      if (typeof v !== 'string' || !v) return;
      var s = norm(v);
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(v);
    };
    /* 精确命中优先：物品名 / 基底名（官网 Item name / Item type 搜索框用它换算） */
    if (itemsZh2En && itemsZh2En[q]) push(itemsZh2En[q]);
    var precise = preciseZh2En[q];
    if (precise) { for (var pi = 0; pi < precise.length; pi++) push(precise[pi]); }
    if (revZh2En[q]) push(revZh2En[q]);
    /* v0.3.9：再补前缀 / 子串候选（不完整中文输入也能换算） */
    var cands = zhLookup(q, 8);
    for (var ci = 0; ci < cands.length; ci++) push(cands[ci].en);
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
      /* 输入法组合期间：完全交还站点原生匹配，不做任何跨语言补充，
         否则拼音串会被当成英文去匹配出多余候选，干扰候选列表。 */
      if (isAnyComposing()) {
        try {
          return typeof orig === 'function' ? !!orig.call(this, option, label, search) : false;
        } catch (e) {
          return false;
        }
      }
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
      DIAG.hooks += 1;
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
   * 注意：
   *  1) 搜索输入框自身的 class 往往就是 multiselect__input，会命中 [class*="multiselect"]，
   *     因此绝不能直接用 el.closest(MULTI_SEL)，否则容器会被误判为输入框本身。
   *  2) 从父节点向上时，最先遇到的多半是 multiselect__tags 这类子块（v0.3.5 的缺陷：
   *     候选列表渲染在兄弟节点 multiselect__content-wrapper 里，落在 tags 之外，
   *     导致 countOptions 恒为 0，明明已有候选也被判成「无结果」而去改写输入框）。
   *     故向上过程中优先返回 class 精确含 multiselect 组件根的节点，模糊匹配仅作兜底。
   */
  function searchRoot(el) {
    if (!el) return null;
    var node = el.parentElement;
    var fuzzy = null;
    var guard = 0;
    while (node && node.nodeType === 1 && guard++ < 12) {
      var cls = String(node.className || '');
      if (/(^|\s)multiselect(\s|$)/.test(cls)) return node;
      if (!fuzzy && /multiselect|select2|search-select/.test(cls)) fuzzy = node;
      node = node.parentElement;
    }
    return fuzzy || el.parentElement;
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
      if (target && target !== q) return hasCJK(q) ? displayEn(o.__ptcRaw || o.id || '') : target;
      s = hasCJK(q) ? zhToEn(q, 1)[0] : enToZh(q, 1)[0];
      if (s && s !== q) return hasCJK(q) ? displayEn(s) : s;
    }
    s = hasCJK(q) ? zhToEn(q, 1)[0] : enToZh(q, 1)[0];
    return s && s !== q ? (hasCJK(q) ? displayEn(s) : s) : null;
  }

  /* -------------------------------------------- 输入法（IME）组合输入守卫 */

  /**
   * 中文等输入法在「上屏」前会经历组合阶段，浏览器事件顺序为：
   *   compositionstart → (compositionupdate + input)* → compositionend → input
   * 组合期间的 input 事件里 el.value 是拼音 / 注音串（如 "qingyu"、"zitai"），
   * 并不是用户真正要输入的文本。v0.3.5 把它当作英文查询换算，会在用户还没选定
   * 候选词的瞬间改写输入框并自派 input 事件，直接打断输入法（截图现象）。
   *
   * v0.3.6 起组合期间一律不介入：
   *   - 不读取输入值做任何换算（filter 补丁也交还原生匹配）；
   *   - 不改写输入框 value、不写 data-ptc-query-zh / title；
   *   - 不主动派发任何 input 事件；
   *   - 取消组合开始前已排队的兜底改写定时器。
   * 只有 compositionend（字符真正上屏）之后，才继续走原有候选补充逻辑。
   */
  var composingCount = 0;          // 当前处于组合状态的输入框数量，>0 表示正在打拼音
  var lastCompositionEndAt = 0;    // 最近一次上屏时间，用于吸收个别内核的时序异常

  function isAnyComposing() {
    return composingCount > 0;
  }

  function markComposing(el, on) {
    if (!el || el.nodeType !== 1) return;
    var was = el.__ptcComposing === true;
    if (on) {
      if (was) return;
      try { el.__ptcComposing = true; } catch (e) { /* ignore */ }
      composingCount += 1;
    } else {
      if (was) {
        try { el.__ptcComposing = false; } catch (e) { /* ignore */ }
        composingCount = Math.max(0, composingCount - 1);
      }
    }
  }

  /** 该事件本身是否属于组合输入（含个别内核的 keyCode 229 兜底） */
  function isComposingEvent(e) {
    if (!e) return false;
    if (e.isComposing === true) return true;
    var it = String(e.inputType || '');
    if (it === 'insertCompositionText' || it === 'deleteCompositionText') return true;
    /* 注意：insertFromComposition / deleteByComposition 属于「上屏提交」，不算组合中 */
    if (e.keyCode === 229 || e.which === 229) return true;
    return false;
  }

  function stateOf(el) {
    return el.__ptcSearchState || (el.__ptcSearchState = { tried: [], timer: 0 });
  }

  function clearPendingTimer(el) {
    var st = el && el.__ptcSearchState;
    if (st && st.timer) {
      clearTimeout(st.timer);
      st.timer = 0;
    }
  }

  /**
   * 是否必须因「输入法组合中」而放行（即完全不介入）。
   * 兼容个别内核在 compositionend 之后仍把 isComposing 标成 true 的情况：
   * 若此刻值已含中日韩字符且刚上屏，则视为已上屏、允许后续候选补充。
   */
  function isComposingBlocked(el, e) {
    if (el && el.__ptcComposing === true) return true;
    if (composingCount > 0 && el && typeof document !== 'undefined' && document.activeElement === el) return true;
    if (isComposingEvent(e)) {
      var justEnded = lastCompositionEndAt && (Date.now() - lastCompositionEndAt) < 150;
      if (justEnded && el && hasCJK(String(el.value || ''))) return false;
      return true;
    }
    return false;
  }

  /**
   * 说明：不额外对「纯小写英文串」做拦截。
   * 组合期间由 isComposingBlocked 完全接管；万一组合事件缺失导致拼音串进入这里，
   * 拼音（如 qingyu、zitai）在词库里没有中文等价，equivalentQuery 会返回 null，
   * 同样不会改写输入框。反之若拦截所有纯小写串，会把 v0.3.5 的
   * 「英文零候选 → 换中文查询」能力（如 turquoise → 青玉护身符）一并废掉，故不做。
   */

  /* ------------------------------------------------ 组合阶段的事件处理 */

  function onCompositionStart(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    markComposing(el, true);
    clearPendingTimer(el);          // 组合前已排队的兜底改写必须取消
  }

  function onCompositionUpdate(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (el.__ptcComposing !== true) markComposing(el, true);   // 兜住缺失 compositionstart 的内核
    clearPendingTimer(el);
  }

  function onCompositionEnd(e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    markComposing(el, false);
    lastCompositionEndAt = Date.now();
    /* 上屏后：不主动派发 input（站点自身随后会触发一次），只安排一次候选补充检查；
       两条路径经 st.tried 去重，不会重复改写。 */
    schedulePostComposition(el);
  }

  function schedulePostComposition(el) {
    if (!isSearchInput(el)) return;
    var st = stateOf(el);
    clearPendingTimer(el);
    st.timer = setTimeout(function () {
      st.timer = 0;
      if (isAnyComposing() || el.__ptcComposing === true) return;   // 又回到组合状态则继续等待
      runFallback(el, String(el.value || ''));
    }, POST_COMPOSE_DELAY);
  }

  /* ------------------------------------- v0.4.1 主路径：中文输入镜像 */

  /**
   * 真正执行「输入镜像 / 兜底」的唯一入口。执行前后都复核组合状态，
   * 保证「组合中的任何时刻都不会有值被改写、有事件被派发」。
   *
   * v0.4.1 与旧实现的根本差别：不再用 countOptions() 读官网下拉有多少候选来决定要不要介入。
   * 旧实现「候选数 > 0 就直接返回」「候选数读不到就永不弹浮层」，在官网 React 重渲染或
   * 结构变化时会导致中文检索整条链路静默失效。现在只看两件事：
   *   ① 输入里有没有 CJK；② 词库能不能给出候选。与官网组件实例、下拉 DOM 结构完全无关。
   */
  function runFallback(el, q) {
    if (!q || !String(q).trim()) {   // 清空输入：收起浮层与中文提示
      if (suggest.el === el) hideSuggest();
      hideHint();
      return;
    }
    if (isAnyComposing() || el.__ptcComposing === true) return;
    /* 刚落点过浮层候选（框内已是英文原文）：短时间内不再介入，避免中英来回抖 */
    if (el.__ptcJustCommitted && (Date.now() - el.__ptcJustCommitted) < 1200) return;
    var st = stateOf(el);
    var val = String(q).trim();
    if (st.tried.indexOf(q) >= 0) return;

    /* 纯英文：零干预。不反查中文、不改写入参，只收起残留的中文浮层与提示 */
    if (!hasCJK(val)) {
      if (suggest.el === el) hideSuggest();
      hideHint();
      logMirror(val, 0, '', 'none', 'latin-passthrough');
      return;
    }

    /* 含 CJK：查词库（精确 / 前缀 / 子串 / 反向包含） */
    var items = suggestItems(val);
    recordLookup(val, items.length, items.length ? items[0].display : '');

    if (!items.length) {
      /* 词库没命中：先试「读当前下拉里官网自己给的选项」这条路（中文标签 → 英文原文），
         仍不中则如实记录未命中，不改写用户输入、不弹空浮层 */
      if (suggest.el === el) hideSuggest();
      var alt = null;
      try { alt = equivalentQuery(el, q); } catch (e0) { alt = null; }
      if (alt && !hasCJK(alt) && String(alt).trim() !== val) {
        mirrorInput(el, { fill: displayEn(alt) }, val, 'option');
        return;
      }
      logMirror(val, 0, '', 'none', 'no-dict-hit');
      return;
    }

    if (items.length === 1 && items[0].score >= MIRROR_AUTO_SCORE) {
      /* 唯一强匹配（精确 / 前缀 / 正向子串）：输入静止后直接把中文换算成英文填入，
         官网原生过滤随即命中；同时保证提交值恒为英文 */
      if (suggest.el === el) hideSuggest();
      logMirror(val, 1, items[0].display, 'auto-wait', 'unique-strong');
      scheduleMirror(el, items[0], val);
      return;
    }

    /* 多候选 / 唯一弱匹配：自绘浮层列「中文（English）」由用户点选，
       触发条件只看「含 CJK 且词库有匹配」，不依赖官网候选数量 */
    showSuggest(el, items, val);
    logMirror(val, items.length, items[0].display, 'layer', 'suggest-shown');
  }

  function onInput(e) {
    var el = e.target;
    if (!isSearchInput(el)) return;
    var st = stateOf(el);
    if (isComposingBlocked(el, e)) {
      /* 组合输入中：不接入、不改写、不派发，并取消已排队的改写与镜像 */
      clearPendingTimer(el);
      clearMirrorTimer(el);
      return;
    }
    var q = String(el.value || '');
    /* v0.4.1：新一轮输入开始，上一轮的中文提示条先收起（浮层按语言分别处理） */
    hideHint();
    /* 纯英文输入：明确留一条「直通、未改写」日志，避免用户以为桥接没工作；
       同一串连续输入只记一次，防止逐键刷屏把中文命中日志挤掉 */
    if (!hasCJK(q)) {
      var lastLog = DIAG.mirrorLog[DIAG.mirrorLog.length - 1];
      if (!lastLog || lastLog.input !== String(q).slice(0, 64) || lastLog.extra !== 'latin-passthrough') {
        logMirror(q, 0, '', 'none', 'latin-passthrough');
      }
    }
    /* 清空或改成纯英文时立刻收起自绘浮层（纯英文零干预，不误改） */
    if (!q.trim() || !hasCJK(q)) {
      if (suggest.el === el) hideSuggest();
    }
    clearMirrorTimer(el);   // 用户仍在打字，取消上一轮的延时镜像
    if (!q.trim()) return;
    if (st.tried.indexOf(q) >= 0) return;
    st.lastTypedAt = Date.now();
    clearPendingTimer(el);
    st.timer = setTimeout(function () {
      st.timer = 0;
      runFallback(el, q);
    }, INPUT_DELAY);
  }

  /* ------------------------------------ v0.3.9 自绘中文候选浮层（不依赖组件实例） */

  /**
   * 官网「Item name / Item type」这类输入框不是 multiselect 组件，站点用闭包内逻辑
   * 生成候选，patch 不到组件实例，因此零候选时只能在输入框下方自绘一层候选浮层：
   *   - 候选文本为「中文（English 原文）」，点击/回车后把输入框填成英文原文；
   *   - 派发 input + change 事件让站点用自己的逻辑检索（提交值仍是英文）；
   *   - 输入法组合期间绝不介入；纯英文输入绝不触发；不做任何半中半英改写。
   */
  var SUGGEST_ID = 'ptc-zh-suggest';
  var SUGGEST_LIMIT = 8;
  var suggest = { el: null, box: null, list: [], active: -1, query: '' };

  function suggestItems(query) {
    var raw = zhLookup(query, SUGGEST_LIMIT * 3);
    var out = [];
    var seenZh = Object.create(null);
    var seenFill = Object.create(null);
    for (var i = 0; i < raw.length && out.length < SUGGEST_LIMIT; i++) {
      var it = raw[i];
      if (!isDisplayableEn(it.en)) continue;
      if (seenZh[it.zh]) continue;
      /* v0.4.1：候选同时带「展示英文」与「填入英文」——两者都取官网可见的英文原文，
         保证选中后填进去的值一定被官网原生过滤命中（枚举 id 会先空格化） */
      var disp = displayEn(it.en);
      if (!disp || seenFill[norm(disp)]) continue;
      seenZh[it.zh] = 1;
      seenFill[norm(disp)] = 1;
      out.push({ zh: it.zh, en: it.en, display: disp, fill: disp, score: it.score, src: it.src });
    }
    return out;
  }

  function recordLookup(q, hits, en) {
    DIAG.lastQuery = q;
    DIAG.lastHits = hits;
    DIAG.lastEn = en || '';
    syncDiag();
  }

  /**
   * v0.4.1：逐次输入的可观测日志。
   * 记录「用户到底打了什么 / 有没有 CJK / 词库命中几条 / 最终替换成什么 / 走的哪条路径 /
   * 是否依赖官网组件实例」，写进 DIAG.mirrorLog 与 console，便于用户与售后自查，
   * 不需要开 DevTools 断点也能判断「是没命中词库还是桥接没跑」。
   */
  function logMirror(raw, hits, fill, mode, extra) {
    var row = {
      at: Date.now(),
      time: (function () {
        var dt = new Date();
        return (dt.getMonth() + 1) + '-' + dt.getDate() + ' ' +
          String(dt.getHours()).padStart(2, '0') + ':' +
          String(dt.getMinutes()).padStart(2, '0') + ':' +
          String(dt.getSeconds()).padStart(2, '0');
      })(),
      input: String(raw == null ? '' : raw).slice(0, 64),
      cjk: hasCJK(raw),
      hits: hits || 0,
      fill: String(fill || '').slice(0, 64),
      mode: mode || 'none',
      usedVm: false,          // 镜像链路恒不依赖组件实例
      extra: extra || ''
    };
    DIAG.mirrorLog.push(row);
    if (DIAG.mirrorLog.length > MIRROR_LOG_MAX) DIAG.mirrorLog.shift();
    /* 纯英文直通只是「记录我看到了英文、没有动它」，不覆盖最近一次真实换算的展示 */
    if (extra !== 'latin-passthrough') {
      DIAG.mirrorMode = row.mode;
      DIAG.lastMirror = row.fill ? (row.input + ' → ' + row.fill) : row.input;
    }
    if (typeof console !== 'undefined' && console.info) {
      console.info('[PTC v' + VERSION + '] mirror input="' + row.input + '"' +
        ' cjk=' + row.cjk + ' hits=' + row.hits +
        ' fill="' + row.fill + '" mode=' + row.mode + ' depsVm=false');
    }
    syncDiag();
    return row;
  }

  /* -------------------------------------------- v0.4.1 中文原文提示条 */ 

  /**
   * 输入框被镜像成英文后，用户会疑惑「我打的中文去哪了」。除了 data-ptc-query-zh 与 title，
   * 再在输入框下方挂一条不可交互的小提示：「中文检索：女王 → The Queen's Hunger」。
   * 只在镜像/浮层提交后短暂显示，任何新输入、失焦、滚动都会收起。
   */
  function hintBox() {
    var box = document.getElementById(HINT_ID);
    if (box) return box;
    box = document.createElement('div');
    box.id = HINT_ID;
    box.style.cssText =
      'position:absolute;z-index:2147483599;display:none;pointer-events:none;' +
      'box-sizing:border-box;padding:2px 8px;margin:0;max-width:420px;overflow:hidden;' +
      'white-space:nowrap;text-overflow:ellipsis;' +
      'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'color:#a9c0dd;background:rgba(20,22,26,.86);border:1px solid #3d434c;border-radius:3px;';
    (document.body || document.documentElement).appendChild(box);
    return box;
  }

  var hintTimer = 0;

  function hideHint() {
    if (hintTimer) {
      try { clearTimeout(hintTimer); } catch (e) { /* ignore */ }
      hintTimer = 0;
    }
    var box = document.getElementById(HINT_ID);
    if (box && box.style) box.style.display = 'none';
  }

  function showHint(el, zh, en) {
    if (!el || !zh) return;
    try {
      var box = hintBox();
      box.textContent = '中文检索：' + zh + ' → ' + en;
      var rect = el.getBoundingClientRect();
      var sx = window.pageXOffset || 0;
      var sy = window.pageYOffset || 0;
      box.style.left = Math.round(rect.left + sx) + 'px';
      box.style.top = Math.round(rect.bottom + sy + 2) + 'px';
      box.style.display = 'block';
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = setTimeout(function () {
        hintTimer = 0;
        var b = document.getElementById(HINT_ID);
        if (b && b.style) b.style.display = 'none';
      }, 3200);
    } catch (e) { /* 提示失败不影响检索 */ }
  }

  /* --------------------------------------- v0.4.1 输入镜像（不依赖组件实例） */

  function clearMirrorTimer(el) {
    var st = el && el.__ptcSearchState;
    if (st && st.mirrorTimer) {
      try { clearTimeout(st.mirrorTimer); } catch (e) { /* ignore */ }
      st.mirrorTimer = 0;
    }
  }

  /**
   * 执行一次「输入镜像」：把中文输入换成官网原生过滤能命中的英文串。
   * 这是 v0.4.1 的主路径，全程只看输入框自身与词库，不读下拉节点、不碰组件实例。
   */
  function mirrorInput(el, item, zh, mode) {
    if (!el || !item || !item.fill) {
      logMirror(zh, 0, '', 'none', 'no-fill');
      return false;
    }
    if (isAnyComposing() || el.__ptcComposing === true) return false;   // 组合期绝不改写
    var fill = String(item.fill);
    if (!fill || hasCJK(fill)) return false;                            // 替换值必须是英文
    var st = stateOf(el);
    if (st.tried.length >= MAX_TRIED) st.tried = [];
    st.tried.push(String(zh));
    st.tried.push(fill);
    try { el.__ptcJustMirrored = Date.now(); } catch (e) { /* ignore */ }
    setNativeValue(el, fill);
    try {
      el.setAttribute('data-ptc-query-zh', String(zh));   // 中文原文留痕（用户可见的中文提示）
      el.title = '中文检索：' + zh + ' → ' + fill;
    } catch (e2) { /* ignore */ }
    DIAG.mirrorCount += 1;
    logMirror(zh, 1, fill, mode || 'auto');
    hideSuggest();
    /* 派发事件让官网自己按英文重新过滤：下拉随即出现对应选项（提交值恒为英文） */
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    /* 事件会让 onInput 先收起浮层与提示，故提示条放在派发之后显示 */
    showHint(el, zh, fill);
    return true;
  }

  /** 唯一强匹配时的延时镜像：输入静止 MIRROR_DELAY 后再换算，避免打断连续中文输入 */
  function scheduleMirror(el, item, zh) {
    var st = stateOf(el);
    clearMirrorTimer(el);
    st.mirrorTimer = setTimeout(function () {
      st.mirrorTimer = 0;
      if (isAnyComposing() || el.__ptcComposing === true) return;
      if (document.activeElement && document.activeElement !== el && !el.isConnected) return;
      if (String(el.value || '') !== String(zh)) return;   // 期间用户又改了输入，放弃本次镜像
      mirrorInput(el, item, zh, 'auto');
    }, MIRROR_DELAY);
  }

  function suggestBox() {
    var box = document.getElementById(SUGGEST_ID);
    if (box) {
      suggest.box = box;
      return box;
    }
    box = document.createElement('div');
    box.id = SUGGEST_ID;
    box.setAttribute('role', 'listbox');
    box.style.cssText =
      'position:absolute;z-index:2147483600;display:none;box-sizing:border-box;' +
      'max-height:280px;overflow:auto;padding:4px 0;margin:0;' +
      'font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'color:#e7e7e7;background:#16181c;border:1px solid #4a4f57;border-radius:4px;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.45);text-align:left;';
    /* mousedown 拦默认行为：点候选时不让输入框先失焦，避免站点自己收起下拉 */
    box.addEventListener('mousedown', function (e) { e.preventDefault(); }, true);
    box.addEventListener('click', onSuggestClick, true);
    (document.body || document.documentElement).appendChild(box);
    suggest.box = box;
    return box;
  }

  function onSuggestClick(e) {
    var node = e.target;
    while (node && node !== suggest.box && !(node.getAttribute && node.getAttribute('data-ptc-idx') !== null)) {
      node = node.parentNode;
    }
    if (!node || !node.getAttribute) return;
    var idx = parseInt(node.getAttribute('data-ptc-idx'), 10);
    if (!(idx >= 0)) return;
    e.preventDefault();
    e.stopPropagation();
    commitSuggest(suggest.list[idx]);
  }

  function paintActive() {
    if (!suggest.box) return;
    var rows = suggest.box.childNodes;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.style) continue;
      r.style.background = i === suggest.active
        ? 'rgba(90,140,200,.28)'
        : (i === 0 ? 'rgba(90,140,200,.10)' : 'transparent');
    }
  }

  function renderSuggest(box, items) {
    box.textContent = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var row = document.createElement('div');
      row.setAttribute('data-ptc-idx', String(i));
      row.style.cssText = 'padding:5px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;';
      var zh = document.createElement('span');
      zh.textContent = it.zh;
      zh.style.cssText = 'color:#e7e7e7;';
      var en = document.createElement('span');
      /* v0.4.1：括号里显示「将被填入的英文原文」，与选中后框内值完全一致 */
      en.textContent = '（' + (it.display || it.en) + '）';
      en.style.cssText = 'color:#93a9c6;margin-left:1px;';
      row.appendChild(zh);
      row.appendChild(en);
      if (i === 0) {
        /* 首条是最可能的候选：左侧留一条高亮，用户一眼知道「先看这条」 */
        row.style.borderLeft = '2px solid #5a8cc8';
        row.style.background = 'rgba(90,140,200,.10)';
      }
      box.appendChild(row);
    }
  }

  function positionSuggest(el, box) {
    var rect = el.getBoundingClientRect();
    var sx = window.pageXOffset || 0;
    var sy = window.pageYOffset || 0;
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var width = Math.max(rect.width || 0, 280);
    var left = rect.left + sx;
    var maxLeft = sx + vw - width - 8;
    if (left > maxLeft) left = Math.max(4, maxLeft);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(rect.bottom + sy + 2) + 'px';
    box.style.width = Math.round(width) + 'px';
  }

  function showSuggest(el, items, q) {
    if (!el || !items || !items.length) {
      hideSuggest();
      return false;
    }
    var box = suggestBox();
    renderSuggest(box, items);
    positionSuggest(el, box);
    box.style.display = 'block';
    suggest.el = el;
    suggest.list = items;
    /* active 保持 -1：不预设选中项，避免用户按回车（非方向键）时误选错候选；
       高亮交给 renderSuggest 的首条「推荐」标记 */
    suggest.active = -1;
    suggest.query = q;
    DIAG.suggestShown += 1;
    recordLookup(q, items.length, items[0].display || items[0].en);
    return true;
  }

  function hideSuggest() {
    if (suggest.box && suggest.box.style) suggest.box.style.display = 'none';
    suggest.el = null;
    suggest.list = [];
    suggest.active = -1;
    suggest.query = '';
  }

  /** 选中候选：填入英文原文 + 派发 input / change（提交值始终是英文原文） */
  function commitSuggest(item) {
    var el = suggest.el;
    if (!el || !item || (!item.fill && !item.en)) {
      hideSuggest();
      return false;
    }
    /* 组合期间绝不改写（用户可能正在打下一个字） */
    if (isAnyComposing() || el.__ptcComposing === true) return false;
    /* v0.4.1：填入的是「候选括号里显示的那个英文原文」，保证与官网原生过滤口径一致 */
    var en = String(item.fill || displayEn(item.en) || item.en);
    var st = stateOf(el);
    if (st.tried.length >= MAX_TRIED) st.tried = [];
    st.tried.push(item.zh);
    st.tried.push(en);            // 记入 tried：避免随后的镜像逻辑把它又换回中文
    try { el.__ptcJustCommitted = Date.now(); } catch (e) { /* ignore */ }
    setNativeValue(el, en);
    try { el.setAttribute('data-ptc-query-zh', item.zh); } catch (e2) { /* ignore */ }
    try { el.title = '中文检索：' + item.zh + ' → ' + en; } catch (e3) { /* ignore */ }
    DIAG.lastCommit = item.zh + ' → ' + en;
    DIAG.mirrorCount += 1;
    logMirror(item.zh, suggest.list.length, en, 'layer', 'commit');
    hideSuggest();
    syncDiag();
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    showHint(el, item.zh, en);   // 框内已是英文，用小提示条告诉用户中文去哪了
    return true;
  }

  function moveActive(step) {
    if (!suggest.list.length) return;
    var n = suggest.list.length;
    suggest.active = (suggest.active + step + n) % n;
    paintActive();
  }

  function onSuggestKeydown(e) {
    if (!suggest.list.length || !suggest.el) return;
    if (document.activeElement !== suggest.el) return;
    var k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      moveActive(k === 'ArrowDown' ? 1 : -1);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (k === 'Enter') {
      if (suggest.active >= 0) {
        e.preventDefault();
        e.stopPropagation();
        commitSuggest(suggest.list[suggest.active]);
      }
      return;
    }
    if (k === 'Escape') {
      hideSuggest();
      return;
    }
    if (k === 'Tab') hideSuggest();
  }

  function onSuggestOutside(e) {
    if (!suggest.list.length) return;
    var t = e.target;
    if (t === suggest.el) return;
    if (suggest.box && (t === suggest.box || (suggest.box.contains && suggest.box.contains(t)))) return;
    hideSuggest();
  }

  /** 页面 / 容器滚动时浮层会错位，直接收起（浮层内部滚动除外） */
  function onSuggestScroll(e) {
    if (suggest.box && e && e.target === suggest.box) return;
    hideHint();   // 提示条绝对定位，滚动后必然错位，直接收起
    if (!suggest.list.length) return;
    hideSuggest();
  }

  /** 输入框失焦后收起（点击候选已用 mousedown preventDefault 保住焦点） */
  /** 窗口尺寸变化：绝对定位的浮层与提示条一起收起，避免错位 */
  function onSuggestResize() {
    hideHint();
    hideSuggest();
  }

  function onSuggestBlur(e) {
    if (!suggest.list.length) return;
    if (e && e.target !== suggest.el) return;
    setTimeout(function () {
      if (!suggest.list.length) return;
      var active = document.activeElement;
      if (active && suggest.box && (active === suggest.box || suggest.box.contains(active))) return;
      if (active && active === suggest.el) return;
      hideHint();
      hideSuggest();
    }, 140);
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
    if (BRIDGE.installed) return;
    buildIndex();
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
    /* 输入法组合状态必须用捕获阶段第一时间记录，晚于站点自身处理会误判 */
    document.addEventListener('compositionstart', onCompositionStart, true);
    document.addEventListener('compositionupdate', onCompositionUpdate, true);
    document.addEventListener('compositionend', onCompositionEnd, true);
    /* v0.3.9：自绘中文候选浮层的键盘 / 收起行为（不含输入法组合期任何介入） */
    document.addEventListener('keydown', onSuggestKeydown, true);
    document.addEventListener('mousedown', onSuggestOutside, true);
    document.addEventListener('focusout', onSuggestBlur, true);
    window.addEventListener('scroll', onSuggestScroll, true);
    window.addEventListener('resize', onSuggestResize, true);
    observer = new MutationObserver(function () {
      patchAll(document);
    });
    try {
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {
      /* ignore */
    }
    BRIDGE.installed = true;
    BRIDGE.started = true;
    BRIDGE.abortReason = '';
    DIAG.started = true;
    DIAG.installed = true;
    DIAG.abortReason = '';
    patchAll(document);
    syncDiag();
  }

  /** v0.4.0：挑战接管时把监听与观察器全部撤掉（不动任何 option 数据） */
  function uninstall(reason) {
    if (!BRIDGE.installed) return;
    BRIDGE.installed = false;
    BRIDGE.abortReason = reason || 'challenge';
    DIAG.installed = false;
    DIAG.abortReason = BRIDGE.abortReason;
    try {
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onInput, true);
      document.removeEventListener('compositionstart', onCompositionStart, true);
      document.removeEventListener('compositionupdate', onCompositionUpdate, true);
      document.removeEventListener('compositionend', onCompositionEnd, true);
      document.removeEventListener('keydown', onSuggestKeydown, true);
      document.removeEventListener('mousedown', onSuggestOutside, true);
      document.removeEventListener('focusout', onSuggestBlur, true);
      window.removeEventListener('scroll', onSuggestScroll, true);
      window.removeEventListener('resize', onSuggestResize, true);
    } catch (e) { /* ignore */ }
    try {
      if (observer) observer.disconnect();
    } catch (e) { /* ignore */ }
    observer = null;
    try {
      hideSuggest();
    } catch (e) { /* ignore */ }
    syncDiag();
  }

  function installLater() {
    if (!BRIDGE.installed) return;
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
    /* v0.3.9：中文前缀 / 子串候选查询与自绘浮层（供自测与诊断使用） */
    zhLookup: zhLookup,
    suggestItems: suggestItems,
    showSuggest: showSuggest,
    hideSuggest: hideSuggest,
    commitSuggest: commitSuggest,
    /* v0.4.1：输入镜像主路径（全部不依赖官网组件实例），供自测与问题自查使用 */
    mirrorInput: mirrorInput,
    scheduleMirror: scheduleMirror,
    runFallback: runFallback,
    showHint: showHint,
    hideHint: hideHint,
    displayEn: displayEn,
    getMirrorLog: function () {
      return DIAG.mirrorLog.slice(0);
    },
    getDiag: diagSnapshot,
    getStatus: function () {
      return {
        version: VERSION,
        started: BRIDGE.started,
        installed: BRIDGE.installed,
        abortReason: BRIDGE.abortReason,
        hooks: DIAG.hooks,
        challenge: { takeover: isChallengeTakeover(), signals: challengeSignals(), hasAppRoot: hasAppRoot() }
      };
    },
    boot: boot,
    syncDiag: syncDiag,
    rebuildIndex: rebuildIndex,
    countOptions: countOptions,
    /* IME 组合状态探针（供自测与调试使用，不参与业务逻辑） */
    isComposing: function (el) {
      if (isAnyComposing()) return true;
      return !!(el && el.__ptcComposing === true);
    }
  };

  function scheduleGuard(delay) {
    if (BRIDGE.guardTimer) return;
    try {
      BRIDGE.guardTimer = setTimeout(guardTick, typeof delay === 'number' ? delay : BRIDGE.delay);
    } catch (e) {
      BRIDGE.guardTimer = null;
    }
  }

  /**
   * 常驻巡检（先密后疏，无次数上限）：挑战接管即卸载，挑战消失即重新挂载。
   * v0.3.8 的「一次判定即永久 return」正是本次故障根因，故不再使用一次性开关。
   */
  function guardTick() {
    BRIDGE.guardTimer = null;
    try {
      /* v0.4.0：不再用「是否交易页路径」作门槛（manifest 已限定注入范围），只在真挑战页卸载 */
      if (isChallengeTakeover()) {
        BRIDGE.abortReason = 'challenge';
        if (BRIDGE.installed) uninstall('challenge');
      } else if (!BRIDGE.installed) {
        install();
      }
    } catch (e) {
      /* 巡检异常不得影响页面 */
    }
    BRIDGE.ticks += 1;
    BRIDGE.delay = BRIDGE.ticks <= 40 ? 250 : 1000;
    publishStatus();
    scheduleGuard();
  }

  /** 启动：非交易页直接不启动；挑战页不挂载但保留巡检 */
  function boot() {
    try {
      if (isChallengeTakeover()) {
        BRIDGE.abortReason = 'challenge';
        publishStatus();
        scheduleGuard();
        return;
      }
      install();
      publishStatus();
      scheduleGuard();
    } catch (e) {
      try {
        publishStatus();
      } catch (e2) { /* ignore */ }
    }
  }

  boot();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installLater, { once: true });
  }
  window.addEventListener('load', installLater, { once: true });
})();
