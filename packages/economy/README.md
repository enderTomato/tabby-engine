# @tabby/economy

模拟经营逻辑内核。纯 TypeScript，**无 DOM、无渲染、无物理**，能在浏览器、Worker、Node、服务端权威模拟里跑同一份代码。

```bash
pnpm add @tabby/economy
```

## 三十秒上手

```ts
import { Economy, DEFAULT_BUILDINGS, buildingIndexOf } from '@tabby/economy';

const eco = new Economy({ entityCapacity: 4096, cityCount: 1, seed: 42 });

// 初始状态：20 人、500 金币、40 粮 10 木
eco.init({ population: [20], treasury: [500], stock: [[40, 10, 0, 0]] });

// 造房子：走指令，不直接改 state
const house = buildingIndexOf(DEFAULT_BUILDINGS, 'house');
eco.applyCommand({ type: 'place-building', city: 0, tile: 12, def: house });

// 每帧喂真实耗时，内部自己换算成游戏日
eco.advance(16.7);

// 或者跳过时间（测试、服务端补算）
eco.tickDays(360);

console.log(eco.getCity(0));       // { population, taxRate, satisfaction, treasury, ... }
console.log(eco.getDiagnostics()); // 价格表、GDP、通胀比、耗时
```

## 设计要点

### 加速靠多跑 tick，不放大 dt

`setSpeed(4)` 不会把 `dt` 乘 4，而是在同一帧里跑 4 个完整的日 tick。

理由：价格平滑、人口迁移都是**按步长非线性**的。放大 dt 会让 x4 的世界慢慢偏离 x1，存档回放和多人同步立刻失效。

### 结算完全确定性

同一指令序列 → 同一结果，跨设备、跨帧率、跨速度都成立。靠三件事保证：

1. 遍历永远用 `for (let i = 0; i < capacity; i++)`，不碰 `Map` / `Object.keys`
2. 结算里**没有随机数**，所以也不需要序列化 PRNG 状态
3. 单一累加器、升序求和，不做 SIMD 归约

### 删除是墓碑，不是 splice

`remove-building` 只把 `alive[id]` 置 0，槽位进 free-list 复用。splice 会让后面所有 id 前移，任何持有 id 的地方（指令队列、存档引用）当场失效。

### 价格必须钳制

```
ratio = clamp(supply / demand, 0.25, 4.0)
price = clamp(lerp(price, base × (1/ratio)^elasticity, 0.15), base × 0.3, base × 3)
```

三层钳制不是保守，是必需：缺货时 `1/ratio` 会趋向无穷，能在一两天内把价格炸到 1e6，然后税收按价格算 → 无限金币。

## 系统执行顺序（写死）

```
0. aggregate   派生统计（住房/岗位），只读
1. production  生产（输入不足按比例缩产）
2. consumption 人口吃粮
3. logistics   运输（T16 未接入，空实现）
4. market      价格
5. population  人口迁移
6. tax         税收（月末）
7. maintenance 维护费（月末）
8. events      阈值事件（只观测，不改状态）
```

改顺序等于改玩法：生产在消费前，是因为「本日产出参与本日消耗」，否则前期体验永远是「田建好了还是饿死」。

## 边界

**能改世界的只有 `applyCommand`。** 没有 `addBuildingDirect` 之类的后门 —— 一旦有，回放与撤销就一定会在某个补丁里失效。

```ts
eco.applyCommand({ type: 'place-building', city: 0, tile: 12, def: house });
eco.applyCommand({ type: 'remove-building', id: house });
eco.applyCommand({ type: 'set-tax', city: 0, rate: 0.12 });
eco.applyCommand({ type: 'deposit', city: 0, amount: 200 });
```

被拒绝的指令返回 `false`，原因通过 `warning` 事件发出（`insufficient-funds` / `occupied` / `not-buildable` / …）。

走指令路径也需要实体 id 的话，监听 `building-placed` 事件。

## 与地形的接口

经济层不知道地形长什么样，只问三个问题：

```ts
eco.setTerrain({
  isBuildable: (tile) => true,
  isUnderwater: (tile) => false,
  slope: (tile) => 0,
});
```

**单向**：经济层永远不直接改地形。要改必须发指令，由外部消费。回放、撤销、多人同步全都依赖「同一份指令序列产生同一结果」。

## 存档

```ts
const bytes = eco.save();   // Uint8Array，100 个建筑约 3KB
eco.load(bytes);
```

二进制容器（magic + 版本 + JSON header + 各字段原始 buffer），不是 JSON。

`JSON.stringify(Float32Array)` 会得到 `{"0":1.5,"1":2}`，体积约 10 倍且读回来是对象不是数组。10k 实体 × 8 资源，二进制 320KB，JSON 版本 3~4MB。

## 性能

实测（Node 22，单核，720 游戏日取均值）：

| 建筑数 | 日 tick 耗时 | 预算 |
| --- | --- | --- |
| 1,000 | 0.035 ms | ≤ 0.3 ms |
| 10,000 | 0.266 ms | ≤ 1 ms |
| 50,000 | 1.413 ms | ≤ 2 ms |

```bash
pnpm --filter @tabby/economy build
pnpm --filter @tabby/economy test    # 19 项
node packages/economy/tools/bench.mjs
```

分帧摊销尚未实现：50k 实测在预算内，钩子（预分配 scratch + 单遍聚合）已就位，超了再拆。

## 已知限制

- **物流步骤是空实现**。T16 接入后由物流系统改写 `buildingEfficiency`。故意不写占位逻辑 —— 假逻辑一旦被测试依赖，接真模块时会被当既有行为保留。
- **多格建筑只校验主格**。经济层不知道 tile 的行列宽度，跨格占位必须由摆放预览（上层）负责。
- **资源种类固定 8 槽位**。当前用 4 种，加种类不用改存档布局，但超过 8 需要升存档版本。
