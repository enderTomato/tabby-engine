import type { QualityProfile } from '@tabby/platform';

export interface GovernorOptions {
  /** 连续超预算多少帧后降一级。 */
  readonly streakLimit: number;
  /** 最多降几级（避免无限降到不可用）。 */
  readonly maxLevel: number;
}

/**
 * 自适应画质governor。
 *
 * 判据用「连续超预算帧数」而不是单帧尖峰：Android 上 GC、通知栏下拉、
 * 输入法弹出都会产生单帧 40ms+ 的尖刺，按尖峰降级会误伤。
 * 连续超预算说明是稳态负载问题，才值得动画质。
 */
export class AdaptiveGovernor {
  private level = 0;
  private overFrames = 0;
  private readonly options: GovernorOptions;

  constructor(options: GovernorOptions = { streakLimit: 45, maxLevel: 3 }) {
    this.options = options;
  }

  get currentLevel(): number {
    return this.level;
  }

  reset(): void {
    this.level = 0;
    this.overFrames = 0;
  }

  /** 返回降级后的新档位；不降级返回 null。 */
  sample(cpuMs: number, profile: QualityProfile): QualityProfile | null {
    if (cpuMs <= profile.cpuBudgetMs) {
      this.overFrames = 0;
      return null;
    }
    this.overFrames += 1;
    if (this.overFrames < this.options.streakLimit) return null;
    if (this.level >= this.options.maxLevel) return null;
    this.level += 1;
    this.overFrames = 0;
    return applyLevel(profile, this.level);
  }
}

const REASONS = [
  '',
  '降低渲染分辨率与像素比',
  '进一步降低分辨率，关闭抗锯齿',
  '降到最低画质（关闭阴影与 MSAA）',
] as const;

export function levelReason(level: number): string {
  return REASONS[Math.min(level, REASONS.length - 1)] ?? '降级';
}

export function applyLevel(profile: QualityProfile, level: number): QualityProfile {
  switch (level) {
    case 1:
      return {
        ...profile,
        renderScale: Math.max(0.5, profile.renderScale * 0.82),
        maxPixelRatio: Math.min(profile.maxPixelRatio, 1.5),
      };
    case 2:
      return {
        ...profile,
        renderScale: Math.max(0.5, profile.renderScale * 0.7),
        maxPixelRatio: 1,
        antialias: false,
        shadowQuality: profile.shadowQuality === 'high' ? 'low' : 'off',
      };
    default:
      return {
        ...profile,
        renderScale: 0.5,
        maxPixelRatio: 1,
        antialias: false,
        shadowQuality: 'off',
        smokeParticles: Math.floor(profile.smokeParticles * 0.6),
      };
  }
}
