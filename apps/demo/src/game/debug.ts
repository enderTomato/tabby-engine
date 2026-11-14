/**
 * 调参面板的「可调项」定义。
 *
 * ## 为什么单独抽一个文件
 *
 * 调参面板最容易腐化成「改了没反应」的假面板 —— 界面上有滑块，绑的却是
 * 一个没人读的字段。这里的做法是：**每个旋钮都必须实现 `apply` 且真的写到世界里**，
 * 写不到就干脆不给旋钮。
 *
 * 于是这个文件同时是一份「哪些参数是运行时可改的」清单，诊断面板也直接读它。
 *
 * ## 为什么值都是数字而不是枚举
 *
 * 速度有 ×1/×2/×4 三档，但它本质是一个 scale。统一成数字后，
 * 面板只需一种控件，而且「以后加 ×8」不用改 UI。
 */

import type { CitySimulation } from './simulation';

export interface Knob {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 展示用格式化（百分号、毫秒、金币…）。 */
  readonly format: (value: number) => string;
  /** 一句话说明「调大之后会发生什么」。面板上直接显示，免得调参的人猜。 */
  readonly hint: string;
  /** 从当前世界读出真实值（不要存第二份，否则读档后面板会撒谎）。 */
  readonly read: (sim: CitySimulation) => number;
  /** 写回世界。返回是否真的生效。 */
  readonly write: (sim: CitySimulation, value: number) => boolean;
}

export const KNOBS: readonly Knob[] = [
  {
    id: 'speed',
    label: '时间倍速',
    min: 1,
    max: 4,
    step: 1,
    format: (v) => `×${v}`,
    hint: '加速靠多跑 tick，不放大 dt —— 否则 x4 的世界会慢慢偏离 x1，回放失效',
    read: (sim) => sim.economy.speed,
    write: (sim, v) => {
      const speed = v >= 4 ? 4 : v >= 2 ? 2 : 1;
      sim.setSpeed(speed);
      return sim.economy.speed === speed;
    },
  },
  {
    id: 'msPerDay',
    label: '一天时长',
    min: 100,
    max: 3000,
    step: 100,
    format: (v) => `${v} ms`,
    hint: '越短经济结算越频繁；低于 ~120ms 时单帧要跑多个日 tick，HUD 数字会跳得看不清',
    read: (sim) => sim.economy.msPerDay,
    write: (sim, v) => {
      sim.economy.setMsPerDay(v);
      return true;
    },
  },
  {
    id: 'taxRate',
    label: '税率',
    min: 0,
    max: 0.6,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
    hint: '越高税收越多，但满意度掉得快；上限 0.6 是内核硬钳制（防负税收）',
    read: (sim) => sim.economy.getCity(sim.city)?.taxRate ?? 0,
    write: (sim, v) => sim.economy.applyCommand({ type: 'set-tax', city: sim.city, rate: v }),
  },
  {
    id: 'roadFree',
    label: '物流免惩罚距离',
    min: 0,
    max: 16,
    step: 1,
    format: (v) => `${v} 格`,
    hint: '这个距离内不扣产出。调小会让「离市政厅远」立刻变得要命',
    read: (sim) => sim.roads.logistics.curve.freeDistance,
    write: (sim, v) => {
      const curve = sim.roads.logistics.curve;
      sim.roads.logistics.setCurve(v, curve.zeroDistance);
      return sim.roads.logistics.curve.freeDistance === v;
    },
  },
  {
    id: 'roadZero',
    label: '物流归零距离',
    min: 4,
    max: 40,
    step: 1,
    format: (v) => `${v} 格`,
    hint: '到这个距离效率归 0。网格最大曼哈顿距离是 16，调小到 16 以下会让墙角直接断供',
    read: (sim) => sim.roads.logistics.curve.zeroDistance,
    write: (sim, v) => {
      const curve = sim.roads.logistics.curve;
      sim.roads.logistics.setCurve(curve.freeDistance, v);
      return sim.roads.logistics.curve.zeroDistance === v;
    },
  },
  {
    id: 'irrigation',
    label: '灌溉折算',
    min: 5,
    max: 60,
    step: 5,
    format: (v) => `${v} 单位水 → 1 笔`,
    hint: '每多少单位吸收水量折算一次收益。调小等于直接印钱，玩法会塌',
    read: (sim) => sim.irrigationUnit,
    write: (sim, v) => {
      sim.setIrrigationUnit(v);
      return sim.irrigationUnit === v;
    },
  },
];

export function knobById(id: string): Knob | null {
  for (const knob of KNOBS) {
    if (knob.id === id) return knob;
  }
  return null;
}
