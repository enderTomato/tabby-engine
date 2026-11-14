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
| 挡板 | 15 | 挡住水流，改变水的落点，维护费 0.5/月 |
| 拆除 | — | 返还一半造价 |

经济不是装饰数字，是真的在跑：

- **日期**按 ×1 / ×2 / ×4 速度推进（×1 时 2 秒一天），30 天一个月
- **人口**按满意度迁入迁出，被住房容量钳制；满意度由「吃饱 / 有工作 / 税低」三项加权
- **月末**扣维护费、收税；金库见底会让建筑效率逐步下滑
- **水塔**持续浇灌左侧三列农田，每 25 单位吸收水量折算 3 金币 —— 这是主要收入来源

**3D 试验场**：拖动旋转视角，滚轮缩放，点击地面丢一个布娃娃。建筑、水流、烟雾、风车摆锤都在同一个物理世界里。

右上角 `诊断` 展开完整能力报告：GPU 厂商/渲染器、WebGL2 参数、Worker 与 SAB 支持、三档配置命中情况、降级原因，以及**经济内核快照 + 投影一致性自检**。

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

15 个集成用例，测的是**接入方式**而不是经济内核算术（后者在 `packages/economy/tests`）：
投影会不会漂、指令队列会不会漏、拆光农田会不会饿死人、读档后几何会不会残影。

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
