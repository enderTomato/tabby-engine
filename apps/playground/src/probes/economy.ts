/**
 * 探针：经济内核。
 *
 * 这一层最容易「看起来对、实际不对」的地方是**确定性**：
 * 同一个种子、同一组建造指令，跑 200 天后人口必须完全一致。
 * 一旦有任何一处依赖 `Object.keys` 顺序、`Map` 遍历序或真实时钟，
 * 服务端权威模拟与客户端预测就会分叉，表现为「玩家看到的钱和服务器不一样」。
 *
 * 所以本探针给三样东西：
 *
 * 1. **曲线**：人口 / 金库 / 食物库存 / 满意度 随时间的关系，看得见才有判断力。
 * 2. **断供对照**：把农田的物流效率打到 0，看产出与价格怎么反应
 *    （这不是「产量减少」这么简单 —— 价格会沿弹性曲线反推）。
 * 3. **确定性自检**：两个独立 `Economy` 跑同样的天数，逐字段比对。
 */

import { DEFAULT_BUILDINGS, Economy, Resource, buildingIndexOf } from '@tabby/economy';
import { addButton, addRow, makeControls, makeOverlay } from './shared.js';
import { ms, Timing, type BenchResult, type Probe } from '../types.js';

const DAYS_WINDOW = 200;
const DEF = {
  house: buildingIndexOf(DEFAULT_BUILDINGS, 'house'),
  farm: buildingIndexOf(DEFAULT_BUILDINGS, 'farm'),
  sawmill: buildingIndexOf(DEFAULT_BUILDINGS, 'sawmill'),
  factory: buildingIndexOf(DEFAULT_BUILDINGS, 'factory'),
  powerplant: buildingIndexOf(DEFAULT_BUILDINGS, 'powerplant'),
};

interface Sample {
  readonly day: number;
  readonly population: number;
  readonly treasury: number;
  readonly food: number;
  readonly satisfaction: number;
  readonly power: number;
}

/** 一座初始小城：人口要住、农田要吃电、伐木与工厂各一条链。 */
function seedCity(economy: Economy, scale = 1): void {
  let tile = 0;
  const place = (defIndex: number, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      economy.placeBuilding(0, tile, defIndex);
      tile += 1;
    }
  };
  place(DEF.powerplant, 1 * scale);
  place(DEF.farm, 3 * scale);
  place(DEF.sawmill, 2 * scale);
  place(DEF.factory, 1 * scale);
  place(DEF.house, 5 * scale);
}

