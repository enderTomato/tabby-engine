# T15 · 经济模块内核设计

> 状态：**已实现**（`packages/economy`，1746 行 src + 19 项测试 + 基准脚本）
> 约束：纯逻辑层，禁止依赖任何渲染 / 物理 / DOM API
> 包：`packages/economy`

> 实现期的取舍与偏差记在文末 [§11](#11-实现记录与设计偏差)，四处与本文不同，都有理由。

## 1. 边界

**能做**：资源生产、消耗、价格、人口、税收、建筑产出、tick 结算、存档序列化。

**不能做**：

- 不 import `three` / `pixi` / `@tabby/physics` / `@tabby/render*`
- 不碰 `window` / `document` / `performance.now()`（时间由外部注入）
- 不直接改地形（要改必须走指令队列，见 §7）
- 不在结算里遍历 `Map` / `Set` 决定顺序

依赖只允许 `@tabby/core`（拿 RNG 和事件总线）。**这一条靠 `package.json` 的 dependencies 强制**，不是口头约定。

## 2. tick 调度：逻辑 tick ≠ 渲染帧

模拟经营的核心矛盾：玩家要 x4 加速，但渲染不能跟着 x4（否则 240fps 没有意义），逻辑也不能降精度（否则加速后结果不同）。

```
渲染帧 60Hz ──┐
              ├──► 逻辑 tick 调度器 ──► 日 tick ──► 月 tick ──► 年 tick
固定步 20Hz ──┘        (可加速 x1/x2/x4)
```

| 层 | 频率 | 内容 | 耗时预算 |
|---|---|---|---|
| 帧 tick | 每渲染帧 | 输入响应、UI 状态 | — |
| 日 tick | 可配（默认 1 游戏日 = 2 秒真实时间 @x1） | 生产、消耗、人口迁移 | ≤ 1ms |
| 月 tick | 每 30 日 tick | 税收、市场价格重算、预算 | ≤ 2ms（分摊到多帧） |
| 年 tick | 每 12 月 tick | 统计、成就、存档快照 | ≤ 5ms（异步） |

**加速规则**：x4 时不是把 dt 乘 4，而是**在同一渲染帧内跑 4 个完整 tick**。这样结算结果与 x1 完全一致，只是渲染跳帧——这是确定性的前提。

```ts
interface TickScheduler {
  /** 外部每帧调用，注入真实耗时（毫秒）。模块内部绝不读 performance。 */
  advance(realDeltaMs: number): TickReport;
  setSpeed(speed: 1 | 2 | 4): void;
  readonly currentTick: number;
}

interface TickReport {
  readonly dayTicks: number;
  readonly monthTicks: number;
  readonly yearTicks: number;
  /** 本帧因预算超支被推迟的 tick 数，用于诊断。 */
  readonly deferred: number;
}
```

防死亡螺旋：单帧最多跑 `maxTicksPerFrame`（默认 8）个日 tick，超出部分累积到下一帧；累积超过 240 则**跳帧**（直接推进时间，不结算），并广播 `tick-skipped` 事件。

## 3. 数据结构：数组 + 索引，不用对象图

```ts
/** 资源用固定枚举下标，不用字符串 key —— 字符串哈希在万级实体上是主要开销。 */
type ResourceIndex = number;   // 0=金币 1=食物 2=木材 3=电力 …

interface EconomyState {
  day: number;
  month: number;
  year: number;

  /** 所有数值数组长度一致，下标即实体 id，删除用墓碑标记而非 splice。 */
  readonly alive: Uint8Array;
  readonly buildingType: Uint16Array;      // 指向 BuildingDef 表的下标
  readonly buildingOwner: Int32Array;      // 所属城市/省份，-1 表示无
  readonly buildingTile: Int32Array;       // 地形格子索引，-1 表示无
  readonly buildingEfficiency: Float32Array; // 0..1，受电力/运输/灾害影响

  /** 库存：[实体 × 资源]，行优先。 */
  readonly stock: Float32Array;

  /** 城市/省份聚合数据，长度独立。 */
  readonly cityPopulation: Float32Array;
  readonly cityTaxRate: Float32Array;
  readonly citySatisfaction: Float32Array;

  /** 全局市场价格，长度 = 资源种类数。 */
  readonly price: Float32Array;
  readonly priceTarget: Float32Array;
}
```

**为什么用 TypedArray 而不是对象数组**：

- 10000 个建筑 × 对象 = 至少 10000 个对象头 + 大量指针，GC 压力大
- 数组遍历是连续内存，cache 命中率远高于对象数组
- 存档可直接 memcpy + 压缩，不需要逐字段序列化

**墓碑删除**：`alive[i] = 0`，槽位由 free-list 复用。**不 splice**——splice 会让所有后续 id 前移，破坏引用。

## 4. 系统执行顺序（固定，不可调）

顺序决定结果，必须写死并注释理由：

```
1. production      建筑按配方产出 → stock 增加
2. consumption     人口/建筑消耗 → stock 减少
3. logistics       运输结算（可选，T16 接入）→ 影响下一轮 efficiency
4. market          价格按供需调整 → price ← priceTarget
5. population      迁移（受满意度 + 就业影响）→ cityPopulation
6. tax             税收按人口 × 税率 × 满意度 → stock[金币]
7. maintenance     维护费扣除，资不抵债的建筑降低 efficiency
8. events          触发阈值事件（破产、饥荒、繁荣）
```

理由：

- 生产在消费前：本日产出可以本日消耗，否则永远差一天
- 市场在物流后：价格反映的是实际到货量，不是计划量
- 税收在人口后：用当日人口算税，不用昨日
- 维护费最后：它依赖前六步的全部结果

## 5. 确定性：三条硬规则

1. **遍历顺序用显式数组**，永不遍历 `Map` / `Set`。实体用 id 升序，城市用创建序
2. **随机只用可种子 PRNG**，从 `@tabby/core` 的 `Rng` 取，种子随存档
3. **浮点 vs 定点**：金币、人口用整数（`Int32` / `Float32` 整数域）；价格与效率用 `Float32`。跨设备 `Float32` 的一致性由 IEEE 754 保证（加乘顺序固定即可）。**不用 `Float64` 累加万级求和**——不同引擎的 SIMD 归约顺序可能不同

> 待决：Q02 是否全量改整数定点。倾向「金币/人口整数，其余 Float32」，因为全量定点会让价格模型难写。

## 6. 价格模型

最小可行模型，拒绝指数爆炸：

```
supply   = 期初库存 + 本期产量
demand   = 本期消耗 + 目标储备
ratio    = clamp(supply / max(demand, ε), 0.25, 4.0)     ← 钳制是稳定性的关键
rawPrice = basePrice × (1 / ratio)^elasticity            ← elasticity ∈ [0.3, 1.2]
price    = lerp(price, rawPrice, smoothing)               ← smoothing = 0.15，防止抖动
price    = clamp(price, basePrice × 0.3, basePrice × 3.0)
```

**为什么必须钳制**：`supply` 趋近 0 时 `1/ratio` 会趋向无穷，价格指数爆炸。上下界 + 平滑让价格"缓慢漂移"，玩家能感知但不至于失控。

**通胀控制**：全局金币总量与商品总价值挂钩，月度检查 `moneySupply / gdp`，超过 2.0 时自动提高税率或降低产出（用事件通知，不直接改玩家设置）。

## 7. 与地形/物流的接口（单向）

```ts
/** 经济层能问地形什么（只读，且只给布尔与数字，不给 HeightField 引用）。 */
interface TerrainQuery {
  isBuildable(tileIndex: number): boolean;
  isUnderwater(tileIndex: number): boolean;
  slope(tileIndex: number): number;
}

/** 经济层要改东西，只能发指令，由外部消费。 */
type EconomyCommand =
  | { type: 'place-building'; tile: number; def: number }
  | { type: 'remove-building'; id: number }
  | { type: 'set-tax'; city: number; rate: number };
```

**为什么不让经济层直接改地形**：回放、撤销、多人同步全都依赖"同一份指令序列产生同一结果"。直接改等于绕过唯一真相。

## 8. 存档

```ts
interface EconomySave {
  readonly version: 1;
  readonly seed: number;
  readonly tick: number;
  /** TypedArray 直接二进制，不走 JSON。 */
  readonly buffers: Record<string, Uint8Array>;
}
```

- 二进制而非 JSON：10000 实体 JSON 序列化约 4MB，二进制 0.4MB
- 版本迁移链：`migrate_v1_v2` / `migrate_v2_v3` 依次执行，**不允许跳过版本**
- 字段缺失用默认值填充，但要记一条 warning 进存档日志

## 9. 性能预算

| 规模 | 日 tick | 月 tick | 策略 |
|---|---|---|---|
| 1k 建筑 | ≤ 0.3ms | ≤ 0.5ms | 一次性 |
| 10k 建筑 | ≤ 1ms | ≤ 2ms（分摊 4 帧） | 分帧摊销 |
| 50k 建筑 | ≤ 2ms（分摊 3 帧） | ≤ 4ms（分摊 8 帧） | 脏标记 + 增量 |

**分帧摊销**：月结算按 `chunk` 切片，每帧处理 `1/N`，进度存在 `pendingBatch` 里。不是"算不完就少算"，而是"分摊到多帧，但总量不减"。

## 10. 自检清单：三个最可能踩的坑

1. **`for...in` 或 `Object.keys` 参与结算**：JS 引擎对整数键会做升序重排，对字符串键保持插入序，行为不一致。一律用 `for (let i = 0; i < len; i++)`。

2. **`Float32Array` 求和顺序**：`arr.reduce((a,b)=>a+b)` 与手写循环结果可能差最后几位，被下游阈值放大成"某天突然破产"。固定为升序遍历、单累加器。

3. **存档里的 `undefined`**：`JSON.stringify(Float32Array)` 会变成 `{"0":1,"1":2}`，体积翻 10 倍且不可逆。必须走 `buf.buffer` + base64。

---

## 待确认（已决）

| 问题 | 结论 | 理由 |
| --- | --- | --- |
| Q02 数值类型 | 金币 `Int32`、人口 Float32 整数域、价格与效率 `Float32` | 全量定点会让价格公式变成整数缩放，可读性崩塌；`Float32` 在 1600 万以内整数精确，城市人口远达不到 |
| Q02b 资源上限 | **固定 8 槽位 stride，只用前 N 种** | 资源种类跟着走意味着加一种资源就要重排整个 stock 块；8 槽位浪费 40KB@10k 实体，换掉一整条存档迁移链 |
| Q03 多城市 | 支持 `cityCount ≥ 1`，数组维度第一天就按 N 城市设计 | 这个改起来最贵：所有城市级数组的 stride、事件 payload、存档布局都要动 |
| Q04 首个闭环 | 房屋 → 人口 → 税收 | 测试里的 `village()` 就是这条闭环：3 房 + 2 田 + 1 电站 + 20 人，能稳定跑 5 年 |

## 11. 实现记录与设计偏差

四处与上文不一致，都是实现时才发现原设计站不住：

### 11.1 库存归城市，不归建筑

原文 §3 写 `stock: 实体 × 资源`。实现改成 `cityStock: 城市 × 资源`。

理由：**建筑被拆除时库存不该凭空消失**。玩家拆掉仓库（或任何带库存的建筑）发现粮食没了，这是纯粹的挫败感。而且建筑级库存没有消费者 —— 生产直接进城市仓，消耗也从城市仓扣，中间那层从来没人读。

副作用：`stockOf(city, res)` 而不是 `stockOf(entityId, res)`。拆除返还只作用于建造成本，不碰库存。

### 11.2 金币从库存里分离

原文把金币当成资源 0 放在 `stock` 里。实现改成独立的 `cityTreasury: Int32Array`。

两个理由：

- `Float32` 存金币，超过 16,777,216 后个位就丢了。一个后期存档的金库很容易到这个量级，玩家会看到「钱不涨了」。
- 金币没有价格。把它塞进 `price[]` 要么占个恒为 1 的槽位，要么每次结算都 `if (res === 0) continue`。两种都是噪音。

### 11.3 结算完全不用随机

原文 §5 说「随机只用可种子 PRNG，种子随存档」。实现里**一个随机数都没用**。

人口迁移是确定性公式（满意度驱动），价格是确定性公式（供需驱动），事件是纯观测。这不是偷懒 —— 一旦用了 PRNG，就得把 PRNG 的内部状态（4 个 u32）也存进存档，否则读档后序列错位。而现在 `Rng` 的 `s0..s3` 是私有字段，没有 getState/setState。

结论：**能不用随机就不用**。将来真需要（比如灾害），再加 `state.getState()` 并升存档版本。

### 11.4 月结不另开流水线

原文 §4 把 tax / maintenance 列在日 tick 的 6、7 步，但 §2 又说它们是月频。

实现：日 tick 每天都按 1→8 顺序跑，`runTax` / `runMaintenance` 内部判断 `state.day === daysPerMonth`，不是月末立即返回。

好处是顺序只有一份。如果月结另起一条链路，两条链路迟早会有人只改其中一条 —— 这类 bug 的复现条件是「每 30 天出现一次」，排查成本极高。

### 11.5 没做的两件事

**分帧摊销（§9）未实现。** 实测 50k 建筑 1.41ms/日，在 2ms 预算内，还不需要拆帧。但拆分所需的钩子已经就位：`scratchProduced` / `scratchConsumed` 是预分配的，`aggregate` 是单遍扫描，拆成 chunk 只是加个游标。等实测超了再拆，现在拆属于过早优化。

**物流（步骤 3）是空实现。** 明确留空，不写「先随便挪一点」的占位逻辑 —— 假逻辑一旦被测试依赖上，接真模块时会被当成既有行为保留。

## 12. 自检清单：Android 碎片化环境下最可能踩的三个坑

### 12.1 WebView 切后台回来，时间会跳

Android WebView 在页面不可见时暂停 `requestAnimationFrame`。切回来那一下，rAF 给的 delta 可能是几分钟。

已做两层防护：`advance` 内部把单帧 dt 夹到 1000ms；backlog 超过 `maxBacklogTicks`（240）时直接跳帧 —— 推进日期但不结算，并广播 `tick-skipped`。

**真正的坑在上层**：如果调用方为了「补回后台时间」自己写 `setInterval` 或者直接调 `tickDays(600)`，就绕过了这两层，玩家切回来发现破产了。规则只有一条：**只从引擎主循环喂 `advance(delta)`**，永远不要手动补时间。

### 12.2 低内存设备上，多一份状态就是 3MB

`state.clone()` 会复制全部 TypedArray。50k 建筑约 3.4MB 一份。

2GB 内存的机器上，WebView 本身是多进程架构（渲染进程 + GPU 进程 + 浏览器进程），游戏进程的可用堆比想象中小。同时在内存里留 3~4 份状态做「存档对比」或「撤销」，就是 12MB+ 的额外分配，容易触发系统回收。更糟的是：WebView 里 OOM 的表现是**页面白屏重载**，没有错误日志，线上只会看到「偶发闪退」。

规则：只在存档/读档界面 clone，**不要每帧 clone 做 diff**。要做撤销就用指令日志重放，不要存状态快照。

### 12.3 金库 Int32 回绕（已修，但留了读档缺口）

`cityTreasury` 是 `Int32Array`，超过 2,147,483,647 会**静默回绕成负数**，而 `runEvents` 把负金库判定为破产 —— 也就是「钱太多」触发「破产」。

已在三个写入点钳制到 `[0, 2e9]`：`Economy.addTreasury`（存款/拆除返还）、`runTax`（税收）、`rebuildStockBounds`（读档修复）。

读档那条最容易漏：存档反序列化时 `cityTreasury.set(...)` 直接覆盖数组，完全绕过门面。旧版本 bug 或手改的存档带着负值进来，读档当天就会破产，而且看起来像「读档坏了」。

### 补充：一个不是坑但需要知道的边界

价格公式用了 `Math.pow`。V8 从 2016 年起用 fdlibm 移植的软件实现，**在所有平台上 bit-exact**，所以 Chrome / Android WebView 之间一致。

但 JavaScriptCore（Safari）和 SpiderMonkey（Firefox）是各自实现，末位可能有差异。如果将来做跨浏览器多人同步，价格表会在两端慢慢拉开 —— 那时要么把结算搬到服务端，要么把 `(1/ratio)^elasticity` 换成硬编码查表。

当前不做，因为目标平台是 Chromium 内核，而 iOS 只要求「不破坏可运行性」。
