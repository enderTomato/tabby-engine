import { evaluateGpu, type GpuVerdict } from './gpu-blacklist.js';

export interface WebViewSignal {
  /** 是否运行在 WebView / TWA 容器内（依据 UA 与 chrome 对象推断）。 */
  readonly detected: boolean;
  /** Chromium 主版本号；null 表示无法解析。 */
  readonly chromiumMajor: number | null;
  /** 判定依据，输出到诊断面板便于线上排障。 */
  readonly evidence: readonly string[];
}

export interface PlatformCapabilities {
  readonly secureContext: boolean;
  readonly webgl2: boolean;
  readonly webgl1: boolean;
  readonly offscreenCanvas: boolean;
  readonly worker: boolean;
  readonly moduleWorker: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly atomics: boolean;
  /** COOP/COEP 生效时才能用 SAB + 高精度计时。 */
  readonly crossOriginIsolated: boolean;
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  readonly floatColorBuffer: boolean;
  readonly halfFloatLinear: boolean;
  readonly deviceMemoryGb: number | null;
  readonly hardwareConcurrency: number;
  readonly devicePixelRatio: number;
  readonly screenPixels: number;
  readonly touch: boolean;
  readonly coarsePointer: boolean;
  readonly reducedMotion: boolean;
  readonly saveData: boolean;
  readonly gpu: GpuVerdict;
  readonly webView: WebViewSignal;
  readonly userAgent: string;
}

export interface DetectOptions {
  /** 复用已有 canvas 探测，避免多创建一个上下文。 */
  readonly probeCanvas?: HTMLCanvasElement | null;
  /** 是否真实构造 Worker 验证 module worker 支持（低端机可关闭以省启动时间）。 */
  readonly probeWorkers?: boolean;
  /** 覆盖 UA（仅测试用）。 */
  readonly userAgent?: string;
}

interface GlProbe {
  readonly webgl2: boolean;
  readonly webgl1: boolean;
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  readonly floatColorBuffer: boolean;
  readonly halfFloatLinear: boolean;
  readonly vendor: string;
  readonly renderer: string;
}

const EMPTY_GL: GlProbe = {
  webgl2: false,
  webgl1: false,
  maxTextureSize: 0,
  maxAnisotropy: 0,
  floatColorBuffer: false,
  halfFloatLinear: false,
  vendor: 'unknown',
  renderer: 'unknown',
};

export function parseChromiumMajor(userAgent: string): number | null {
  const match = /(?:Chrome|Chromium|CriOS)\/(\d+)/.exec(userAgent);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : null;
}

/**
 * WebView 判定：不做「isAndroid」这类平台分支，只看容器特征。
 * - UA 里带 `; wv)` 是 Android WebView 的官方标记；
 * - 有 Chrome/* 版本号但 `window.chrome` 缺失，通常是 WebView 或裁剪版内核；
 * - TWA 走 Custom Tab，UA 与 Chrome 一致，无法区分，按 Chrome 处理即可。
 */
export function detectWebView(userAgent: string, hasChromeObject: boolean): WebViewSignal {
  const evidence: string[] = [];
  let detected = false;
  if (/;\s*wv\)/.test(userAgent)) {
    detected = true;
    evidence.push('ua-wv-token');
  }
  // 只有「Chromium 内核 + 移动端 UA + 缺失 chrome 对象」才判为 WebView；
  // 桌面无头浏览器 / 隐私插件也会缺 window.chrome，不能一概而论。
  if (!hasChromeObject && /Chrome\//.test(userAgent) && /Mobile|Tablet/.test(userAgent)) {
    detected = true;
    evidence.push('chrome-ua-without-chrome-object');
  }
  if (/Version\/\d+\.\d+.*Chrome\//.test(userAgent) && /Mobile/.test(userAgent)) {
    evidence.push('legacy-version-token');
  }
  return { detected, chromiumMajor: parseChromiumMajor(userAgent), evidence };
}