export function createEconomyProbe(): Probe {
  let canvas: HTMLCanvasElement | null = null;
  let g2d: CanvasRenderingContext2D | null = null;
  let economy: Economy | null = null;
  let samples: Sample[] = [];
  let blockedFarm = false;
  let rowDay: HTMLSpanElement | null = null;
  let rowPop: HTMLSpanElement | null = null;
  let rowMoney: HTMLSpanElement | null = null;
  let rowFood: HTMLSpanElement | null = null;
  let rowSat: HTMLSpanElement | null = null;
  let rowPrice: HTMLSpanElement | null = null;
  let rowDeterminism: HTMLSpanElement | null = null;
  const dayTiming = new Timing(90);

  /** 断供开关：只有农田受影响，用来观察「局部停产」不会拖垮整条链。 */
  const logistics = {
    efficiencyOf: (_buildingId: number, _city: number): number => (blockedFarm ? 0.05 : 1),
  };

  function build(): void {
    economy = new Economy({
      cityCount: 1,
      entityCapacity: 1024,
      taxRate: 0.12,
      clock: () => performance.now(),
      logistics,
    });
    economy.init({ treasury: [3000], population: [24], stock: [[40, 20, 10, 20]] });
    seedCity(economy);
    samples = [];
    record(0);
  }

  function record(day: number): void {
    if (economy === null) return;
    const city = economy.getCity(0);
    samples.push({
      day,
      population: city?.population ?? 0,
      treasury: city?.treasury ?? 0,
      food: economy.state.stockOf(0, Resource.Food),
      satisfaction: city?.satisfaction ?? 0,
      power: economy.state.stockOf(0, Resource.Power),
    });
    if (samples.length > DAYS_WINDOW) samples.shift();
  }

  function stepDays(days: number): void {
    if (economy === null) return;
    for (let i = 0; i < days; i += 1) {
      const started = performance.now();
      economy.tickDays(1);
      dayTiming.push(performance.now() - started);
      record((economy.getDiagnostics().day));
    }
  }

  function resize(): void {
    if (canvas === null) return;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round((canvas.clientWidth || 480) * dpr));
    canvas.height = Math.max(1, Math.round((canvas.clientHeight || 320) * dpr));
    g2d = canvas.getContext('2d');
  }

  return {
    id: 'economy',
    title: '经济内核',
    summary: '固定种子的日结算；断供会影响价格而不只是产量，同种子跑两百天必须逐字段一致',
    group: '系统',

    mount(context) {
      canvas = document.createElement('canvas');
      context.host.appendChild(canvas);
      resize();
      blockedFarm = false;
      // 定义表换了名字时 `buildingIndexOf` 会返回 -1，`placeBuilding` 会一路静默拒绝，
      // 于是画面变成「什么都没有但也不报错」。这里直接拦一下。
      const missing = Object.entries(DEF).filter(([, index]) => index < 0).map(([key]) => key);
      if (missing.length > 0) {
        context.log(`定义表缺少建筑：${missing.join(', ')} —— 探针无法组城`);
        return;
      }
      build();

      const overlay = makeOverlay(context.host, '经济内核');
      rowDay = addRow(overlay, '日期');
      rowPop = addRow(overlay, '人口');
      rowMoney = addRow(overlay, '金库');
      rowFood = addRow(overlay, '食物库存');
      rowSat = addRow(overlay, '满意度');
      rowPrice = addRow(overlay, '食物价 / 目标');
      rowDeterminism = addRow(overlay, '确定性');

      const controls = makeControls(context.host);
      addButton(controls, '跑 30 天', () => {
        stepDays(30);
        context.log(`推进 30 天 → 第 ${economy?.getDiagnostics().day ?? 0} 天`);
      });
      addButton(controls, '跑 200 天', () => {
        stepDays(200);
        context.log(`推进 200 天 → 第 ${economy?.getDiagnostics().day ?? 0} 天`);
      });
      const blockBtn = addButton(controls, '断供农田', () => {
        blockedFarm = !blockedFarm;
        blockBtn.textContent = blockedFarm ? '恢复供给' : '断供农田';
        blockBtn.classList.toggle('on', blockedFarm);
        context.log(blockedFarm ? '农田效率 → 5%，观察食物与价格' : '供给已恢复');
      });
      void blockBtn;
      addButton(controls, '重新开局', () => {
        build();
        context.log('已重置到第 0 天');
      });
      addButton(controls, '验确定性', () => {
        const result = checkDeterminism();
        if (rowDeterminism !== null) {
          rowDeterminism.textContent = result.ok ? '一致 ✓' : `不一致 ✗ ${result.field}`;
          rowDeterminism.style.color = result.ok ? 'var(--good)' : 'var(--bad)';
        }
        context.log(
          result.ok
            ? `确定性：两局各跑 ${result.days} 天，人口/金库/库存逐字段相同`
            : `确定性失败：${result.field} 不同（${result.left} vs ${result.right}）`,
        );
      });
      context.log('初始：1 电站 / 3 农田 / 2 伐木场 / 1 工厂 / 5 住宅，金库 3000');
    },

    unmount() {
      canvas?.remove();
      canvas = null;
      g2d = null;
      economy = null;
      samples = [];
    },

    tick() {
      if (canvas === null || g2d === null || economy === null) return;
      const ctx2d = g2d;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.fillStyle = '#06080d';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      ctx2d.scale(dpr, dpr);

      const padLeft = 46;
      const padBottom = 26;
      const padTop = 16;
      const chartW = Math.max(10, w - padLeft - 16);
      const chartH = Math.max(10, h - padTop - padBottom);

      ctx2d.strokeStyle = 'rgba(110,199,255,0.10)';
      ctx2d.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = padTop + (chartH * i) / 4;
        ctx2d.beginPath();
        ctx2d.moveTo(padLeft, y);
        ctx2d.lineTo(padLeft + chartW, y);
        ctx2d.stroke();
      }

      if (samples.length >= 2) {
        const series: { color: string; pick: (s: Sample) => number; label: string }[] = [
          { color: '#6ec7ff', pick: (s) => s.population, label: '人口' },
          { color: '#ffd166', pick: (s) => s.treasury, label: '金库' },
          { color: '#7ee787', pick: (s) => s.food, label: '食物' },
          { color: '#ff9bd2', pick: (s) => s.satisfaction * 100, label: '满意度×100' },
        ];
        // 每条序列独立归一化：金库是四位数、满意度是 0..1，
        // 共用一根轴的话后者会被压成一条直线，什么都看不出来
        for (const item of series) {
          let min = Infinity;
          let max = -Infinity;
          for (const sample of samples) {
            const value = item.pick(sample);
            if (value < min) min = value;
            if (value > max) max = value;
          }
          if (!Number.isFinite(min) || max - min < 1e-6) continue;
          ctx2d.strokeStyle = item.color;
          ctx2d.lineWidth = 1.8;
          ctx2d.beginPath();
          for (let i = 0; i < samples.length; i += 1) {
            const sample = samples[i] as Sample;
            const x = padLeft + (chartW * i) / (samples.length - 1);
            const y = padTop + chartH * (1 - (item.pick(sample) - min) / (max - min));
            if (i === 0) ctx2d.moveTo(x, y);
            else ctx2d.lineTo(x, y);
          }
          ctx2d.stroke();
          const last = samples[samples.length - 1] as Sample;
          const lastY = padTop + chartH * (1 - (item.pick(last) - min) / (max - min));
          ctx2d.fillStyle = item.color;
          ctx2d.font = '10px ui-monospace, monospace';
          ctx2d.fillText(item.label, padLeft + chartW + 2, lastY + 3);
        }
      }

      ctx2d.fillStyle = 'rgba(200,220,240,0.55)';
      ctx2d.font = '10px ui-monospace, monospace';
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (first !== undefined && last !== undefined) {
        ctx2d.fillText(`第 ${first.day} 天`, padLeft, h - 8);
        const label = `第 ${last.day} 天`;
        ctx2d.fillText(label, padLeft + chartW - ctx2d.measureText(label).width, h - 8);
      }

      const diag = economy.getDiagnostics();
      const city = economy.getCity(0);
      if (rowDay !== null) rowDay.textContent = `第 ${diag.day} 天（${diag.year} 年 ${diag.month} 月）`;
      if (rowPop !== null) rowPop.textContent = `${(city?.population ?? 0).toFixed(1)}（住房 ${city?.housing ?? 0}）`;
      if (rowMoney !== null) rowMoney.textContent = `${Math.round(city?.treasury ?? 0)}`;
      if (rowFood !== null) rowFood.textContent = `${(economy.state.stockOf(0, Resource.Food)).toFixed(1)}`;
      if (rowSat !== null) {
        const sat = city?.satisfaction ?? 0;
        rowSat.textContent = `${(sat * 100).toFixed(0)}%${city?.starving === true ? ' 饥荒' : ''}`;
        rowSat.style.color = city?.starving === true ? 'var(--bad)' : '';
      }
      if (rowPrice !== null) {
        // 价格是「库存越少越贵」的弹性曲线，断供后会看到它偏离目标价
        const price = diag.prices[Resource.Food] ?? 0;
        rowPrice.textContent = `${price.toFixed(2)} / ${(economy.resources[Resource.Food]?.basePrice ?? 0).toFixed(2)}`;
      }
    },

    bench(): BenchResult {
      // 规模扫描：日结算成本必须随建筑数接近线性，不能有 O(n²) 隐藏在里面。
      // 一天只有几十微秒，而时钟分辨率约 5µs —— 所以一次跑 60 天再摊薄。
      const DAYS = 60;
      const rows: { count: number; perDay: number }[] = [];
      for (const scale of [1, 4, 12]) {
        const probe = new Economy({ cityCount: 1, entityCapacity: 4096, clock: () => performance.now(), logistics });
        probe.init({ treasury: [1_000_000], population: [50], stock: [[200, 200, 100, 200]] });
        seedCity(probe, scale);
        probe.tickDays(5); // 预热：让价格与满意度进入稳态，避免第一天的冷启动噪声
        const started = performance.now();
        probe.tickDays(DAYS);
        rows.push({ count: probe.getDiagnostics().aliveBuildings, perDay: (performance.now() - started) / DAYS });
      }

      const determinism = checkDeterminism();
      const first = rows[0];
      const last = rows[rows.length - 1];
      const ratio = first !== undefined && last !== undefined && first.perDay > 0 ? last.perDay / first.perDay : 0;
      const buildingRatio =
        first !== undefined && last !== undefined && first.count > 0 ? last.count / first.count : 0;

      return {
        lines: [
          {
            label: '日结算成本',
            value: rows.map((row) => `${row.count}栋 ${ms(row.perDay)}`).join(' / '),
            hint: '各 60 天中位数',
          },
          {
            label: '规模弹性',
            value: `${ratio.toFixed(1)}×`,
            hint: `建筑 ${buildingRatio.toFixed(0)}× 时耗时倍数，接近即为线性`,
          },
          {
            label: '面板日成本',
            value: dayTiming.count === 0 ? '未采样' : ms(dayTiming.median),
            hint: dayTiming.count === 0 ? '点过「跑 N 天」才有数' : `p95 ${ms(dayTiming.p95)}，${dayTiming.count} 天样本`,
          },
          { label: '确定性', value: determinism.ok ? '一致' : `不一致 ${determinism.field}`, hint: `跑 ${determinism.days} 天逐字段比较` },
        ],
      };
    },
  };
}

