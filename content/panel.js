/**
 * content/panel.js — UI 层（Shadow DOM 隔离）
 * 右侧可拖拽抽屉 + 浮动球，三个 Tab：价格分析 / 快速估价 / 收藏追踪。
 * 与页面样式完全隔离：所有节点都挂在 #ptc-companion-root 的 shadow root 内。
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});
  const bus = (PTC.bus = PTC.bus || new EventTarget());
  const PU = PTC.PriceUtils;

  const VERSION = '0.1.0';
  const WATCH_KEY = 'watchlist';
  const BALL_POS_KEY = 'ptc_ball_pos';

  const ui = {
    host: null,
    shadow: null,
    wrap: null,
    els: {},
    open: false,
    tab: 'price',
    toastTimer: null,
    batchRunning: false
  };

  const data = {
    league: 'Standard',
    rate: PU.FALLBACK_DIVINE,
    rateSource: 'fallback',
    entries: [],
    stats: null,
    total: 0,
    searchId: null,
    settings: {}
  };

  /* ------------------------------------------------------------ 模板 */

  const TEMPLATE = `
<button class="ptc-ball" id="ptcBall" title="PoE Trade Companion（快捷键打开）" aria-label="打开增强面板">
  <span class="ptc-ball-mark">P</span>
</button>

<aside class="ptc-panel" id="ptcPanel" aria-hidden="true">
  <header class="ptc-head">
    <div class="ptc-brand">
      <span class="ptc-logo">P</span>
      <div class="ptc-brand-text">
        <div class="ptc-title">Trade Companion</div>
        <div class="ptc-sub" id="ptcLeague">—</div>
      </div>
    </div>
    <div class="ptc-head-actions">
      <button class="ptc-icon-btn" id="ptcRefresh" title="刷新汇率与统计">⟳</button>
      <button class="ptc-icon-btn" id="ptcClose" title="关闭面板">✕</button>
    </div>
  </header>

  <div class="ptc-notice" id="ptcNotice" hidden></div>

  <nav class="ptc-tabs" id="ptcTabs">
    <button class="ptc-tab is-active" data-tab="price">价格分析</button>
    <button class="ptc-tab" data-tab="estimate">快速估价</button>
    <button class="ptc-tab" data-tab="watch">收藏追踪</button>
  </nav>

  <div class="ptc-body">
    <section class="ptc-pane" data-pane="price">
      <div class="ptc-stats">
        <div class="ptc-stat"><span class="ptc-k">条数</span><span class="ptc-v" id="ptcStatCount">—</span></div>
        <div class="ptc-stat"><span class="ptc-k">最低价</span><span class="ptc-v" id="ptcStatMin">—</span></div>
        <div class="ptc-stat"><span class="ptc-k">中位数</span><span class="ptc-v" id="ptcStatMedian">—</span></div>
        <div class="ptc-stat"><span class="ptc-k">P25</span><span class="ptc-v" id="ptcStatP25">—</span></div>
        <div class="ptc-stat"><span class="ptc-k">P75</span><span class="ptc-v" id="ptcStatP75">—</span></div>
      </div>
      <div class="ptc-toolbar">
        <button class="ptc-btn ptc-btn-primary" id="ptcBatch">批量估价当前结果</button>
        <span class="ptc-hint" id="ptcBatchHint">最多 200 条</span>
      </div>
      <div class="ptc-progress" id="ptcProgress" hidden><div class="ptc-progress-bar" id="ptcProgressBar"></div></div>
      <ul class="ptc-list" id="ptcPriceList"></ul>
      <div class="ptc-empty" id="ptcPriceEmpty">发起一次市集搜索后，这里会列出售价分布。</div>
    </section>

    <section class="ptc-pane" data-pane="estimate" hidden>
      <textarea class="ptc-textarea" id="ptcEstText" spellcheck="false"
        placeholder="在游戏内把鼠标移到物品上按 Ctrl+C，然后粘贴到这里……"></textarea>
      <div class="ptc-parse" id="ptcEstParse">尚未解析</div>
      <div class="ptc-toolbar">
        <button class="ptc-btn ptc-btn-primary" id="ptcEstimate">估价</button>
        <button class="ptc-btn" id="ptcEstClear">清空</button>
      </div>
      <div class="ptc-est-result" id="ptcEstResult"></div>
    </section>

    <section class="ptc-pane" data-pane="watch" hidden>
      <div class="ptc-toolbar">
        <button class="ptc-btn ptc-btn-primary" id="ptcWatchCheck">立即检查</button>
        <button class="ptc-btn ptc-btn-danger" id="ptcWatchClear">清空全部</button>
        <span class="ptc-hint" id="ptcWatchHint">降价提醒阈值 —</span>
      </div>
      <ul class="ptc-list" id="ptcWatchList"></ul>
      <div class="ptc-empty" id="ptcWatchEmpty">暂无收藏。在「价格分析」列表点 ☆ 即可收藏并追踪降价。</div>
    </section>
  </div>

  <footer class="ptc-foot">
    <span class="ptc-status" id="ptcStatus">就绪</span>
    <span class="ptc-version">v${VERSION}</span>
  </footer>
</aside>

<div class="ptc-toast" id="ptcToast" hidden></div>
`;

  /* ------------------------------------------------------------ 构建 */

  function build() {
    if (ui.host) return;

    const host = document.createElement('div');
    host.id = 'ptc-companion-root';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483000;';
    (document.documentElement || document.body).appendChild(host);

    const shadow = host.attachShadow({ mode: 'open' });

    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('content/style.css');
      shadow.appendChild(link);
    } catch (e) {
      /* 样式表加载失败时仍保留基本可用性（内联关键样式兜底） */
    }

    const wrap = document.createElement('div');
    wrap.className = 'ptc-scope';
    wrap.innerHTML = TEMPLATE;
    shadow.appendChild(wrap);

    ui.host = host;
    ui.shadow = shadow;
    ui.wrap = wrap;

    const id = (name) => wrap.querySelector('#' + name);
    ui.els = {
      ball: id('ptcBall'),
      panel: id('ptcPanel'),
      league: id('ptcLeague'),
      notice: id('ptcNotice'),
      tabs: id('ptcTabs'),
      refresh: id('ptcRefresh'),
      close: id('ptcClose'),
      statCount: id('ptcStatCount'),
      statMin: id('ptcStatMin'),
      statMedian: id('ptcStatMedian'),
      statP25: id('ptcStatP25'),
      statP75: id('ptcStatP75'),
      batch: id('ptcBatch'),
      batchHint: id('ptcBatchHint'),
      progress: id('ptcProgress'),
      progressBar: id('ptcProgressBar'),
      priceList: id('ptcPriceList'),
      priceEmpty: id('ptcPriceEmpty'),
      estText: id('ptcEstText'),
      estParse: id('ptcEstParse'),
      estimate: id('ptcEstimate'),
      estClear: id('ptcEstClear'),
      estResult: id('ptcEstResult'),
      watchCheck: id('ptcWatchCheck'),
      watchClear: id('ptcWatchClear'),
      watchHint: id('ptcWatchHint'),
      watchList: id('ptcWatchList'),
      watchEmpty: id('ptcWatchEmpty'),
      status: id('ptcStatus'),
      toast: id('ptcToast')
    };

    ui.els.league.textContent = data.league;
  }

  /* ------------------------------------------------------------ 工具 */

  function status(text) {
    if (ui.els.status) ui.els.status.textContent = text;
  }

  function toast(message) {
    const box = ui.els.toast;
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
    box.classList.add('is-visible');
    if (ui.toastTimer) clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      box.classList.remove('is-visible');
      box.hidden = true;
    }, 2200);
  }

  function showNotice(message, level) {
    const box = ui.els.notice;
    if (!box) return;
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.textContent = message;
    box.className = 'ptc-notice' + (level === 'warn' ? ' is-warn' : '');
  }

  function copyText(text) {
    const value = String(text || '');
    if (!value) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
        return true;
      }
    } catch (e) {
      /* 走兜底 */
    }
    return fallbackCopy(value);
  }

  function fallbackCopy(value) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      (ui.shadow || document.body).appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      toast('复制失败，请手动选择文本');
      return false;
    }
  }

  function whisperOf(entry) {
    if (entry && entry.whisper) return entry.whisper;
    if (!entry) return '';
    const price = entry.amount != null ? entry.amount + ' ' + (entry.currency || 'chaos') : 'your listed price';
    return (
      '@' + (entry.seller || 'seller') + ' Hi, I would like to buy your ' + entry.name +
      ' listed for ' + price + ' in ' + data.league + '.'
    );
  }

  function fmtPrice(entry) {
    if (!entry) return '—';
    if (entry.amount == null) return '议价';
    const currencyLabel = entry.currency === 'chaos' ? 'c' : entry.currency === 'divine' ? 'div' : entry.currency || '';
    return entry.amount + ' ' + currencyLabel;
  }

  function fmtIndexed(iso) {
    if (!iso) return '';
    try {
      const t = new Date(iso).getTime();
      if (!isFinite(t)) return '';
      const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
      if (mins < 60) return mins + ' 分钟前';
      const hours = Math.round(mins / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.round(hours / 24) + ' 天前';
    } catch (e) {
      return '';
    }
  }

  /* ------------------------------------------------------------ 渲染：价格分析 */

  function setStatNode(node, text) {
    if (node) node.textContent = text;
  }

  function renderStats() {
    const st = data.stats;
    const count = data.total || (st ? st.count : 0);
    setStatNode(ui.els.statCount, count ? String(count) : '—');
    setStatNode(ui.els.statMin, st && st.count ? PU.formatChaos(st.min, data.rate) : '—');
    setStatNode(ui.els.statMedian, st && st.count ? PU.formatChaos(st.median, data.rate) : '—');
    setStatNode(ui.els.statP25, st && st.count ? PU.formatChaos(st.p25, data.rate) : '—');
    setStatNode(ui.els.statP75, st && st.count ? PU.formatChaos(st.p75, data.rate) : '—');
    if (ui.els.batchHint) {
      ui.els.batchHint.textContent = data.rateSource === 'fallback' ? '汇率为估算' : '最多 200 条';
    }
  }

  function renderPriceList() {
    const list = ui.els.priceList;
    if (!list) return;
    list.innerHTML = '';

    if (!data.entries.length) {
      if (ui.els.priceEmpty) ui.els.priceEmpty.hidden = false;
      return;
    }
    if (ui.els.priceEmpty) ui.els.priceEmpty.hidden = true;

    const median = data.stats && data.stats.median ? data.stats.median : 0;
    const frag = document.createDocumentFragment();

    data.entries.forEach((entry, index) => {
      const li = document.createElement('li');
      li.className = 'ptc-row';
      li.dataset.index = String(index);

      const delta = median ? PU.deltaPercent(entry.chaos, median) : null;
      const deltaClass = delta != null && delta >= 20 ? 'is-good' : delta != null && delta <= -20 ? 'is-bad' : '';
      const deltaText = delta == null ? '' : (delta > 0 ? '−' : '+') + Math.abs(delta).toFixed(0) + '%';

      li.innerHTML =
        '<div class="ptc-row-main">' +
        '<div class="ptc-row-title" title="' + escapeHtml(entry.name) + '">' + escapeHtml(entry.name) + '</div>' +
        '<div class="ptc-row-meta">' + escapeHtml(entry.seller || '未知卖家') +
        (entry.indexed ? ' · ' + escapeHtml(fmtIndexed(entry.indexed)) : '') + '</div>' +
        '</div>' +
        '<div class="ptc-row-right">' +
        '<span class="ptc-price">' + escapeHtml(fmtPrice(entry)) + '</span>' +
        '<span class="ptc-delta ' + deltaClass + '">' + deltaText + '</span>' +
        '</div>' +
        '<button class="ptc-star" title="收藏并追踪降价">☆</button>';

      li.addEventListener('click', (ev) => {
        const target = ev.target;
        if (target && target.classList && target.classList.contains('ptc-star')) {
          ev.stopPropagation();
          addToWatch(entry).catch(() => toast('收藏失败'));
          return;
        }
        const ok = copyText(whisperOf(entry));
        toast(ok ? '已复制私聊文本' : '复制失败');
        status('已复制：' + entry.name);
      });

      frag.appendChild(li);
    });

    list.appendChild(frag);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ------------------------------------------------------------ 渲染：收藏 */

  async function readWatchlist() {
    try {
      const got = await chrome.storage.local.get(WATCH_KEY);
      const list = got && got[WATCH_KEY];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  async function writeWatchlist(list) {
    try {
      await chrome.storage.local.set({ [WATCH_KEY]: list });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function addToWatch(entry) {
    if (!entry || !entry.id) {
      toast('缺少物品标识，无法收藏');
      return;
    }
    const list = await readWatchlist();
    if (list.some((it) => it.id === entry.id)) {
      toast('已在收藏中');
      return;
    }
    list.unshift({
      id: entry.id,
      name: entry.name,
      baseType: entry.baseType || null,
      seller: entry.seller || null,
      savedPrice: entry.chaos || null,
      currentPrice: entry.chaos || null,
      amount: entry.amount != null ? entry.amount : null,
      currency: entry.currency || null,
      savedQueryId: data.searchId || (PTC.state && PTC.state.searchId) || null,
      league: data.league,
      addedAt: Date.now(),
      lastChecked: null,
      lowest: entry.chaos || null
    });
    await writeWatchlist(list);
    toast('已收藏：' + entry.name);
    renderWatch();
  }

  async function renderWatch() {
    const list = ui.els.watchList;
    if (!list) return;
    const items = await readWatchlist();
    list.innerHTML = '';

    if (ui.els.watchHint) {
      const threshold = Number(data.settings && data.settings.alertThreshold);
      ui.els.watchHint.textContent = '降价提醒阈值 ' + (isFinite(threshold) ? threshold : 10) + '%';
    }

    if (!items.length) {
      if (ui.els.watchEmpty) ui.els.watchEmpty.hidden = false;
      return;
    }
    if (ui.els.watchEmpty) ui.els.watchEmpty.hidden = true;

    const frag = document.createDocumentFragment();
    items.forEach((item) => {
      const saved = Number(item.savedPrice);
      const current = Number(item.currentPrice);
      let changeText = '—';
      let cls = '';
      if (saved > 0 && current > 0) {
        const pct = ((current - saved) / saved) * 100;
        changeText = (pct > 0 ? '+' : '') + pct.toFixed(0) + '%';
        cls = pct <= -10 ? 'is-good' : pct >= 10 ? 'is-bad' : '';
      }

      const li = document.createElement('li');
      li.className = 'ptc-row';
      li.innerHTML =
        '<div class="ptc-row-main">' +
        '<div class="ptc-row-title">' + escapeHtml(item.name || '未知物品') + '</div>' +
        '<div class="ptc-row-meta">收藏 ' + PU.formatChaos(saved, data.rate) +
        ' · 现价 ' + PU.formatChaos(current, data.rate) +
        (item.lastChecked ? ' · ' + escapeHtml(fmtIndexed(new Date(item.lastChecked).toISOString())) : '') +
        '</div>' +
        '</div>' +
        '<div class="ptc-row-right"><span class="ptc-delta ' + cls + '">' + changeText + '</span></div>' +
        '<button class="ptc-remove" title="删除收藏">✕</button>';

      li.addEventListener('click', async (ev) => {
        const target = ev.target;
        if (target && target.classList && target.classList.contains('ptc-remove')) {
          ev.stopPropagation();
          const rest = (await readWatchlist()).filter((it) => it.id !== item.id);
          await writeWatchlist(rest);
          toast('已删除收藏');
          renderWatch();
          return;
        }
        const ok = copyText(item.whisper || '');
        if (ok) toast('已复制私聊文本');
        else toast('该条目暂无私聊文本');
      });

      frag.appendChild(li);
    });
    list.appendChild(frag);
  }

  async function clearWatchlist() {
    try {
      const ok = window.confirm('确定清空全部收藏？该操作只影响插件本地收藏，不会影响市集页面。');
      if (!ok) return;
      await writeWatchlist([]);
      toast('已清空收藏');
      renderWatch();
    } catch (e) {
      /* ignore */
    }
  }

  async function checkWatchlist() {
    if (ui.els.watchCheck) ui.els.watchCheck.disabled = true;
    status('正在检查收藏价格…');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ptc:check-watchlist' });
      if (res && res.ok) {
        toast('已检查 ' + (res.checked || 0) + ' 条，降价 ' + (res.alerts || 0) + ' 条');
      } else {
        toast('检查失败：' + ((res && res.error) || '网络异常'));
      }
    } catch (e) {
      toast('检查失败，请稍后重试');
    } finally {
      if (ui.els.watchCheck) ui.els.watchCheck.disabled = false;
      renderWatch();
      status('就绪');
    }
  }

  /* ------------------------------------------------------------ 估价 */

  function apiPaths() {
    const st = PTC.state;
    return (st && st.api) || { searchPath: '/api/trade/search/', fetchPath: '/api/trade/fetch/' };
  }

  function setEstResult(html) {
    if (ui.els.estResult) ui.els.estResult.innerHTML = html;
  }

  async function doEstimate() {
    const text = ui.els.estText ? ui.els.estText.value.trim() : '';
    if (!text) {
      setEstResult('<div class="ptc-msg is-warn">请先粘贴物品文本</div>');
      return;
    }
    if (ui.els.estimate) ui.els.estimate.disabled = true;
    setEstResult('<div class="ptc-msg">估价中…</div>');
    status('估价中…');

    try {
      const res = await PTC.Estimator.estimateFromText(text, {
        league: data.league,
        api: apiPaths(),
        divineRate: data.rate,
        sampleSize: 20,
        onStage: (m) => setEstResult('<div class="ptc-msg">' + escapeHtml(m) + '</div>')
      });

      if (!res.ok) {
        setEstResult('<div class="ptc-msg is-warn">' + escapeHtml(res.error || '估价失败') + '</div>');
        status('估价失败');
        return;
      }

      const parsed = res.parsed || {};
      setEstResult(
        '<div class="ptc-est-head">' + escapeHtml(parsed.name || '未识别物品') + '</div>' +
        '<div class="ptc-est-meta">' + escapeHtml(parsed.baseType || '') +
        (parsed.rarity ? ' · ' + escapeHtml(parsed.rarity) : '') +
        (parsed.itemLevel != null ? ' · iLv ' + parsed.itemLevel : '') + '</div>' +
        renderEstimateBody(res)
      );
      status('估价完成');
    } catch (err) {
      setEstResult('<div class="ptc-msg is-warn">估价失败：' + escapeHtml((err && err.message) || '未知错误') + '</div>');
      status('估价失败');
    } finally {
      if (ui.els.estimate) ui.els.estimate.disabled = false;
    }
  }

  function renderEstimateBody(res) {
    if (!res || !res.stats || !res.stats.count) {
      return '<div class="ptc-msg is-warn">' + escapeHtml((res && res.message) || '未取到有效挂单价格') + '</div>';
    }
    const st = res.stats;
    return (
      '<div class="ptc-stats ptc-stats-compact">' +
      '<div class="ptc-stat"><span class="ptc-k">样本</span><span class="ptc-v">' + st.count + '</span></div>' +
      '<div class="ptc-stat"><span class="ptc-k">价格区间</span><span class="ptc-v">' +
      PU.formatChaos(st.min, data.rate) + ' – ' + PU.formatChaos(st.max, data.rate) + '</span></div>' +
      '<div class="ptc-stat"><span class="ptc-k">建议售价</span><span class="ptc-v is-accent">' +
      PU.formatChaos(res.suggested, data.rate) + '</span></div>' +
      '</div>' +
      '<div class="ptc-note">中位数 ' + PU.formatChaos(st.median, data.rate) +
      '，主要成交带 ' + PU.formatChaos(st.p25, data.rate) + ' – ' + PU.formatChaos(st.p75, data.rate) +
      '；页面标价 ' + (res.total || 0) + ' 条，采样 ' + (res.sampled || 0) +
      ' 条；已剔除 >3× 中位数离群点' + (st.filtered ? '（剔除 ' + st.filtered + ' 条）' : '') + '。</div>'
    );
  }

  async function doBatch() {
    if (ui.batchRunning) return;
    const st = PTC.state;
    const searchId = (st && st.searchId) || data.searchId;
    const ids = (st && st.searchIds) || [];

    if (!searchId || !ids.length) {
      toast('暂无可估价的结果，请先执行一次市集搜索');
      return;
    }

    ui.batchRunning = true;
    if (ui.els.batch) ui.els.batch.disabled = true;
    if (ui.els.progress) ui.els.progress.hidden = false;
    if (ui.els.progressBar) ui.els.progressBar.style.width = '0%';
    status('批量估价中…');

    try {
      const res = await PTC.Estimator.estimateAll({
        searchId,
        ids,
        league: data.league,
        api: apiPaths(),
        divineRate: data.rate,
        onProgress: (p) => {
          if (ui.els.progressBar) ui.els.progressBar.style.width = p.percent + '%';
          status('批量估价 ' + p.done + '/' + p.total);
        }
      });

      if (!res.ok) {
        toast(res.error || '批量估价失败');
        return;
      }

      // 合并新条目（按 id 去重），并刷新统计
      const map = new Map();
      data.entries.forEach((e) => e.id && map.set(e.id, e));
      (res.entries || []).forEach((e) => {
        if (e.id && !map.has(e.id)) map.set(e.id, e);
      });
      data.entries = Array.from(map.values());
      if (res.stats && res.stats.count) {
        data.stats = res.stats;
        data.total = Math.max(data.total, res.count || 0);
      }
      renderStats();
      renderPriceList();
      if (ui.els.batchHint) {
        ui.els.batchHint.textContent = '已估价 ' + (res.count || 0) + ' 条 · 建议 ' + PU.formatChaos(res.suggested, data.rate);
      }
      toast('批量估价完成，共 ' + (res.count || 0) + ' 条');
      status('批量估价完成');
    } catch (err) {
      toast('批量估价失败：' + ((err && err.message) || '网络异常'));
      status('批量估价失败');
    } finally {
      ui.batchRunning = false;
      if (ui.els.batch) ui.els.batch.disabled = false;
      setTimeout(() => {
        if (ui.els.progress) ui.els.progress.hidden = true;
      }, 600);
    }
  }

  /* ------------------------------------------------------------ 交互绑定 */

  function setTab(tab) {
    ui.tab = tab;
    const tabs = ui.wrap.querySelectorAll('.ptc-tab');
    tabs.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === tab));
    ui.wrap.querySelectorAll('.ptc-pane').forEach((pane) => {
      pane.hidden = pane.dataset.pane !== tab;
    });
    if (tab === 'watch') renderWatch();
    if (tab === 'price') renderPriceList();
  }

  function open() {
    if (!ui.els.panel) return;
    ui.open = true;
    ui.els.panel.classList.add('is-open');
    ui.els.panel.setAttribute('aria-hidden', 'false');
    if (ui.els.ball) ui.els.ball.classList.add('is-hidden');
  }

  function close() {
    if (!ui.els.panel) return;
    ui.open = false;
    ui.els.panel.classList.remove('is-open');
    ui.els.panel.setAttribute('aria-hidden', 'true');
    if (ui.els.ball && data.settings.floatingBall !== false) ui.els.ball.classList.remove('is-hidden');
  }

  function toggle() {
    if (ui.open) close();
    else open();
  }

  function bindDrag() {
    const ball = ui.els.ball;
    if (!ball) return;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onDown = (ev) => {
      dragging = true;
      moved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = ball.getBoundingClientRect();
      originLeft = rect.left;
      originTop = rect.top;
      ev.preventDefault();
    };

    const onMove = (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const maxLeft = window.innerWidth - 56;
      const maxTop = window.innerHeight - 56;
      const left = Math.min(maxLeft, Math.max(4, originLeft + dx));
      const top = Math.min(maxTop, Math.max(4, originTop + dy));
      ball.style.left = left + 'px';
      ball.style.top = top + 'px';
      ball.style.right = 'auto';
      ball.style.bottom = 'auto';
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        try {
          const rect = ball.getBoundingClientRect();
          chrome.storage.local.set({ [BALL_POS_KEY]: { left: rect.left, top: rect.top } });
        } catch (e) {
          /* ignore */
        }
      }
    };

    ball.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);

    ball.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (moved) {
        moved = false;
        return;
      }
      open();
    });

    // 恢复上次位置
    try {
      chrome.storage.local.get(BALL_POS_KEY, (got) => {
        const pos = got && got[BALL_POS_KEY];
        if (pos && isFinite(pos.left) && isFinite(pos.top)) {
          const maxLeft = Math.max(4, window.innerWidth - 56);
          const maxTop = Math.max(4, window.innerHeight - 56);
          ball.style.left = Math.min(maxLeft, Math.max(4, pos.left)) + 'px';
          ball.style.top = Math.min(maxTop, Math.max(4, pos.top)) + 'px';
          ball.style.right = 'auto';
          ball.style.bottom = 'auto';
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  function bind() {
    if (ui.els.tabs) {
      ui.els.tabs.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('.ptc-tab') : null;
        if (btn && btn.dataset.tab) setTab(btn.dataset.tab);
      });
    }
    if (ui.els.close) ui.els.close.addEventListener('click', close);
    if (ui.els.refresh) {
      ui.els.refresh.addEventListener('click', () => {
        try {
          chrome.runtime.sendMessage({ type: 'ptc:get-rate', league: data.league, force: true }, (res) => {
            if (res && res.rate) {
              data.rate = res.rate;
              data.rateSource = res.source || 'ninja';
              renderStats();
              renderPriceList();
              renderWatch();
              toast('汇率已刷新：1 div ≈ ' + Math.round(res.rate) + ' c');
            } else {
              toast('汇率刷新失败，沿用当前值');
            }
          });
        } catch (e) {
          toast('汇率刷新失败');
        }
      });
    }
    if (ui.els.batch) ui.els.batch.addEventListener('click', doBatch);
    if (ui.els.estimate) ui.els.estimate.addEventListener('click', doEstimate);
    if (ui.els.estClear) {
      ui.els.estClear.addEventListener('click', () => {
        if (ui.els.estText) ui.els.estText.value = '';
        if (ui.els.estParse) ui.els.estParse.textContent = '尚未解析';
        setEstResult('');
      });
    }
    if (ui.els.estText) {
      ui.els.estText.addEventListener('input', () => {
        const text = ui.els.estText.value;
        if (!text.trim()) {
          ui.els.estParse.textContent = '尚未解析';
          return;
        }
        const parsed = PTC.ItemParser.parse(text);
        ui.els.estParse.textContent = parsed.valid
          ? (parsed.name || '—') + ' · ' + (parsed.baseType || '—') + ' · 词缀 ' + parsed.mods.length + ' 条'
          : '未识别到物品，请确认是从游戏内复制的物品文本';
        ui.els.estParse.classList.toggle('is-warn', !parsed.valid);
      });
      // 支持直接 Ctrl+V 粘贴后立即解析
      ui.els.estText.addEventListener('paste', () => {
        setTimeout(() => ui.els.estText.dispatchEvent(new Event('input')), 0);
      });
    }
    if (ui.els.watchCheck) ui.els.watchCheck.addEventListener('click', checkWatchlist);
    if (ui.els.watchClear) ui.els.watchClear.addEventListener('click', clearWatchlist);

    bindDrag();
  }

  function bindBus() {
    bus.addEventListener('data', (ev) => {
      const d = ev.detail || {};
      data.entries = d.entries || [];
      data.stats = d.stats || null;
      data.total = d.total || data.entries.length;
      data.searchId = d.searchId || data.searchId;
      if (d.rate && d.rate.rate) {
        data.rate = d.rate.rate;
        data.rateSource = d.rate.source || data.rateSource;
      }
      renderStats();
      renderPriceList();
      status('已加载 ' + data.entries.length + ' 条挂单');
    });

    bus.addEventListener('search', (ev) => {
      const d = ev.detail || {};
      data.searchId = d.searchId || null;
      data.total = d.total || 0;
      data.entries = [];
      data.stats = null;
      renderStats();
      renderPriceList();
      if (ui.els.batchHint) ui.els.batchHint.textContent = '搜索引擎已记录，等待结果加载';
    });

    bus.addEventListener('notice', (ev) => {
      const d = ev.detail || {};
      if (d.message) showNotice(d.message, d.level);
    });

    bus.addEventListener('rate', (ev) => {
      const d = ev.detail || {};
      if (d.rate > 0) {
        data.rate = d.rate;
        data.rateSource = d.source || 'ninja';
        renderStats();
        renderPriceList();
      }
    });

    bus.addEventListener('league', (ev) => {
      const d = ev.detail || {};
      if (d.league) {
        data.league = d.league;
        if (ui.els.league) ui.els.league.textContent = d.league;
      }
    });
  }

  function applySettings(settings) {
    data.settings = Object.assign({}, data.settings, settings || {});
    const width = Math.min(720, Math.max(320, Number(data.settings.sidebarWidth) || 420));
    if (ui.els.panel) ui.els.panel.style.width = width + 'px';
    if (ui.els.ball) {
      ui.els.ball.style.display = data.settings.floatingBall === false ? 'none' : '';
    }
    if (data.settings.sidebarEnabled === false) {
      close();
      if (ui.els.ball) ui.els.ball.style.display = 'none';
    } else if (ui.els.ball && data.settings.floatingBall !== false) {
      ui.els.ball.style.display = '';
    }
  }

  function init(opts) {
    const o = opts || {};
    data.league = o.league || 'Standard';
    data.settings = Object.assign({}, o.settings || {});
    if (o.divineRate && o.divineRate.rate) {
      data.rate = o.divineRate.rate;
      data.rateSource = o.divineRate.source || 'fallback';
    }
    try {
      build();
      bind();
      bindBus();
      applySettings(data.settings);
      renderStats();
      renderPriceList();
      renderWatch();
      status('就绪');
    } catch (e) {
      /* UI 构建失败时静默降级，不影响页面 */
    }
  }

  PTC.Panel = {
    init,
    open,
    close,
    toggle,
    toast,
    copyText,
    applySettings,
    setTab,
    renderWatch,
    addToWatch,
    get isOpen() {
      return ui.open;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