export function detectCapabilities(options: DetectOptions = {}): PlatformCapabilities {
  const g = globalThis as unknown as {
    document?: Document;
    navigator?: Navigator;
    Worker?: typeof Worker;
    SharedArrayBuffer?: unknown;
    Atomics?: unknown;
    OffscreenCanvas?: unknown;
    crossOriginIsolated?: boolean;
    chrome?: unknown;
    matchMedia?: (q: string) => MediaQueryList;
  };

  const nav = (g.navigator ?? ({} as Navigator)) as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  const userAgent = options.userAgent ?? nav.userAgent ?? '';
  const gl = probeGl(options.probeCanvas ?? null);
  const gpu = evaluateGpu(gl.vendor, gl.renderer);

  const hasSab = typeof g.SharedArrayBuffer !== 'undefined' && g.SharedArrayBuffer !== null;
  const hasAtomics = typeof g.Atomics !== 'undefined';
  const crossOriginIsolated = g.crossOriginIsolated === true;

  const worker = typeof g.Worker !== 'undefined';
  const moduleWorker = options.probeWorkers === false ? inferModuleWorker(userAgent) : probeModuleWorker(worker);

  const screenW = typeof globalThis.screen !== 'undefined' ? globalThis.screen.width : 0;
  const screenH = typeof globalThis.screen !== 'undefined' ? globalThis.screen.height : 0;
  const dpr = globalThis.devicePixelRatio || 1;

  return {
    secureContext: globalThis.isSecureContext === true,
    webgl2: gl.webgl2,
    webgl1: gl.webgl1,
    offscreenCanvas: typeof g.OffscreenCanvas !== 'undefined',
    worker,
    moduleWorker,
    sharedArrayBuffer: hasSab,
    atomics: hasAtomics,
    crossOriginIsolated,
    maxTextureSize: gl.maxTextureSize,
    maxAnisotropy: gl.maxAnisotropy,
    floatColorBuffer: gl.floatColorBuffer,
    halfFloatLinear: gl.halfFloatLinear,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: nav.hardwareConcurrency ?? 1,
    devicePixelRatio: dpr,
    screenPixels: screenW * screenH,
    touch: (nav.maxTouchPoints ?? 0) > 0,
    coarsePointer: typeof g.matchMedia === 'function' ? g.matchMedia('(pointer: coarse)').matches : false,
    reducedMotion: typeof g.matchMedia === 'function'
      ? g.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
    saveData: nav.connection?.saveData === true,
    gpu,
    webView: detectWebView(userAgent, typeof g.chrome !== 'undefined'),
    userAgent,
  };
}

function inferModuleWorker(userAgent: string): boolean {
  const major = parseChromiumMajor(userAgent);
  // module worker 自 Chromium 80 起默认可用；Firefox 114+ / Safari 15+ 亦可用。
  return major === null ? true : major >= 80;
}

function probeModuleWorker(workerAvailable: boolean): boolean {
  if (!workerAvailable) return false;
  try {
    const blob = new Blob([''], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { type: 'module' });
    worker.terminate();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

function probeGl(canvas: HTMLCanvasElement | null): GlProbe {
  const doc = (globalThis as unknown as { document?: Document }).document;
  let target = canvas;
  let owned = false;
  if (target === null) {
    if (doc === undefined) return EMPTY_GL;
    target = doc.createElement('canvas');
    target.width = 1;
    target.height = 1;
    owned = true;
  }

  let gl2: WebGL2RenderingContext | null = null;
  try {
    gl2 = target.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
  } catch {
    gl2 = null;
  }

  if (gl2 !== null) {
    const debugInfo = gl2.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo !== null ? String(gl2.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : String(gl2.getParameter(gl2.VENDOR));
    const renderer = debugInfo !== null ? String(gl2.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : String(gl2.getParameter(gl2.RENDERER));
    const probe: GlProbe = {
      webgl2: true,
      webgl1: true,
      maxTextureSize: Number(gl2.getParameter(gl2.MAX_TEXTURE_SIZE)) || 0,
      maxAnisotropy: gl2.getExtension('EXT_texture_filter_anisotropic') !== null ? 4 : 1,
      floatColorBuffer:
        gl2.getExtension('EXT_color_buffer_float') !== null ||
        gl2.getExtension('EXT_color_buffer_half_float') !== null,
      halfFloatLinear: gl2.getExtension('OES_texture_float_linear') !== null,
      vendor,
      renderer,
    };
    if (owned) {
      gl2.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return probe;
  }

  let gl1: WebGLRenderingContext | null = null;
  try {
    gl1 = target.getContext('webgl', { alpha: false, antialias: false }) as WebGLRenderingContext | null;
  } catch {
    gl1 = null;
  }
  if (gl1 === null) return { ...EMPTY_GL, webgl2: false, webgl1: false };

  const debugInfo = gl1.getExtension('WEBGL_debug_renderer_info');
  const vendor = debugInfo !== null ? String(gl1.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : String(gl1.getParameter(gl1.VENDOR));
  const renderer = debugInfo !== null ? String(gl1.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : String(gl1.getParameter(gl1.RENDERER));
  const result: GlProbe = {
    webgl2: false,
    webgl1: true,
    maxTextureSize: Number(gl1.getParameter(gl1.MAX_TEXTURE_SIZE)) || 0,
    maxAnisotropy: 1,
    floatColorBuffer: false,
    halfFloatLinear: gl1.getExtension('OES_texture_float_linear') !== null,
    vendor,
    renderer,
  };
  if (owned) {
    gl1.getExtension('WEBGL_lose_context')?.loseContext();
  }
  return result;
}

/** 是否具备「物理跑在 Worker + 零拷贝回传」的条件。 */
export function canUseSharedPhysics(caps: PlatformCapabilities): boolean {
  return caps.worker && caps.moduleWorker && caps.sharedArrayBuffer && caps.atomics && caps.crossOriginIsolated;
}
