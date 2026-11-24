---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 1005a95e2fac3584a3126ed2e10eee75_fe34539ce7d811f1a03c525400638852
    ReservedCode1: 4DgR5P714dvxeiZnOfmyJlXHVrKwOY7Gq/Y3VoUGRCvmxxsC1c3mXCUq5VqXTQAWz667tC4aKWx/j15GrdcP/ntDtoWnf6BAi3XbqPkG+FiwPzPpJkRHyFGWFTsOpWdvq/hCkNdU+cfAcdYRBve/y1zCQCFYATOGBPWC2fn9mzDYpaoKkaOs8iSQmm4=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 1005a95e2fac3584a3126ed2e10eee75_fe34539ce7d811f1a03c525400638852
    ReservedCode2: 4DgR5P714dvxeiZnOfmyJlXHVrKwOY7Gq/Y3VoUGRCvmxxsC1c3mXCUq5VqXTQAWz667tC4aKWx/j15GrdcP/ntDtoWnf6BAi3XbqPkG+FiwPzPpJkRHyFGWFTsOpWdvq/hCkNdU+cfAcdYRBve/y1zCQCFYATOGBPWC2fn9mzDYpaoKkaOs8iSQmm4=
---

# PoE Trade Companion — 市集增强（Chrome / Edge 扩展）

面向《流放之路》国际服官方市集（https://www.pathofexile.com/trade）的浏览器增强扩展，基于 **Manifest V3**，界面全中文。

当前适配赛季：**Covens（0.1.0）**，赛季名与接口路径可通过远端配置热更新，无需重新提审发版。

---

## 1. 功能一览

| 功能 | 说明 |
| --- | --- |
| 搜索结果价格增强 | 拦截市集搜索接口返回，在每条结果行内插入估算价徽标（中位数 / 区间 / 相对挂价的偏离百分比），支持按偏离度着色告警 |
| 物品快速估价 | 在侧栏「快速估价」粘贴游戏内 Ctrl+C 复制的物品文本，输出价格区间、中位数、建议售价（P40）与样本量；「价格分析」Tab 内还可对当前搜索结果一键批量估价（每批 10 条、上限 200 条，带进度条） |
| 收藏与降价追踪 | 任意结果可加入收藏（记录当时的挂价快照），后台按设定间隔巡检，价格下跌超过阈值时发送系统通知，并在侧栏「收藏追踪」以涨跌幅高亮 |
| 一键复制交易私聊 | 结果行「复制」按钮 / 侧栏列表项，一键把该条挂售的官方 whisper 文本写入剪贴板 |
| 赛季自适应 | `config/remote.json` 远端配置 + 本地缓存与过期兜底，赛季名 / 接口路径 / 选择器 / 最低版本要求均可远端下发；同时内置硬编码兜底，断网也不会失效 |
| 悬浮球与侧栏 | 页面右侧可拖拽悬浮球，点击展开 Shadow DOM 抽屉侧栏（也可用快捷键 `Ctrl+Shift+E`），样式与站点完全隔离 |

侧栏包含三个 Tab：**价格分析**（含批量估价）/ **快速估价** / **收藏追踪**。

---

## 2. 安装（加载已解压扩展）

1. 解压 `poe-trade-companion-v0.1.0.zip`（或直接使用 `poe-trade-companion/` 目录）。
2. Chrome 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）。
3. 打开右上角 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择解压出的 `poe-trade-companion` 目录（含 `manifest.json` 的那一层）。
5. 打开 https://www.pathofexile.com/trade/search/Covens ，页面右侧出现悬浮球即安装成功。

> 扩展需要 `storage`、`alarms`、`notifications`、`clipboardWrite`、`scripting`、`tabs` 权限，仅用于本地缓存、定时巡检、降价通知、复制私聊文本与设置页跳转，不采集任何账号信息。

---

## 3. 使用说明

### 3.1 搜索结果价格增强
打开任意市集搜索结果页，扩展会自动接管该页的搜索响应：

