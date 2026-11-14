# Tabby Demo

验证 Tabby Engine 全链路的最小可玩场景：2D 经营 + 3D 物理试验场，共用同一个物理世界。
构建产物在 `dist/`，**必须通过 HTTP 访问**。

## 跑起来

```bash
# 从仓库根目录
pnpm install
pnpm build

# 启动（dist 里自带 serve.mjs，会下发 COOP/COEP）
cd apps/demo/dist && node serve.mjs
# -> http://localhost:4173/
```

`serve.mjs` 带的头：

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

没有这两个头，`SharedArrayBuffer` 拿不到，引擎会静默退到 `worker-copy`。页面右上角面板的 `worker-shared` / `worker-copy` / `local` 就是当前实际模式。

直接双击 `index.html` 会白屏 —— `file://` 下没有 WebGL2 上下文。

## 玩法

**2D 经营** —— 12×6 格，四种工具：

| 工具 | 造价 | 作用 |
|---|---|---|
| 住宅 | 40 | 每栋 10 人口容量，维护费 2/月 |
| 农田 | 60 | 产 6 食物/日，提供 4 个岗位，维护费 3/月 |
| 挡板 | 15 | 挡住水流，**同时阻断路网通行**，维护费 0.5/月 |
| 拆除 | — | 返还一半造价 |

经济不是装饰数字，是真的在跑：

- **日期**按 ×1 / ×2 / ×4 速度推进（×1 时 2 秒一天），30 天一个月
- **人口**按满意度迁入迁出，被住房容量钳制；满意度由「吃饱 / 有工作 / 税低」三项加权
- **月末**扣维护费、收税；金库见底会让建筑效率逐步下滑
- **水塔**持续浇灌左侧三列农田，每 25 单位吸收水量折算 3 金币 —— 这是主要收入来源

**物流**：每栋生产建筑都要能走到市政厅（`(0,0)` 格，小地图上的金色格）。

- 越远效率越低（距 4 格内不惩罚，22 格归零），产量按效率打折；
- 挡板会断路。把农田围起来挡水，等于把自己的供应链掐断 —— 这是本 demo 里
  第一个「同一件物件有两种代价」的设计；
- 状态栏的 `物流 N / M 通` 就是「有产出的建筑里几座还能到市政厅」。

链路细节见 [docs/LOGISTICS.md](../../docs/LOGISTICS.md)。

**小地图**：状态栏左侧那块像素图，1 格 = 1 像素的离屏缩略图按 12 倍最近邻放大。
金色格是市政厅，暗红格是断供建筑。稳态下它几乎不重绘（只在建造/拆除/物流变化时脏）。

**3D 试验场**：拖动旋转视角（松手带惯性）、双指捏合缩放、双指扭转旋转、双指拖动平移、滚轮缩放，点击地面丢一个布娃娃。建筑、水流、烟雾、风车摆锤都在同一个物理世界里。

3D 模式下建筑头顶有浮动标签（住宅 / 农田物流效率），被楼挡住会自动隐藏 ——
那是 `RenderBridge` 在做投影 + 射线遮挡判定，不是 CSS 能解决的问题。

**输入**：全部走 `@tabby/input` 的 `InputManager`，2D / 3D 各一个实例。

| 手势 | 2D | 3D |
|---|---|---|
| 点击 | 建造当前工具 | 丢布娃娃 |
| 长按 | 拆除 | — |
| 拖动 | 高亮格子 | 旋转视角（松手带惯性） |
| 双指捏合 | — | 缩放 |
| 双指扭转 | — | 旋转 |
| 双指拖动 | — | 平移 |

2D 格子的热区**不扩展**（扩到 44px 会盖住邻居），3D 的图标类元素才扩展。

右上角 `诊断` 展开完整能力报告：GPU 厂商/渲染器、WebGL2 参数、Worker 与 SAB 支持、三档配置命中情况、降级原因，以及**经济内核快照 + 物流统计 + 分块流式状态 + 配置表状态 + 投影一致性自检**。

面板顶部是**运行时调参区**（6 个滑块）与三个按钮：

| 旋钮 | 范围 | 真实现场 |
|---|---|---|
| 时间倍速 | ×1 / ×2 / ×4 | `Economy.setSpeed`（跑更多 tick，不放大 dt） |
| 一天时长 | 100–3000ms | `Economy.setMsPerDay` |
| 税率 | 0–60% | `applyCommand({type:'set-tax'})`（内核钳到 0.6 防负税收） |
| 物流免惩罚距离 | 0–16 格 | `CityLogistics.setCurve`（改完自动作废效率缓存） |
| 物流归零距离 | 4–40 格 | 同上 |
| 灌溉折算 | 5–60 单位/笔 | `CitySimulation.setIrrigationUnit` |

