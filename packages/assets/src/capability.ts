/**
 * 资源能力探测 —— 决定「该不该试压缩格式」。
 *
 * ## 为什么不能只看 `isAndroid`
 *
 * 同一台 Android 手机上，Chrome 有 `WEBGL_compressed_texture_astc`，
 * 而同一个 App 的 WebView 可能只给 ETC2；反过来，某些骁龙机型在省电模式下
 * 会退掉一部分扩展。按平台写死判断必然在某批机型上崩或白屏。
 *
 * 所以这里只问「你现在到底能给什么」，答不上来就不试那条路。
 *
 * ## KTX2 不是「有 wasm 就能用」
 *
 * KTX2 的体积优势来自 GPU 压缩纹理（ASTC / ETC2 / BC）。
 * 如果设备一种压缩格式都不支持，basis transcoder 会转成 RGBA32 未压缩位图 ——
 * 这时 KTX2 反而比同画质的 JPEG/WebP **更大**（多了容器与 mip 链开销）。
 * 所以 `ktx2` 这个结论必须是 `wasm && 至少一种压缩格式`，不能只看 wasm。
 */

/** 探测结论。字段全部是布尔，`reasons` 给出降级的可读原因。 */
export interface AssetCapabilities {
  readonly webgl2: boolean;
  /** ASTC：移动端主流，压缩率最好。 */
  readonly astc: boolean;
  /** ETC2：Android 的保底格式（GLES3 起为必需）。 */
  readonly etc2: boolean;
  /** S3TC/BC1-7：桌面端主流。 */
  readonly s3tc: boolean;
  /** PVRTC：老 iOS 设备。 */
  readonly pvrtc: boolean;
  /** 有没有 WebAssembly —— DRACO 与 basis transcoder 的硬前提。 */
  readonly wasm: boolean;
  /** KTX2 是否值得试（wasm + 至少一种 GPU 压缩格式）。 */
  readonly ktx2: boolean;
  /** DRACO 是否值得试（wasm）。 */
  readonly draco: boolean;
  /** 降级原因，空数组表示全支持。给诊断面板直接显示。 */
  readonly reasons: readonly string[];
}

/** 探测需要的 WebGL 上下文的最小形状 —— 只用到 `getExtension`，这样测试里能传假对象。 */
export interface ExtensionProbe {
  getExtension(name: string): unknown;
}

/** 没有任何 GPU 上下文时的保守结论。 */
export function conservativeCapabilities(reason: string): AssetCapabilities {
  return {
    webgl2: false,
    astc: false,
    etc2: false,
    s3tc: false,
    pvrtc: false,
    wasm: typeof WebAssembly === 'object',
    ktx2: false,
    draco: typeof WebAssembly === 'object',
    reasons: [reason],
  };
}

/**
 * 探测一次。`gl` 为 `null` / `undefined` 时退化成「只支持未压缩资源」。
 *
 * `hasWebGL2` 需要调用方传入：从 `gl` 本身看不出来它是不是 WebGL2 上下文
 * （`WebGLRenderingContext` 与 `WebGL2RenderingContext` 的扩展方法同名）。
 */
export function probeAssetCapabilities(gl: ExtensionProbe | null | undefined, hasWebGL2: boolean): AssetCapabilities {
  const wasm = typeof WebAssembly === 'object';
  if (gl === null || gl === undefined) {
    return conservativeCapabilities('没有可用的 WebGL 上下文，压缩纹理与压缩网格全部降级');
  }

  // 压缩纹理扩展名各浏览器写法不同，这几个是 three 的 KTX2Loader 本身也在探的
  const astc = gl.getExtension('WEBGL_compressed_texture_astc') !== null;
  const etc2 = gl.getExtension('WEBGL_compressed_texture_etc') !== null;
  // WebGL2 里 S3TC 是 EXT_ 前缀，WebGL1 里没有前缀
  const s3tc =
    gl.getExtension('WEBGL_compressed_texture_s3tc') !== null ||
    gl.getExtension('EXT_texture_compression_s3tc') !== null;
  const pvrtc =
    gl.getExtension('WEBGL_compressed_texture_pvrtc') !== null ||
    gl.getExtension('WEBGL_compressed_texture_pvrtc_srgb') !== null;

  const reasons: string[] = [];
  const anyCompressed = astc || etc2 || s3tc || pvrtc;

  if (!wasm) reasons.push('没有 WebAssembly，KTX2 与 DRACO 都无法解码');
  if (wasm && !anyCompressed) {
    // 这一条最容易踩：能解码但没压缩格式，KTX2 会比原图更大
    reasons.push('没有任何 GPU 压缩纹理格式，KTX2 转 RGBA32 反而更大，回退未压缩纹理');
  }
  if (!hasWebGL2) reasons.push('不是 WebGL2 上下文，KTX2 的 sRGB/mip 链支持不完整');

  const ktx2 = wasm && anyCompressed && hasWebGL2;
  // DRACO 只要 wasm 就够：它是纯解码，不依赖 GPU 格式
  const draco = wasm;

  return { webgl2: hasWebGL2, astc, etc2, s3tc, pvrtc, wasm, ktx2, draco, reasons };
}

/** 一句话摘要，给诊断面板用。 */
export function describeCapabilities(caps: AssetCapabilities): string {
  const formats = [
    caps.astc ? 'ASTC' : null,
    caps.etc2 ? 'ETC2' : null,
    caps.s3tc ? 'S3TC' : null,
    caps.pvrtc ? 'PVRTC' : null,
  ].filter((name): name is string => name !== null);
  const head = `KTX2 ${caps.ktx2 ? '可用' : '降级'} · DRACO ${caps.draco ? '可用' : '降级'}`;
  const tail = formats.length > 0 ? `压缩格式 ${formats.join('/')}` : '无 GPU 压缩格式';
  return caps.reasons.length === 0 ? `${head} · ${tail}` : `${head} · ${tail} · ${caps.reasons.join('；')}`;
}
