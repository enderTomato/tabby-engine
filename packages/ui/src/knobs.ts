/**
 * 调参面板的「旋钮」核心 —— 框架无关。
 *
 * ## 为什么单独抽出来
 *
 * 调参面板最容易腐化成「改了没反应」的假面板 —— 界面上有滑块，绑的却是
 * 一个没人读的字段。这里的做法是：**每个旋钮写完之后都要回读世界确认**，
 * 读不到就不给滑块，写不进就弹回真实值并在面板上说明原因。
 *
 * 于是这个文件同时是一份「哪些参数是运行时可改的」清单。
 *
 * ## 为什么值都是数字而不是枚举
 *
 * 速度有 ×1/×2/×4 三档，但它本质是一个 scale。统一成数字后，
 * 面板只需一种控件，而且「以后加 ×8」不用改 UI。
 *
 * ## 为什么世界侧只暴露 read/write
 *
 * 这个包不认识经济层、不认识物流曲线，也不该认识。
 * `KnobHost` 是一个只有一个读写口的门面，谁实现它谁负责把 `id` 翻译成真实字段。
 * 好处是拆包时不用给 UI 反向依赖，坏处是 `id` 变成字符串 ——
 * 靠 `KNOB_IDS` 常量收口，两边引用同一份常量就不会写错。
 */

/** 旋钮定义：只有长相和取值范围，不包含任何取值逻辑。 */
export interface KnobSpec {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 展示用格式化（百分号、毫秒、金币…）。 */
  readonly format: (value: number) => string;
  /** 一句话说明「调大之后会发生什么」。面板上直接显示，免得调参的人猜。 */
  readonly hint: string;
}

/**
 * 世界侧的读写门面。
 *
 * `read` 返回 `null` 表示「这个世界没有这个参数」—— 面板会直接不显示该旋钮。
 * `write` 返回 `false` 表示写失败 —— 面板会把滑块弹回真实值。
 */
export interface KnobHost {
  read(id: string): number | null;
  write(id: string, value: number): boolean;
}

/** `apply` 的结果，给 UI 决定要不要提示。 */
export interface KnobApplyResult {
  readonly ok: boolean;
  /** 世界的真实值（无论成功失败都以这个为准）。 */
  readonly actual: number;
  /** 失败原因，成功时为空串。 */
  readonly reason: string;
}

/** step 的小数位数，用来把吸附后的浮点尾巴切掉（0.01 的 3 倍不该是 0.030000000000000002）。 */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** 把任意值吸附到「以 min 为原点、step 为间距」的格点上，并夹到 [min, max]。 */
export function snapToStep(spec: Pick<KnobSpec, 'min' | 'max' | 'step'>, value: number): number {
  if (!Number.isFinite(value)) return spec.min;
  if (!Number.isFinite(spec.step) || spec.step <= 0) {
    return Math.min(spec.max, Math.max(spec.min, value));
  }
  const steps = Math.round((value - spec.min) / spec.step);
  const snapped = spec.min + steps * spec.step;
  const clamped = Math.min(spec.max, Math.max(spec.min, snapped));
  const digits = decimalsOf(spec.step);
  return digits > 0 ? Number(clamped.toFixed(digits)) : Math.round(clamped);
}

export class KnobPanel {
  private readonly all: readonly KnobSpec[];
  private readonly host: KnobHost;
  /** 只保留世界确实有这个参数的旋钮。构造时探一次。 */
  private readonly active: KnobSpec[] = [];
  private readonly valueMap: Record<string, number> = {};
  private readonly feedbackMap: Record<string, string> = {};

  constructor(specs: readonly KnobSpec[], host: KnobHost) {
    this.all = specs;
    this.host = host;
    for (const spec of specs) {
      const value = host.read(spec.id);
      if (value === null || !Number.isFinite(value)) continue;
      this.active.push(spec);
      // 世界的值可能不在格点上（比如 msPerDay 被别处改成 250），照原样显示，不擅自吸附
      this.valueMap[spec.id] = value;
      this.feedbackMap[spec.id] = '';
    }
  }

  /** 可用的旋钮（已剔除世界不认识的）。 */
  get specs(): readonly KnobSpec[] {
    return this.active;
  }

  /** 定义里有、但这个世界没实现的旋钮 id —— 诊断面板用来报「少接了什么」。 */
  get missing(): readonly string[] {
    return this.all.filter((spec) => !this.active.includes(spec)).map((spec) => spec.id);
  }

  /** 当前显示的值。Vue 直接 `reactive` 包这个对象即可。 */
  get values(): Readonly<Record<string, number>> {
    return this.valueMap;
  }

  /** 每个旋钮的最近一次失败原因（空串表示正常）。 */
  get feedback(): Readonly<Record<string, string>> {
    return this.feedbackMap;
  }

  read(id: string): number | null {
    const value = this.host.read(id);
    if (value !== null && Number.isFinite(value)) this.valueMap[id] = value;
    return value;
  }

  /**
   * 写入并回读确认。
   *
   * 顺序很重要：**先写、再回读、最后用回读结果覆盖滑块**。
   * 若先假定成功再更新 UI，一旦世界拒收（比如内核硬钳制税率上限），
   * 面板就会显示一个世界里不存在的值 —— 这正是「假面板」的成因。
   */
  apply(id: string, rawValue: number): KnobApplyResult {
    const spec = this.specOf(id);
    if (spec === null) {
      return { ok: false, actual: this.valueMap[id] ?? 0, reason: `未知旋钮 ${id}` };
    }
    const target = snapToStep(spec, rawValue);
    let accepted = false;
    try {
      accepted = this.host.write(id, target);
    } catch (error) {
      this.feedbackMap[id] = `写入抛错：${error instanceof Error ? error.message : String(error)}`;
      const actual = this.host.read(id) ?? target;
      this.valueMap[id] = actual;
      return { ok: false, actual, reason: this.feedbackMap[id] as string };
    }
    // 无论 write 返回什么，都以回读为准 —— write 说是成功但世界没变的情况真会发生
    const actual = this.host.read(id);
    if (actual === null) {
      this.feedbackMap[id] = '写完之后读不回来了';
      return { ok: false, actual: target, reason: this.feedbackMap[id] as string };
    }
    this.valueMap[id] = actual;
    if (!accepted) {
      this.feedbackMap[id] = `世界拒收（可能被内核钳制）`;
      return { ok: false, actual, reason: this.feedbackMap[id] as string };
    }
    if (Math.abs(actual - target) > spec.step * 0.5 + 1e-9) {
      this.feedbackMap[id] = `写入 ${spec.format(target)} 但世界是 ${spec.format(actual)}`;
      return { ok: false, actual, reason: this.feedbackMap[id] as string };
    }
    this.feedbackMap[id] = '';
    return { ok: true, actual, reason: '' };
  }

  /**
   * 全量对齐一次。
   *
   * 10Hz 调一次即可：世界可能被别的路径改了（读档、热重载配置表、脚本），
   * 不定期对齐就会看到滑块停在旧值上撒谎。返回是否有值变化。
   */
  refresh(): boolean {
    let changed = false;
    for (const spec of this.active) {
      const value = this.host.read(spec.id);
      if (value === null || !Number.isFinite(value)) continue;
      if (this.valueMap[spec.id] !== value) {
        this.valueMap[spec.id] = value;
        changed = true;
        // 世界自己变了，上一次的失败原因就不作数了
        this.feedbackMap[spec.id] = '';
      }
    }
    return changed;
  }

  private specOf(id: string): KnobSpec | null {
    for (const spec of this.active) {
      if (spec.id === id) return spec;
    }
    return null;
  }
}
