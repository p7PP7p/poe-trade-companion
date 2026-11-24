/**
 * lib/selectors.js
 * 多候选选择器集合 + 安全查找工具。
 * 官网改版时，只要能命中任意一个候选选择器，行内增强仍然可用；
 * 全部失效时由 content.js 做静默降级（切换为侧栏模式）。
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  /** 本地默认选择器（按优先级排列的候选列表） */
  const DEFAULT_SELECTORS = {
    resultRow: ['.resultset', '[class*="resultset"]', '.results .row', '.results > *'],
    priceInRow: ['.price', '[class*="price"]', '.details .price'],
    itemNameInRow: ['.itemHeader .itemName', '.itemName', '[class*="itemName"]'],
    whisperBtn: ['.btns .btn', 'button.btn'],
    resultsContainer: ['#results', '.results', '[class*="results"]'],
    itemPopupTitle: ['.itemName', '.itemHeader .itemName', '.price']
  };

  /** 运行期生效的选择器（可被远端配置覆盖） */
  const SELECTORS = JSON.parse(JSON.stringify(DEFAULT_SELECTORS));

  function toArray(keys) {
    if (!keys) return [];
    if (Array.isArray(keys)) return keys.filter((k) => typeof k === 'string' && k.trim());
    return typeof keys === 'string' ? [keys] : [];
  }

  /**
   * 按候选顺序查找第一个命中的元素
   * @param {Element|Document|null} root
   * @param {string[]|string} keys
   * @returns {Element|null}
   */
  function findFirst(root, keys) {
    if (!root || typeof root.querySelector !== 'function') return null;
    for (const sel of toArray(keys)) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 选择器非法时忽略，继续尝试下一个候选 */
      }
    }
    return null;
  }

  /**
   * 按候选顺序收集所有命中元素（去重）
   * @param {Element|Document|null} root
   * @param {string[]|string} keys
   * @returns {Element[]}
   */
  function findAll(root, keys) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const out = [];
    const seen = new Set();
    for (const sel of toArray(keys)) {
      try {
        root.querySelectorAll(sel).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        });
      } catch (e) {
        /* 忽略非法选择器 */
      }
    }
    return out;
  }

  /** 取元素文本（含空白归一化） */
  function textOf(el) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 用远端配置覆盖运行期选择器（仅覆盖合法数组值）
   * @param {Object} remoteSelectors
   * @returns {string[]} 被覆盖的键名
   */
  function applyRemote(remoteSelectors) {
    const changed = [];
    if (!remoteSelectors || typeof remoteSelectors !== 'object') return changed;
    Object.keys(remoteSelectors).forEach((key) => {
      const value = remoteSelectors[key];
      const list = toArray(value);
      if (!list.length) return;
      // 远端候选排在前面，保留本地候选兜底
      const merged = list.concat(toArray(SELECTORS[key] || DEFAULT_SELECTORS[key]));
      SELECTORS[key] = Array.from(new Set(merged));
      changed.push(key);
    });
    return changed;
  }

  /** 恢复本地默认值 */
  function reset() {
    Object.keys(DEFAULT_SELECTORS).forEach((k) => {
      SELECTORS[k] = DEFAULT_SELECTORS[k].slice();
    });
  }

  PTC.Selectors = {
    DEFAULT_SELECTORS,
    SELECTORS,
    findFirst,
    findAll,
    textOf,
    applyRemote,
    reset
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
