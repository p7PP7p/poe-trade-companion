/**
 * lib/item-parser.js
 * 解析游戏内 Ctrl+C 复制的物品文本（英文 / 中文客户端均支持）。
 *
 * 结构示例：
 *   Item Class: Rings
 *   Rarity: Rare
 *   Doom Loop
 *   Amethyst Ring
 *   --------
 *   Requirements: ...
 *   --------
 *   Item Level: 80
 *   --------
 *   +10 to Strength
 */
(function (global) {
  'use strict';

  const PTC = (global.PTC = global.PTC || {});

  const SEPARATOR = /^-{6,}$/;
  const META_LINE = /^(item class|rarity|item level|quality|requirements|level|sockets|socketed|catalyst|stack size|note|物品类别|稀有度|物品等级|品质|需求|等级|插槽|已镶嵌|催化剂|堆叠数量|备注)\s*[:：]/i;
  const FLAG_LINES = /^(corrupted|mirrored|split|unidentified|已腐化|已镜像|已分裂|未鉴定|已污染)$/i;

  // 属性行："Armour: 1200 (augmented)"、"Requires Level 68"、"Sockets: G-G-G" 等，不算词缀
  const PROPERTY_LINE = /^(?:Requires\s+(?:Level\b|:)|[A-Z][A-Za-z'’\- ]{0,32}:\s*(?:$|[-+]?[\d.,%]|[GGRBWA\-]+$|.*\((?:augmented|unmet|scaled|crafted|implicit|enchant)\)$))/i;

  const RARITY_MAP = {
    normal: 'Normal',
    magic: 'Magic',
    rare: 'Rare',
    unique: 'Unique',
    currency: 'Currency',
    gem: 'Gem',
    divination: 'Divination Card',
    '普通': 'Normal',
    '魔法': 'Magic',
    '稀有': 'Rare',
    '传奇': 'Unique',
    '唯一': 'Unique',
    '通货': 'Currency',
    '技能宝石': 'Gem',
    '命运卡': 'Divination Card'
  };

  function normalizeRarity(raw) {
    if (!raw) return null;
    const key = String(raw).replace(/[：:]/g, '').trim().toLowerCase();
    if (RARITY_MAP[key]) return RARITY_MAP[key];
    for (const k of Object.keys(RARITY_MAP)) {
      if (key.indexOf(k) >= 0) return RARITY_MAP[k];
    }
    return null;
  }

  function splitBlocks(text) {
    const blocks = [];
    let current = [];
    String(text)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .forEach((line) => {
        if (SEPARATOR.test(line.trim())) {
          if (current.length) blocks.push(current);
          current = [];
        } else {
          current.push(line);
        }
      });
    if (current.length) blocks.push(current);
    return blocks;
  }

  function grabNumber(text, patterns) {
    for (const re of patterns) {
      const m = String(text).match(re);
      if (m) {
        const num = parseFloat(m[1]);
        if (isFinite(num)) return num;
      }
    }
    return null;
  }

  /**
   * 解析物品文本
   * @param {string} rawText
   * @returns {{rarity:string|null,name:string|null,baseType:string|null,itemLevel:number|null,quality:number|null,mods:string[],itemClass:string|null,raw:string,valid:boolean}}
   */
  function parse(rawText) {
    const result = {
      rarity: null,
      name: null,
      baseType: null,
      itemLevel: null,
      quality: null,
      mods: [],
      itemClass: null,
      raw: '',
      valid: false
    };
    if (!rawText || typeof rawText !== 'string') return result;

    const text = rawText.replace(/\r\n?/g, '\n').trim();
    if (text.length < 8) return result;
    result.raw = text;

    const blocks = splitBlocks(text);
    if (!blocks.length) return result;

    // 第 1 段：元信息（稀有度 / 物品类别）
    const head = blocks[0].map((l) => l.trim()).filter(Boolean);
    head.forEach((line) => {
      const rarity = line.match(/^(?:rarity|稀有度)\s*[:：]\s*(.+)$/i);
      if (rarity) result.rarity = normalizeRarity(rarity[1]) || rarity[1].trim();
      const cls = line.match(/^(?:item class|物品类别)\s*[:：]\s*(.+)$/i);
      if (cls) result.itemClass = cls[1].trim();
    });

    // 物品名 + 基底：真实文本里紧跟 Rarity / Item Class 行，与元信息同在第 1 段
    const nameLines = head.filter(
      (line) =>
        !META_LINE.test(line) &&
        !PROPERTY_LINE.test(line) &&
        !FLAG_LINES.test(line) &&
        !/^(?:rarity|item class|稀有度|物品类别)\s*[:：]/i.test(line)
    );
    if (nameLines.length) {
      result.name = nameLines[0];
      if (nameLines.length > 1) result.baseType = nameLines[1];
    }

    // 兜底：极少数客户端把名称单独放在第 2 段
    if (!result.name && blocks[1]) {
      const fallbackLines = blocks[1]
        .map((l) => l.trim())
        .filter((l) => l && !META_LINE.test(l) && !PROPERTY_LINE.test(l) && !FLAG_LINES.test(l));
      if (fallbackLines.length) {
        result.name = fallbackLines[0];
        if (fallbackLines.length > 1) result.baseType = fallbackLines[1];
      }
    }

    // 全文中查找物品等级 / 品质（可能在任意块）
    result.itemLevel = grabNumber(text, [
      /(?:item level|物品等级)\s*[:：]\s*([\d.]+)/i,
      /等级\s*[:：]\s*([\d.]+)/
    ]);
    result.quality = grabNumber(text, [
      /(?:quality|品质)\s*[:：]\s*\+?([\d.]+)\s*%/i,
      /\+([\d.]+)\s*%\s*(?:quality|品质)/i
    ]);

    // 词缀：从第 2 段起（第 1 段是元信息 + 名称），排除属性行、元信息行与状态标记行
    const mods = [];
    const skipLines = new Set([result.name, result.baseType, result.itemClass].filter(Boolean));
    for (let i = 1; i < blocks.length; i += 1) {
      blocks[i].forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) return;
        if (SEPARATOR.test(line)) return;
        if (FLAG_LINES.test(line)) return;
        if (META_LINE.test(line)) return;
        if (PROPERTY_LINE.test(line)) return;
        if (skipLines.has(line)) return;
        // 需求块里的 "Level 60" / "Str 40" 之类
        if (/^[A-Za-z]{2,6}\s*[:：]?\s*\d+$/.test(line)) return;
        mods.push(line);
      });
    }
    result.mods = Array.from(new Set(mods));

    if (!result.baseType) result.baseType = result.name; // baseType 为空回退用 name
    if (!result.name && result.baseType) result.name = result.baseType;

    result.valid = !!(result.name || result.baseType) && (!!result.rarity || result.mods.length > 0);
    return result;
  }

  /** 一句话摘要，用于 UI 预览 */
  function summary(parsed) {
    if (!parsed || !parsed.name) return '未识别到物品';
    const parts = [parsed.name];
    if (parsed.baseType && parsed.baseType !== parsed.name) parts.push('(' + parsed.baseType + ')');
    if (parsed.rarity) parts.push('· ' + parsed.rarity);
    if (parsed.itemLevel != null) parts.push('· iLv ' + parsed.itemLevel);
    parts.push('· 词缀 ' + (parsed.mods ? parsed.mods.length : 0) + ' 条');
    return parts.join(' ');
  }

  PTC.ItemParser = { parse, summary, normalizeRarity, splitBlocks };
})(typeof globalThis !== 'undefined' ? globalThis : self);
