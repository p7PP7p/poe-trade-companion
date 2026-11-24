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
  const DATA_SEGMENTS = ['stats', 'items', 'static'];

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
    i18nConfig.statsDictLoaded = !payload || payload.statsDictLoaded !== false;
    if (incomingById && incomingVer !== i18nConfig.byIdVersion) {
      i18nConfig.byId = Object.create(null);
      mergePlain(i18nConfig.byId, builtin.byId);
      mergePlain(i18nConfig.byId, incomingById);
      i18nConfig.byIdVersion = incomingVer;
    } else if (!incomingById && incomingVer !== i18nConfig.byIdVersion) {
      // 未下发词缀库：只保留内置 byId
      i18nConfig.byId = Object.create(null);
      mergePlain(i18nConfig.byId, builtin.byId);
      i18nConfig.byIdVersion = incomingVer;
    }

    i18nConfig.enabled = !!(payload && payload.enabled);
    if (i18nConfig.enabled && pageAlreadyLocalized()) i18nConfig.enabled = false;

    // 词库加载完毕（或明确无需再等）时放行挂起的 stats 请求
    if (i18nConfig.statsDictLoaded) markStatsReady();
  }

  function translateText(text) {
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
    return null;
  }

  /** 只改词典能命中的展示字段；枚举值（如 armour.chest）不在词典中，天然不受影响 */
  // label/title 为筛选器分组标题（如 "Item Category"），text 为选项文案；type 等枚举值天然不在词典中
  const TEXT_FIELDS = ['label', 'title', 'text', 'type'];

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
  let statTextReady = false;
  let textMapResolve = null;
  const textMapReady = new Promise((resolve) => {
    textMapResolve = resolve;
  });

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
    const tpl = statTextMap[t.key];
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
      // type 在 stats 数据里是查询用的机器枚举值：词库里有同名界面词（"Explicit"→"显式"），
      // 若按文本改写，页面会构造出 type="显式" 的非法查询以致搜索失效。物品数据的 type
      // 是基底展示名（如 "Chaos Orb"），不在枚举集合内，照常翻译。
      if (field === 'type' && ENUM_VALUES.indexOf(String(val).toLowerCase()) >= 0) continue;
      const byIdHit = keyId && field === 'text' ? i18nConfig.byId[keyId] : null;
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
    try {
      i18nConfig.stats.requests += 1;
      if (!i18nConfig.enabled) return { payload, changed: 0 };
      walkI18n(payload, stats, 0);
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
