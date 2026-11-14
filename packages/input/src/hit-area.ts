import { MIN_TOUCH_TARGET } from './types.js';

/**
 * 可点区域。
 *
 * 用矩形而不是回调，是为了让「命中测试」可以离线批量算：
 * 一个 HUD 上几十个按钮，每帧都要判一次，闭包调用 + 边界检查的成本不可忽略。
 */
export interface HitArea {
  readonly id: string;
  /** 左上角（CSS 像素）。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * 是否允许把热区扩到 44×44。
   *
   * 图标类按钮要扩（视觉小但要点得中），地图格子不能扩（扩了会盖住隔壁格子，
   * 于是「点 A 建到 B 上」）。默认 true。
   */
  readonly expandable?: boolean;
  /** 层级。重叠时取 `z` 大的，相同则取声明顺序靠后的（后画的在上面）。 */
  readonly z?: number;
}

export interface HitResult {
  readonly id: string;
  /** 命中点相对区域中心的换算后的坐标，可直接用于视觉反馈。 */
  readonly localX: number;
  readonly localY: number;
}

/**
 * 把热区扩展到至少 44×44（CSS 像素），中心不变。
 *
 * **为什么要向上取整到整数像素**：DPR 不是整数（安卓常见 2.625、2.75）时，
 * 44 CSS 像素 = 115.5 设备像素。若不取整，命中判定与绘制会各自四舍五入到不同的像素，
 * 边缘 1px 上出现「看得见但点不中」。这类问题在 DPR=1 的桌面上永远复现不了。
 */
export function expandHitArea(area: HitArea): HitArea {
  if (area.expandable === false) return area;
  const width = Math.max(Math.ceil(area.width), MIN_TOUCH_TARGET);
  const height = Math.max(Math.ceil(area.height), MIN_TOUCH_TARGET);
  if (width === area.width && height === area.height) return area;
  return {
    ...area,
    // 保持中心不变：向四周均摊，否则按钮会「往右下角长大」
    x: area.x - (width - area.width) / 2,
    y: area.y - (height - area.height) / 2,
    width,
    height,
  };
}

/** 命中测试。返回 null 表示没点到任何区域。 */
export function hitTest(areas: readonly HitArea[], x: number, y: number): HitResult | null {
  let best: HitArea | null = null;
  let bestIndex = -1;
  for (let i = 0; i < areas.length; i += 1) {
    const raw = areas[i] as HitArea;
    const area = expandHitArea(raw);
    if (x < area.x || y < area.y || x > area.x + area.width || y > area.y + area.height) continue;
    const z = area.z ?? 0;
    const bestZ = best === null ? Number.NEGATIVE_INFINITY : (best.z ?? 0);
    // 先比 z，再比声明顺序（数组靠后 = 后画 = 在上层）
    if (best === null || z > bestZ || (z === bestZ && i > bestIndex)) {
      best = area;
      bestIndex = i;
    }
  }
  if (best === null) return null;
  return {
    id: best.id,
    localX: x - best.x,
    localY: y - best.y,
  };
}

/**
 * 把一批格子转成热区。
 *
 * 格子默认 `expandable: false` —— 见 `HitArea.expandable` 的注释。
 */
export function gridHitAreas(
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  originX = 0,
  originY = 0,
  prefix = 'cell-',
): HitArea[] {
  const areas: HitArea[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      areas.push({
        id: `${prefix}${col}-${row}`,
        x: originX + col * cellWidth,
        y: originY + row * cellHeight,
        width: cellWidth,
        height: cellHeight,
        expandable: false,
      });
    }
  }
  return areas;
}
