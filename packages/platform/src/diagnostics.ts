import type { PlatformCapabilities } from './capabilities.js';
import { describeProfile, type QualityProfile } from './profiles.js';
import type { TierDecision } from './tier.js';

export type IssueLevel = 'info' | 'warn' | 'error';

export interface DiagnosticIssue {
  readonly level: IssueLevel;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

const COOP_HINT =
  '部署时对 HTML 文档响应加 header：Cross-Origin-Opener-Policy: same-origin 与 ' +
  'Cross-Origin-Embedder-Policy: require-corp（Nginx/Cloudflare/Capacitor 均需配置），否则 SAB 不可用。';

export function diagnose(
  caps: PlatformCapabilities,
  decision: TierDecision,
  profile: QualityProfile,
): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  if (!caps.webgl2) {
    issues.push({
      level: 'error',
      code: 'GL_NO_WEBGL2',
      message: '当前环境无 WebGL2 上下文',
      hint: '引擎以 WebGL2 为基线，仅保留 WebGL1 探测用于提示降级，不提供功能等价实现。',
    });
  }

  if (caps.gpu.software) {
    issues.push({
      level: 'error',
      code: 'GPU_SOFTWARE',
      message: `检测到软件光栅化：${caps.gpu.renderer}`,
      hint: '模拟器/远程桌面/GPU 被禁用时出现，物理与渲染都按最低档运行。',
    });
  }

  if (caps.gpu.ruleIds.length > 0) {
    issues.push({
      level: 'warn',
      code: 'GPU_BLACKLIST',
      message: `GPU 命中降级规则：${caps.gpu.ruleIds.join(', ')}`,
      hint: caps.gpu.notes.join(' / '),
    });
  }

  if (caps.sharedArrayBuffer && caps.crossOriginIsolated) {
    issues.push({
      level: 'info',
      code: 'SAB_READY',
      message: 'SharedArrayBuffer 可用，物理可跑在 Worker 且零拷贝回传',
    });
  } else {
    issues.push({
      level: 'warn',
      code: 'SAB_UNAVAILABLE',
      message: caps.sharedArrayBuffer
        ? 'SAB 存在但页面未跨源隔离（crossOriginIsolated=false）'
        : 'SharedArrayBuffer 不可用，物理退回主线程或 postMessage 拷贝模式',
      hint: COOP_HINT,
    });
  }

  const major = caps.webView.chromiumMajor;
  if (major !== null && major < 90) {
    issues.push({
      level: 'warn',
      code: 'CHROMIUM_OLD',
      message: `Chromium ${major} 低于 90，WebGL2/Worker 行为存在差异`,
      hint: 'WebView 可随 Chrome 独立升级；建议引导用户在应用商店更新「Android System WebView」。',
    });
  }

  if (caps.webView.detected) {
    issues.push({
      level: 'info',
      code: 'WEBVIEW_SHELL',
      message: `WebView 容器特征：${caps.webView.evidence.join(', ') || 'unknown'}`,
    });
  }

  if (caps.deviceMemoryGb !== null && caps.deviceMemoryGb <= 2) {
    issues.push({
      level: 'warn',
      code: 'LOW_MEMORY',
      message: `设备内存 ${caps.deviceMemoryGb}GB，粒子与纹理内存需保守`,
    });
  }

  if (caps.worker && !caps.moduleWorker) {
    issues.push({
      level: 'warn',
      code: 'NO_MODULE_WORKER',
      message: '不支持 module worker，Worker 相关能力全部关闭',
    });
  }

  if (!caps.secureContext) {
    issues.push({
      level: 'warn',
      code: 'INSECURE_CONTEXT',
      message: '非安全上下文，部分能力（SAB/高精度计时）受限',
      hint: '本地调试请用 https 或 localhost。',
    });
  }

  issues.push({
    level: 'info',
    code: 'TIER',
    message: `分档 ${decision.tier}（score=${decision.score}）· ${describeProfile(profile)}`,
  });

  return issues;
}

export function formatCapabilityReport(
  caps: PlatformCapabilities,
  decision: TierDecision,
  profile: QualityProfile,
  issues: readonly DiagnosticIssue[],
): string {
  const lines: string[] = [];
  lines.push('== Tabby Engine 能力报告 ==');
  lines.push(`GPU       : ${caps.gpu.renderer} (${caps.gpu.family})`);
  lines.push(`GPU 规则  : ${caps.gpu.ruleIds.join(', ') || '无'}`);
  lines.push(`WebGL2    : ${caps.webgl2 ? 'yes' : 'no'} | WebGL1: ${caps.webgl1 ? 'yes' : 'no'}`);
  lines.push(`SAB/COI   : ${caps.sharedArrayBuffer ? 'sab' : 'no-sab'} / ${caps.crossOriginIsolated ? 'isolated' : 'not-isolated'}`);
  lines.push(`Worker    : ${caps.worker ? 'yes' : 'no'} | module: ${caps.moduleWorker ? 'yes' : 'no'}`);
  lines.push(`内存/核数 : ${caps.deviceMemoryGb ?? 'n/a'}GB / ${caps.hardwareConcurrency}`);
  lines.push(`DPR/屏幕  : ${caps.devicePixelRatio} / ${caps.screenPixels}px`);
  lines.push(`WebView   : ${caps.webView.detected ? 'yes' : 'no'} (Chromium ${caps.webView.chromiumMajor ?? '?'})`);
  lines.push(`档位      : ${decision.tier} score=${decision.score}`);
  lines.push('评分依据  :');
  for (const reason of decision.reasons) lines.push(`  - ${reason}`);
  lines.push(`配置      : ${describeProfile(profile)}`);
  lines.push('诊断      :');
  for (const issue of issues) {
    lines.push(`  [${issue.level}] ${issue.code} ${issue.message}`);
  }
  return lines.join('\n');
}