- 每条结果行右侧出现徽标，形如 `≈ 12.4 div · -18%`；
- 绿色 = 低于市场价（可能是捡漏），灰色 = 接近市场价，红色 = 明显高于市场价；
- 徽标数据来自对同类物品的批量取样，样本不足时显示 `样本不足`，不会给出误导性结论。

可在设置页关闭行内徽标（`设置 → 行内价格徽标`），或调整取样条数与偏离告警阈值。

### 3.2 物品估价
**单件估价**
1. 在游戏中把鼠标移到物品上，按 `Ctrl+C` 复制物品文本；
2. 打开侧栏 → **快速估价** Tab → 粘贴到文本框；
3. 点击「估价」，依次看到「正在解析物品… → 正在提交搜索… → 正在拉取挂单价格…」，最后给出物品名、基底、稀有度、iLv、样本量、价格区间、中位数与建议售价。

也可以在任意市集页按 `Ctrl+Shift+E` 展开/收起侧栏（快捷键可在设置页修改或关闭）。

**批量估价**
在 **价格分析** Tab 点「批量估价当前结果」，对当前搜索结果逐条估价：扩展每 10 个 id 为一批发起请求，最多 200 条，过程中显示进度条与「已估价 N 条」，完成后给出整体建议价。

估价结果仅供参兑，实际成交价受词缀、品质、赛季供需影响。

### 3.3 收藏与降价追踪
- 结果行点击星标 → 加入收藏，同时记录当前最低挂价作为基线；
- 侧栏 **收藏追踪** Tab 查看全部收藏、当前价、基线价、涨跌幅；
- 后台 `alarms` 每 30 分钟巡检，跌幅超过阈值（默认 10%）时弹出系统通知；
- 收藏数据保存在 `chrome.storage.local`，可随时移除或清空。

### 3.4 复制交易私聊
- 结果行「复制私聊」：复制该条挂售的完整私聊文本；
- 侧栏列表每一项也有复制按钮；
- **合规约束**：扩展只负责把文本写入剪贴板，绝不自动发送、自动点击「邀请组队」或自动接受交易，所有交互仍需玩家手动完成。

---

## 4. 赛季自适应机制

优先级：**本地缓存（未过期） → 远端 `config/remote.json` → 内置兜底常量**。

- 远端配置默认地址：`https://raw.githubusercontent.com/<用户>/poe-trade-companion/main/config/remote.json`
- 可在设置页改为自己的仓库地址，并点「测试远端配置」验证连通性；
- 远端下发的字段包括：`selectors`（结果行、行内价格、物品名等多候选选择器）、`api`（搜索 / 取详情接口路径）、`league` 默认赛季、`leagueAliases` 旧赛季名映射、`notice` 公告文案、`minExtensionVersion` 最低版本要求；
- 新赛季只需改远端 JSON 的 `league` 与 `selectors`，用户端最多延迟一个缓存周期（默认 6 小时）自动生效，无需发新版本；
- 远端可下发 `minExtensionVersion`：本机版本低于该值时，工具栏弹窗顶部显示「插件有新版本，请更新（当前 vX，最新 vY）」黄色横幅；设置页点「测试远端配置」也会列出该字段，便于确认是否被要求升级；
- 远端不可达时静默回退内置常量，页面功能不受影响。

---

## 5. 目录结构