/**
 * 确定性自检：两局完全一样的开局，各跑 120 天，逐字段比对。
 *
 * 比的是**浮点原值**（`===`），不是「差不多」。若这里给了容差，
 * 那么两局在 1000 天后分叉成两个不同的经济也会被放过去。
 */
function checkDeterminism(): { ok: boolean; field: string; left: string; right: string; days: number } {
  const days = 120;
  const make = (): Economy => {
    const probe = new Economy({ cityCount: 1, entityCapacity: 1024, clock: () => 0 });
    probe.init({ treasury: [3000], population: [24], stock: [[40, 20, 10, 20]] });
    seedCity(probe);
    probe.tickDays(days);
    return probe;
  };
  const a = make();
  const b = make();
  const ca = a.getCity(0);
  const cb = b.getCity(0);
  const pairs: { field: string; left: number; right: number }[] = [
    { field: '人口', left: ca?.population ?? 0, right: cb?.population ?? 0 },
    { field: '金库', left: ca?.treasury ?? 0, right: cb?.treasury ?? 0 },
    { field: '满意度', left: ca?.satisfaction ?? 0, right: cb?.satisfaction ?? 0 },
    { field: '食物', left: a.state.stockOf(0, Resource.Food), right: b.state.stockOf(0, Resource.Food) },
    { field: '木材', left: a.state.stockOf(0, Resource.Wood), right: b.state.stockOf(0, Resource.Wood) },
    { field: '商品', left: a.state.stockOf(0, Resource.Goods), right: b.state.stockOf(0, Resource.Goods) },
    { field: '电力', left: a.state.stockOf(0, Resource.Power), right: b.state.stockOf(0, Resource.Power) },
  ];
  for (const pair of pairs) {
    if (pair.left !== pair.right) {
      return { ok: false, field: pair.field, left: String(pair.left), right: String(pair.right), days };
    }
  }
  return { ok: true, field: '', left: '', right: '', days };
}
