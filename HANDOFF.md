# PoE Trade Companion — 跨设备交接文档

> 更新时间：2026-11-27 | 当前版本：**v0.5.1** | 状态：已发布，暗金名中文检索已验证可用

## 1. 单一真相源

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/p7PP7p/poe-trade-companion |
| 分支 | `main` |
| 最新 Release | https://github.com/p7PP7p/poe-trade-companion/releases/tag/v0.5.1 |
| 安装包资产 | `poe-trade-companion-v0.5.1.zip`（1,270,082 B） |
| 代码同步状态 | 仓库 `main` 与旧设备本地 `poe-trade-companion/` 逐文件一致（dist 历史 zip 与 .gitignore 除外） |

新设备接手只需：**从 Release 下载 zip → 解压到固定目录 → 加载扩展**。源码改动全部走同一仓库，禁止在单机私自改词库后不回推。

## 2. 新设备环境准备

1. 浏览器：Chrome / Edge **111+**（Manifest V3 + MAIN world 注入要求）。
2. 可选工具链（只在需要重建词库时用）：
   - Node.js（`node --check` 校验 JS 语法）
   - Python 3 + `opencc-python-reimplemented`（台服繁转简兜底，可选）
3. 无需游戏客户端、无需 git / gh CLI：无 git 时可直接下载 Release zip，或用 GitHub REST API（Git Data API）推送。

## 3. 安装步骤（固定目录，关键）

1. 下载 `poe-trade-companion-v0.5.1.zip`。
2. 解压到**固定目录**，例如 `C:\Users\<用户>\Documents\PoE-Trade-Companion\`，得到 `poe-trade-companion\`（含 `manifest.json` 的那一层）。
3. Chrome 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`），开启右上角开发者模式。
4. 点「加载已解压的扩展程序」，选中 `poe-trade-companion` 目录。
5. 打开 https://www.pathofexile.com/trade/search/Covens 。

> **必须避开的坑**：不要从 zip 的临时预览目录（`Temp\BNZ.*`）加载，会报 `File path cannot be resolved / 无法加载清单`。这是路径问题，不是包损坏。

## 4. 安装后验证清单

| 检查项 | 预期 |
| --- | --- |
| 页面右侧悬浮球 | 可见，点击展开侧栏（或 `Ctrl+Shift+E`） |
| 侧栏「诊断」Tab | 运行版本显示 **0.5.1** |
| 控制台启动自检 | 出现 `[PTC v0.5.1] inject/bridge/localizer ...` 摘要 |
| 筛选面板汉化 | 选项显示中文 |
| 暗金名中文检索 | 输入「再造恶意」→ 换算为 `Reclaimed Malevolence` 并出结果 |
| 基底名中文检索 | 输入「青玉护身符」→ 命中 `Turquoise Amulet` |
| 模糊前缀检索 | 输入「女王的饥」→ 命中 `The Queen's Hunger` |
| 通货专名 | 输入「混沌石」→ 命中 `Chaos Orb` |
| 英文输入 | 原样透传，零干预 |

> 词库是**内置文件**（`lib/*.js`），中文换算索引只读内置词库：改词库后必须在扩展管理页点「重新加载」并刷新市集页，远端热修不覆盖物品名索引。

## 5. 架构与关键文件

```
poe-trade-companion/
  manifest.json              MV3 清单，matches 严格限定 https://www.pathofexile.com/trade*
  background.js              后台：缓存、定时巡检、降价通知
  content/
    inject.js                数据层：hook fetch/XHR，改写接口返回的展示字段（价格徽标、属性语法）
    search-bridge.js         MAIN world：中文→英文反查索引 + 输入镜像 + 自绘候选浮层
    localizer.js             DOM 层：TreeWalker + MutationObserver 就地改写 nodeValue
    panel.js                 Shadow DOM 侧栏（价格分析 / 快速估价 / 收藏追踪 / 诊断）
    estimator.js             估价算法
  lib/
    i18n-dict.js             UI + 固定专名词库（含 v0.5.0 STATIC 补充层 1214 条）
    i18n-stats-zh.js         词缀词库 18204 条（国服官方简中为主源）
    i18n-items-zh.js         物品词库：type 4010 条 + name 1433 条（暗金名）
  config/
    remote.json              远端配置：i18n.dictUrl、league、notice、限流参数
    i18n-zh.json             远端可热修的汉化词库（version 0.5.1）
    i18n-stats-zh.json       远端词缀词库
    i18n-filters-zh.json     筛选器 id 型枚举词库
  dist/                      历史版本 zip（仓库内归档）
```

## 6. 硬约束（改动前必读）