每个旋钮都实现 `read`/`write` 且真的写到世界里，写不进去就不给旋钮 ——
`src/game/debug.ts` 同时是「哪些参数运行时可改」的清单。

| 按钮 | 作用 |
|---|---|
| 重读配置表 | 重新读 `public/config/table.json`。校验不过只报错、不换表（改到一半保存不会把页面搞崩）；表无变化不重建世界 |
| 重建世界 | 用当前配置表重建整个仿真层。热重载后必须走这条才能让新数值生效 |
| 重读参数 | 从世界重读全部旋钮（读档、外部改参之后点一下） |

## 分块存档与流式加载

存档格式是 `TBCK`：固定 24 字节头部 + 目录（每块 16 字节：key/offset/length/CRC）+ 数据区。

```
头部  magic "TBCK" | version | cols | rows | chunkW | chunkH | count
目录  key(4) offset(4) length(4) crc(4)   ← 每块一条
数据  cells(1B/格) + entityIds(4B/格)
```

目录在前、数据在后，所以**读单块不用扫全文件**：seek 到目录 → 找到 offset → 只读那一段。
这是「流式」的全部内容。CRC 用 FNV-1a（三行、无查表），挡的是「写到一半被杀进程」导致的截断。

demo 的 12×6 地图切成 3×2 = 6 块，`ChunkStreamer` 按指针位置决定哪几块常驻
（诊断面板里的 `常驻块 4 / 6`）。小到看不出收益，但换成 512×512 地形时这套机制是必需的。

## 配置表与热重载

`src/game/defs.ts` 是内置表；`public/config/table.json` 是可选覆盖表（存在且校验通过才生效）。

校验分两层：

1. `@tabby/economy` 的 `validateResources` / `validateBuildings` 检查**内核能不能算下去**；
2. `src/game/config-table.ts` 检查**玩法约束**：key 唯一、分类合法、输入输出不能是同一资源、
   住宅容量 > 0、税率在 [0, 0.6] 等。所有错误都带 JSON 路径（`buildings[2].category`），
   直接显示在诊断面板里。

热重载三条路径：

| 改动 | 触发 | 结果 |
|---|---|---|
| `src/game/defs.ts` | Vite HMR | `game/hmr.ts` 接住新模块，推给 `ConfigHost`，世界自动重建 |
| `public/config/table.json` | 手动点「重读配置表」 | 不在模块图里，HMR 不知道它变了 |
| 控制台 `__tabby3d` | 手动 | 调试用 |

改表会重建实例（`buildingType` 存的是表下标，表一变所有建筑含义都可能变），
所以这是**调试功能，不是玩法功能** —— 重建等于丢当前进度。

## 控制台入口

```js
__tabby                     // Engine 实例
__tabby.tier                // 'low' | 'mid' | 'high'
__tabby.host.mode           // 'worker-shared' | 'worker-copy' | 'local'
__tabby.getDiagnostics()    // { report, fluid, ... }

__tabby3d.debug()           // { fluidPoints, smokePoints, ragdollVerts, drawCalls, triangles }
__tabby3d.sim               // CitySimulation 实例（经济内核门面）
__tabby3d.hud()             // 当前 HUD 快照
__tabby3d.projection()      // { ok, detail } 投影与实体池的一致性自检
```

排查「格子对不上」时先跑 `__tabby3d.projection()`：返回 `ok: false` 说明有人绕过了指令队列直接改了 `Economy.state`。

## 测试

```bash
pnpm --filter @tabby/demo test
```

70 个用例，测的都是**接入方式**而不是内核算术（内核算术在 `packages/*/tests`）：

| 文件 | 数量 | 测什么 |
|---|---|---|
| `simulation.test.ts` | 15 | 投影会不会漂、指令队列会不会漏、读档后几何会不会残影 |
| `logistics.test.ts` | 14 | 挡板是否真断路、拆建筑是否漏解绑、读档是否留幽灵墙、围死农田是否停产 |
| `chunkstore.test.ts` | 14 | 随机访问单块、截断/篡改是否报错、流式加载顺序与宽限期 |
| `config.test.ts` | 20 | 每条校验错误的 path 是否正确、失败是否保留旧表、无变化是否重建 |
| `minimap.test.ts` | 7 | 像素颜色、只脏才重绘、断供图层、无 DOM 环境下不抛错 |

## 换档测试

```js
// 强制低端档，观察粒子数与分辨率变化
await Engine.create({ views: [...], forceTier: 'low' })
```

在 SwiftShader 软渲染环境下会命中 GPU 黑名单自动降到 `low` 档（30fps / 180 粒子 / 缩放 0.75），
可以用这个验证降级链路。

## 架构说明

格子归属以**经济层实体池为唯一真相**，渲染侧只保留一份投影缓存。详见
[ADR-007](../../docs/adr/ADR-007-economic-authority.md)。
