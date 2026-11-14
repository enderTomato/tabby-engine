/**
 * 阴影预算。
 *
 * ## 为什么不做 CSM（级联阴影）
 *
 * CSM 是桌面游戏的标准做法：把视锥按深度切成 4 段，每段一张 shadow map，
 * 近处密远处疏。它在 PC 上几乎免费，在手机上则是纯负收益：
 *
 * - 4 级级联 = **4 次 shadow map 渲染**。场景里每个投影物要画 4 遍，
 *   DrawCall 直接 ×4。Android 的驱动对多 pass 的固定开销比桌面高得多。
 * - 手机屏幕小、可视距离短（我们的雾在 40~80m 就切掉了），
 *   级联想解决的「近处要精细、远处要覆盖」在这个尺度上并不尖锐。
 * - 级联拼接处有可见接缝，要额外做 blend，又是一个采样器 + 一次比较。
 *
 * 替代方案就是这张表的思路：**用预算换档位**。低端直接关掉（有烘好的
 * 顶点色/贴图做明暗就够了），中端一张，高端两张（近处高分辨率 + 远处低分辨率，
 * 相当于「两段固定级联」而不是动态切分）。
 *
 * ## 为什么阴影尺寸要和 DRS 联动
 *
 * 阴影贴图是显存和填充率的固定开销。分辨率降到 0.8 说明 GPU 已经吃紧，
 * 这时还留着一张 1024² 的阴影图，等于让最贵的那个 pass 独占预算。
 * 所以 DRS 掉到 0.85 以下时阴影同步减半 —— 优先保帧率。
 */

import type { QualityProfile } from '@tabby/platform';

export interface ShadowStage {
  /** shadow map 边长（像素）。 */
  readonly mapSize: number;
  /** 正交阴影相机覆盖的半边长（米）。覆盖越大越糊。 */
  readonly extent: number;
  /** 相机近远平面。太远会让深度精度浪费在看不见的地方。 */
  readonly near: number;
  readonly far: number;
}

export interface ShadowPlan {
  readonly enabled: boolean;
  /** 近处一级。`enabled === false` 时为 null。 */
  readonly near: ShadowStage | null;
  /**
   * 远处一级。只有高端档才给 —— 这一级用的是**第二盏平行光**，
   * 不是 CSM 的级联：两盏灯各自独立，没有拼接缝，也没有动态切分。
   */
  readonly far: ShadowStage | null;
  /** 说明文字，直接显示在诊断面板上，省得每次都要读代码才知道为什么关着。 */
  readonly reason: string;
}

/** DRS 低于这个值就认为 GPU 吃紧，阴影跟着降。 */
const PRESSURE_SCALE = 0.85;

export function planShadows(profile: Pick<QualityProfile, 'tier' | 'shadowQuality'>, drsScale = 1): ShadowPlan {
  if (profile.shadowQuality === 'off') {
    return { enabled: false, near: null, far: null, reason: '档位指定关闭阴影' };
  }
  // 低端机即使档位写着 low，也直接关 —— 这里不做「半开」这种选项，
  // 阴影要么有要么没有，半开的观感（只投一部分物体）比重不开更糟
  if (profile.tier === 'low') {
    return { enabled: false, near: null, far: null, reason: '低端档：阴影全关，省一次 shadow pass' };
  }

  const pressured = drsScale < PRESSURE_SCALE;
  const high = profile.tier === 'high' && profile.shadowQuality === 'high';

  if (!high) {
    return {
      enabled: true,
      near: { mapSize: pressured ? 256 : 512, extent: 22, near: 1, far: 60 },
      far: null,
      reason: pressured
        ? `中端档 + DRS ${drsScale.toFixed(2)}：单级 256²`
        : '中端档：单级 512²',
    };
  }

  return {
    enabled: true,
    near: { mapSize: pressured ? 512 : 1024, extent: 18, near: 1, far: 50 },
    far: { mapSize: pressured ? 256 : 512, extent: 60, near: 20, far: 120 },
    reason: pressured
      ? `高端档 + DRS ${drsScale.toFixed(2)}：两级各减半（512²/256²）`
      : '高端档：近 1024² / 远 512²（两盏灯，非 CSM）',
  };
}