1. **机器值一律不动**：`option.id`、`filter.id`、`type` 枚举、`~price` / `~b/o` 标记、`listing.whisper`、结果 `id`、`extended`、`frameType`、`icon`、`stackSize`。含 `~` 的整段跳过不译。
2. **提交给官网的查询值必须为英文**：中文只在内存与展示层换算，`query.name` / `query.type` 提交前经 `zhToEn` 换回英文原文；未命中一律保留英文，不做模糊拼接。
3. **DOM 改写就地替换 `nodeValue`**：不得摘除 React 持有的文本节点，否则重渲染崩坏。
4. **IME 组合期零介入**：`compositionstart → compositionupdate → compositionend` 期间不换算、不改写、不派发事件、不弹层；上屏后约 60ms 再补候选。
5. **纯英文输入零干预**：不得为防误改而加"纯小写一律不改写"类保险，会废掉小写英文→中文候选能力。
6. **私聊仅复制到剪贴板**：不得自动 whisper、不得自动接受组队邀请（GGG 禁止自动交易行为）。
7. **交易接口限流**：搜索类约 5 秒内 ≤20 次，超限封 60 秒；须读 `X-Rate-Limit-*` 与 `Retry-After`。
8. **链接**：目标站仅 `https://www.pathofexile.com/trade*`；三站数据接口为 `www.pathofexile.com` / `pathofexile.tw` / `poe.game.qq.com`（`poe.qq.com` 的 data 接口 404）。

## 7. 词库重建流程（赛季更新用）

1. 拉三站 `/api/trade/data/{stats,static,filters,items}`。
2. **主源固定为国服 `poe.game.qq.com`**（官方简体中文）；台服繁转简只补缺口，并叠加术语覆盖表（咒术→魔蛊、神殿→神龛、召唤物→召唤生物、机率→几率、萃取物→酊剂）。
3. `stats` / `static` / `filters` 按 **id** 对齐（三站 id 通用）；`#` 占位数量不一致整行放弃保留英文。
4. `items` 无 id，只能顺序对齐：
   - 基底（`type`）：按同组连续段做 LCS，段长相等才按索引对齐，类别尾词评分设门限（一致率 ≥90% 才保留）。
   - 暗金名（`name`，`flags.unique=true`）：**只存在于 items 的 name 字段，不在 stats 里**。以「基底 type 中英表」为锚点，把国服简中 unique 名对齐国际服英文 unique 名，再用旧词库做一致率校验（v0.5.1 实测 99.8%），仅写回通过项。
5. 写回 `lib/i18n-items-zh.js` 与 `lib/i18n-*.js`，同步 `config/*.json`；纯词库改动可只走远端热修（`remote.json` 的 `i18n.version` 自增），但 **items 名索引属内置文件，必须发版**。
6. 校验：所有 js 跑 `node --check`，三个配置 JSON 解析，回读关键条目（如「再造恶意」→ `Reclaimed Malevolence`）。

## 8. 发版流程（无 git 环境）

用 GitHub REST API：`POST /git/blobs` → `POST /git/trees`（`base_tree`=当前 main HEAD）→ `POST /git/commits` → `PATCH /git/refs/heads/main` → `POST /releases` → `POST uploads.github.com/repos/<repo>/releases/<id>/assets?name=<zip>`。

凭据：旧设备把 PAT 存在 Windows 凭据管理器 `Marvis:GitHub:p7PP7p`，脚本经 `CredReadW` 读取、不落盘。**新设备不要复制该凭据**，改为在新机自行添加凭据或用网页操作。旧 PAT 建议在 GitHub 后台 Revoke 后重新签发。

## 9. 已知问题与待办

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 快速匹配列表（下拉项）仍全英文 | 未解决 | 「女王的饥饿」在快速匹配列表显示英文。检索输入换算与下拉文案改写是两条独立链路，需新设备 Console 诊断输出定位，**不可臆测结论** |
| armour / weapon 基底双语覆盖 | 待做 | 用 `flags.unique` 标记序列做锚点 + DP 对齐，预计 items 覆盖 878 → 4000+ 条 |
| 赛季新词 | 常态 | 三站都无中文的约 250 条属正常上限，可远端热修补 |
| Cloudflare 人机验证 | 环境限制 | 自动化浏览器拿不到真实 DOM / Vue 实例，任何依赖组件实例的方案会永不触发；诊断需用户在真机 Console 取输出 |

## 10. 历史版本节奏（摘要）

`v0.1.0` 可行性 → `v0.2.x` 价格增强/估价 → `v0.3.x` 汉化 + 中英双向检索 + IME 兼容 + 双语展示 → `v0.4.x` 挑战页误判修复 + 输入镜像 → `v0.5.0` 词库主源切国服官方简中（词缀 18204 / 专名 1214） → `v0.5.1` 暗金名词库补齐（items name 1241 → 1433）。

完整变更记录见仓库 `README.md` 第 10 节。