```
poe-trade-companion/
├─ manifest.json              # MV3 清单
├─ background.js              # Service Worker：汇率缓存、收藏巡检（alarms）、通知、远端配置缓存
├─ config/remote.json         # 远端配置模板（可直接发布到 GitHub raw）
├─ icons/                     # 16 / 48 / 128 图标
├─ lib/
│  ├─ selectors.js            # 多候选选择器与容错定位
│  ├─ price-utils.js          # 价格解析、通货归一、统计（中位数/四分位/离群剔除）
│  ├─ item-parser.js          # 物品文本解析（稀有度、名称、基底、iLv、品质、词缀）
│  ├─ query-builder.js        # 搜索请求体与 URL 构造
│  ├─ rate-limiter.js         # 请求队列（最小间隔 260ms）+ 429 退避重试
│  └─ remote-config.js        # 远端配置拉取、缓存、过期与兜底
├─ content/
│  ├─ inject.js               # MAIN world：hook fetch / XHR，回传 search / fetch 响应
│  ├─ content.js              # ISOLATED world：消息桥接、league 提取、行内徽标、快捷键、悬浮球
│  ├─ estimator.js            # 估价流程（取样 → 归一 → 统计）
│  ├─ panel.js                # Shadow DOM 侧栏（三个 Tab）
│  └─ style.css               # 侧栏与徽标样式
├─ popup/
│  ├─ popup.html              # 工具栏弹窗：连接状态、今日统计、快捷入口、版本更新提示
│  ├─ popup.css
│  └─ popup.js
├─ options/
│  ├─ options.html            # 设置页：功能开关、汇率源、提醒阈值、巡检间隔、快捷键、远端配置、缓存清理、恢复默认
│  ├─ options.css
│  └─ options.js
└─ README.md
```

---

## 6. 实现要点

- **双世界通信**：`inject.js` 运行在 MAIN world，拦截 `POST /api/trade/search/{league}` 与 `GET /api/trade/fetch/{ids}?query={searchId}`，通过 `window.postMessage` 把结果交给 ISOLATED world 的 `content.js`；页面 API 调用天然携带同源 Cookie，无需扩展自己持有会话。
- **DOM 增强容错**：所有选择器走多候选数组 + `querySelectorAll` 逐个尝试，定位失败时静默降级（不抛错、不插入空徽标）；`MutationObserver` 200ms 节流处理分页与筛选重渲染。
- **请求节流**：所有扩展发起的网络请求统一经过 `rate-limiter.js` 队列，默认最小间隔 260ms，遇 `429` 指数退避，避免触发官方频率限制。
- **样式隔离**：侧栏全部渲染在 Shadow DOM 内，站点样式无法穿透，扩展样式也不会污染站点。
- **失败静默**：所有外部请求、解析、存储读写均包 `try/catch`，断网、接口改版、字段缺失时功能降级而不报错。

---

## 7. 常见问题

**Q：悬浮球没有出现？**
确认访问的是 `pathofexile.com/trade/...` 页面，且扩展已启用；页面刷新一次；若站点结构改动导致注入失败，等待远端 `selectors` 更新或手动在设置页填写新的远端配置地址。

**Q：行内徽标显示"样本不足"？**
取样条数过少（挂售量小、赛季初期或冷门基底）。可在设置页调大取样数量，但注意过大取样会变慢并更容易触发频率限制。

**Q：估价与游戏内实际成交价差距大？**
估价基于同类挂售的统计中位数，不含议价与卖家心理价，冷门词缀组合偏差更明显。建议参考区间而非单点数值。

**Q：收藏的降价通知没收到？**
需系统允许该浏览器发送通知，且扩展 `alarms` 巡检周期为 30 分钟，最短也要等一个周期。

**Q：切换赛季要做什么？**
通常无需操作。若官方更改了市集 URL 中的赛季名，扩展会按当前页面 URL 自动识别；远端配置也会同步更新默认赛季。

---

## 8. 隐私与合规

- 不采集、不上传任何账号凭据、Cookie 或角色信息；
- 唯一的外部请求为汇率数据（`poe.ninja`）、远端配置（`raw.githubusercontent.com`）与官方市集接口（`pathofexile.com`），全部只读；
- 不实现任何自动交易、自动私聊、自动组队行为，私聊文本仅写入剪贴板；
- 所有数据保存在浏览器本地 `chrome.storage.local`，卸载扩展即清除。

---

## 9. 版本记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1.0 | 2026-11-24 | 首个版本：行内价格徽标、批量估价、收藏降价追踪、一键复制私聊、赛季远端自适应 |
*（内容由AI生成，仅供参考）*
