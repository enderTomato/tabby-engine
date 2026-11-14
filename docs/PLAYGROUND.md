# Playground · 逐特性隔离验证台

`apps/playground` 不是第二个 demo。它是**验证工具**：每个特性单独挂载、单独跑分，
一个探针崩了不拖垮别的。这件事本身就是验收项 —— 如果某个特性只能在完整游戏里跑，
说明它的边界没切开。

```bash
pnpm --filter @tabby/playground dev      # http://localhost:5174
pnpm --filter @tabby/playground build
node apps/playground/dist/serve.mjs      # 构建产物自带服务器，会把 COOP/COEP 一起下发
node tools/smoke-playground.mjs 4175     # 无头跑一遍：12 个探针逐个挂载 + 跑分
```

`dist/serve.mjs` 读 `$PORT`、绑 `0.0.0.0`，所以既能本地跑也能直接丢到任何单端口平台上。
`vite preview` 不做这件事 —— 它不带 COOP/COEP，`crossOriginIsolated` 为 false，
解码器与 SharedArrayBuffer 会一起降级，跑出来的数不是这台机器的真实水平。

## 为什么不用 Vue

这是「引擎能不能不绑框架」的唯一证据。外壳用最朴素的 DOM（侧栏是 `<button>`，探针自己
`appendChild`，零响应式）。如果这里也用 Vue，`@tabby/ui` 到底能不能脱离 Vue 就永远测不出来 ——
而那是把它拆出来的唯一理由。

## 十二个探针

| 分组 | 探针 | 验什么 |
|---|---|---|
| 物理 | 液体 | 粒子位置/密度稳定性；200/600/1200 粒子单步耗时是否近似线性 |
| 物理 | 布娃娃 | 关节链是否收敛；1/4/12 个人形的单步成本与休眠判定 |
| 物理 | 风场 / 烟雾 | 阵风奇次幂塑形；同 seed 同输入同输出；烟被风拖着走 |
| 物理 | 摆动 / 双摆 | 数值解与解析解的偏差；RK4 是否真的比单摆贵（倍数应 > 2） |
| 渲染 | 地形 / LOD | 屏幕误差判据是否自适应；远近三角形数是否单调 |
| 渲染 | 资源加载 / 降级 | 能力探测 → 候选链 → 真加载；解码器不在主包；引用计数回收 |
| 渲染 | 渲染桥 | `w<0` 判视锥、射线-AABB 判遮挡、44px 去重叠；四种状态可视化 |
| 交互 | 输入手势 / 热区 | 24px 图标必须点得中（44px 热区）；六类手势；惯性 30/120fps 一致 |
| 系统 | 路网图 / Dijkstra | 建造顺序无关（确定性）；惰性删除堆的定局节点数；CSR 占用 |
| 系统 | 经济内核 | 断供影响价格而不只产量；同种子跑 120 天逐字段一致 |
| 经营 | 小地图 | 标脏粒度；稳态下重绘次数应远小于帧数 |
| 经营 | 分块存档 | 目录在前数据在后；坏一块不拖垮全局 |

## 跑分口径：为什么必须批量计时

`performance.now()` 的分辨率被 Chromium 钳在 5µs 左右（Spectre 缓解）。而「一次风场采样」
「一次 LOD 选择」只有几十纳秒 —— 单次计时会稳定返回 `0.00µs`，看上去像探针坏了，
实际是尺子不够细。

所以统一用 `timeBatch`：跑一批、量总量、扣掉空循环、再平均。几纳秒的操作也能给出三位有效数字。

```ts
const sampling = timeBatch((i) => field.sample(x(i), 0.5, z(i), t(i), out), 4000);
// sampling.perCallUs ≈ 0.16
```

**反例**（改之前真踩过）：在计时回调里收集事件对象，把一次 1µs 的手势处理测成了 28.7µs ——
量到的是探针自己的字符串分配。

## 加一个新探针

1. 在 `src/probes/` 建文件，导出一个 `createXxxProbe(): Probe`。
2. `mount` 里只 `appendChild` 到 `ctx.host`，**不要**假设别的探针存在。
3. `unmount` 必须真的释放：停 rAF、`dispose()` **并丢掉 GL 上下文**、移除元素。切换前一定会调。
   只调 `renderer.dispose()` 是不够的 —— 它清 three 自己那本 GPU 资源账，上下文并不归还，
   反复切探针会把浏览器的上下文配额（Chromium 是每页 16 个）耗光，之后新建直接失败。
   `createThreeStage` 已经在 `dispose()` 里补了 `forceContextLoss()`。
4. `tick` 只在每帧都要动的时候实现；纯计算的探针不要给，否则会让人以为它是逐帧的。
5. `bench` 里的数字要能改变读者的判断 —— 「35µs」比「很快」有用，「0.00µs」是错的。
6. 在 `src/main.ts` 的 `probes` 数组里登记，跑一次 `node tools/smoke-playground.mjs`。

## 探针的隔离约定

- 探针之间**不共享实例**：`attachOrbit` 是自己写的几十行，不复用 `@tabby/input` ——
  否则手势探针挂了会让所有 3D 探针一起挂。
- 3D 舞台是最小实现（`createThreeStage`），不用 `Renderer3DView`：那个类带引擎生命周期、
  档位判定、DRS —— 对单个探针是噪声。要验的东西（`PointsLayer`、`RenderBridge`）仍然用真的。

## 冒烟是红的，但看着不像代码问题

无头冒烟报 `A WebGL context could not be created ... BindToCurrentSequence failed`，
同时能力行显示「没有可用的 WebGL 上下文」—— 先怀疑环境，别急着改代码。

**最常见的一种：`DISPLAY` 指向一个不存在的 X server。**

容器和 CI 里经常残留 `DISPLAY=:0`，但并没有 X 在跑。ANGLE 一看见 `DISPLAY` 就优先选
XCB/Vulkan 后端，`xcb_connect()` 失败后整个 GPU 进程起不来，于是所有上下文创建全部失败。
这个错的长相极具误导性，看上去像「设备/浏览器不支持 WebGL」。

确认：`chromium --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader` 时
stderr 里有 `DisplayVkXcb.cpp:62 (initialize): xcb_connect() failed`。

两个冒烟脚本现在都会在启动子进程前把 `DISPLAY` 摘掉，并在开跑前做一次 WebGL2 预检 ——
拿不到就带着排查提示直接退出，而不是让 12 个探针各报一遍同样的错。

手工排查：

```bash
env -u DISPLAY node tools/smoke-playground.mjs 4175
```
