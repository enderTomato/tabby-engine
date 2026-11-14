# T15 · 经济模块内核设计

> 状态：**设计中**（待确认后实现）
> 约束：纯逻辑层，禁止依赖任何渲染 / 物理 / DOM API
> 包：`packages/economy`

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

## 待确认

1. **Q02 数值类型**：金币/人口整数 + 其余 Float32，还是全量定点？（影响价格模型复杂度）
2. **资源种类上限**：固定枚举（快，但不可扩展）还是动态注册（灵活，但存档迁移复杂）？
3. **是否需要多城市/多省份**：影响 `cityPopulation` 等数组的维度设计
4. **首个可玩闭环**：房屋→人口→税收→建新房，还是先做完整生产链？

确认后进入实现，预计产出：`packages/economy` 约 1200 行 + 单元测试（无 DOM、无 WebGL，可在 Node 直接跑）。
