/**
 * 城市仿真的「可调参数」清单 —— 玩法侧实现。
 *
 * ## 为什么 spec 和 read/write 分在两边
 *
 * `@tabby/ui` 的 `KnobPanel` 负责「滑块怎么表现、写不进怎么办」，
 * 这一侧负责「这个世界的哪个字段对应哪个 id」。UI 包因此不需要认识经济层。
 *
 * ## 为什么 `write` 还要自己判断一次成功
 *
 * `KnobPanel.apply` 会在写完之后回读，但有些失败是**静默**的：
 * `setSpeed(4)` 不会抛错，也不会返回 false，它只是可能被内核钳成 2。
 * 所以这里能明确判断的就明确判断，判断不了的交给回读兜底 —— 两层都留着。
 *
 * ## 为什么值都是数字而不是枚举
 *
 * 速度有 ×1/×2/×4 三档，但它本质是一个 scale。统一成数字后，
 * 面板只需一种控件，而且「以后加 ×8」不用改 UI。
 */

import { KnobPanel, type KnobHost, type KnobSpec } from '@tabby/ui';
import type { CitySimulation } from './simulation.js';

/** 旋钮 id 收口在这里，UI 与实现引用同一份常量，就不会因为拼错字符串而静默失效。 */
export const KnobIds = {
  speed: 'speed',
  msPerDay: 'msPerDay',
  taxRate: 'taxRate',
  roadFree: 'roadFree',
  roadZero: 'roadZero',
  irrigation: 'irrigation',
} as const;

export type KnobId = (typeof KnobIds)[keyof typeof KnobIds];

export const CITY_KNOBS: readonly KnobSpec[] = [
  {
    id: KnobIds.speed,
    label: '时间倍速',
    min: 1,
    max: 4,
    step: 1,
    format: (v) => `×${v}`,
    hint: '加速靠多跑 tick，不放大 dt —— 否则 x4 的世界会慢慢偏离 x1，回放失效',
  },
  {
    id: KnobIds.msPerDay,
    label: '一天时长',
    min: 100,
    max: 3000,
    step: 100,
    format: (v) => `${v} ms`,
    hint: '越短经济结算越频繁；低于 ~120ms 时单帧要跑多个日 tick，HUD 数字会跳得看不清',
  },
  {
    id: KnobIds.taxRate,
    label: '税率',
    min: 0,
    max: 0.6,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
    hint: '越高税收越多，但满意度掉得快；上限 0.6 是内核硬钳制（防负税收）',
  },
  {
    id: KnobIds.roadFree,
    label: '物流免惩罚距离',
    min: 0,
    max: 16,
    step: 1,
    format: (v) => `${v} 格`,
    hint: '这个距离内不扣产出。调小会让「离市政厅远」立刻变得要命',
  },
  {
    id: KnobIds.roadZero,
    label: '物流归零距离',
    min: 4,
    max: 40,
    step: 1,
    format: (v) => `${v} 格`,
    hint: '到这个距离效率归 0。网格最大曼哈顿距离是 16，调小到 16 以下会让墙角直接断供',
  },
  {
    id: KnobIds.irrigation,
    label: '灌溉折算',
    min: 5,
    max: 60,
    step: 5,
    format: (v) => `${v} 单位水 → 1 笔`,
    hint: '每多少单位吸收水量折算一次收益。调小等于直接印钱，玩法会塌',
  },
];

/** 把 `CitySimulation` 的门面接到 `KnobHost` 上。 */
export class CityKnobHost implements KnobHost {
  private readonly sim: CitySimulation;

  constructor(sim: CitySimulation) {
    this.sim = sim;
  }

  read(id: string): number | null {
    switch (id) {
      case KnobIds.speed:
        return this.sim.economy.speed;
      case KnobIds.msPerDay:
        return this.sim.economy.msPerDay;
      case KnobIds.taxRate:
        return this.sim.economy.getCity(this.sim.city)?.taxRate ?? 0;
      case KnobIds.roadFree:
        return this.sim.roads.logistics.curve.freeDistance;
      case KnobIds.roadZero:
        return this.sim.roads.logistics.curve.zeroDistance;
      case KnobIds.irrigation:
        return this.sim.irrigationUnit;
      default:
        return null;
    }
  }

  write(id: string, value: number): boolean {
    switch (id) {
      case KnobIds.speed: {
        const speed = value >= 4 ? 4 : value >= 2 ? 2 : 1;
        this.sim.setSpeed(speed);
        return this.sim.economy.speed === speed;
      }
      case KnobIds.msPerDay:
        this.sim.economy.setMsPerDay(value);
        return true;
      case KnobIds.taxRate:
        return this.sim.economy.applyCommand({ type: 'set-tax', city: this.sim.city, rate: value });
      case KnobIds.roadFree: {
        const curve = this.sim.roads.logistics.curve;
        this.sim.roads.logistics.setCurve(value, curve.zeroDistance);
        return this.sim.roads.logistics.curve.freeDistance === value;
      }
      case KnobIds.roadZero: {
        const curve = this.sim.roads.logistics.curve;
        this.sim.roads.logistics.setCurve(curve.freeDistance, value);
        return this.sim.roads.logistics.curve.zeroDistance === value;
      }
      case KnobIds.irrigation:
        this.sim.setIrrigationUnit(value);
        return this.sim.irrigationUnit === value;
      default:
        return false;
    }
  }
}

/** 一步到位：给一个仿真实例，拿一个能直接绑 UI 的面板。 */
export function createCityKnobPanel(sim: CitySimulation): KnobPanel {
  return new KnobPanel(CITY_KNOBS, new CityKnobHost(sim));
}
