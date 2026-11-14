import { performance } from 'node:perf_hooks';
import { Economy, DEFAULT_BUILDINGS, buildingIndexOf } from '../dist/index.js';

const HOUSE = buildingIndexOf(DEFAULT_BUILDINGS, 'house');
const FARM = buildingIndexOf(DEFAULT_BUILDINGS, 'farm');
const POWER = buildingIndexOf(DEFAULT_BUILDINGS, 'powerplant');
const FACTORY = buildingIndexOf(DEFAULT_BUILDINGS, 'factory');

const DAYS = 720;
const CITIES = 1;

function bench(count) {
  const eco = new Economy({ entityCapacity: count + 16, cityCount: CITIES, seed: 7 });
  eco.init({ population: [Math.floor(count * 0.8)], treasury: [10_000_000], stock: [[1000, 1000, 1000, 1000]] });

  // 4:1:1:1 的房屋/农田/电站/工厂配比，接近真实城市
  for (let i = 0; i < count; i += 1) {
    const r = i % 7;
    const def = r < 4 ? HOUSE : r === 4 ? FARM : r === 5 ? POWER : FACTORY;
    eco.placeBuilding(0, i, def);
  }

  // 预热：让 JIT 稳定下来，否则前 20 天全是解释执行
  eco.tickDays(30);

  const t0 = performance.now();
  eco.tickDays(DAYS);
  const total = performance.now() - t0;
  const diag = eco.getDiagnostics();
  return {
    count,
    perDay: total / DAYS,
    total,
    pop: diag.totalPopulation,
    treasury: diag.moneySupply,
    gdp: Math.round(diag.gdp),
    prices: diag.prices.map((p) => Math.round(p * 100) / 100),
  };
}

console.log(`日 tick 预算：1k ≤ 0.3ms / 10k ≤ 1ms / 50k ≤ 2ms（且需分帧摊销）\n`);
for (const n of [1000, 10000, 50000]) {
  const r = bench(n);
  const ok = n === 1000 ? r.perDay <= 0.3 : n === 10000 ? r.perDay <= 1 : r.perDay <= 2;
  console.log(
    `${String(n).padStart(6)} 建筑  ${r.perDay.toFixed(3)} ms/日  ${ok ? 'OK ' : 'OVER'}  ` +
      `人口 ${Math.round(r.pop)}  金库 ${r.treasury}  GDP ${r.gdp}  价 ${r.prices.join('/')}`,
  );
}
