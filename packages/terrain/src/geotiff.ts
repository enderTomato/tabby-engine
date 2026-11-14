/**
 * GeoTIFF 解析（最小可用子集）。
 *
 * ## 为什么只做子集
 *
 * 完整的 GeoTIFF 要处理：LZW / Deflate / JPEG / PackBits 压缩、分块存储（Tile）、
 * 多波段、调色板、坐标参考系（CRS）解析、BigTIFF。那是一个库的工作量。
 *
 * 而 DEM 的实际用法里，**绝大多数源文件是未压缩的单波段 Int16/Float32**，
 * 或者可以先用 `gdal_translate -co COMPRESS=NONE` 一行转成这种形式。
 * 所以这里只支持未压缩单波段，遇到其它情况明确报错并给出转换命令 ——
 * 静默产出错误的数字比直接失败危险得多。
 *
 * ## 为什么浏览器里解析 GeoTIFF 是个坏主意
 *
 * 4096² 的 Float32 DEM 是 64MB，完整读进 ArrayBuffer 再解析，在移动端
 * 大概率触发 OOM。这个实现的定位是**离线预处理工具**（Node），
 * 不要把它打进运行时包。
 */

export type GeoTiffSampleFormat = 'uint' | 'int' | 'float';

export interface GeoTiffRaster {
  readonly width: number;
  readonly height: number;
  readonly samplesPerPixel: number;
  readonly bitsPerSample: number;
  readonly sampleFormat: GeoTiffSampleFormat;
  /** 按行优先展开的高程值，长度 = width × height。单位由源文件决定（通常米）。 */
  readonly data: Float32Array;
  /** ModelPixelScale（度或米/像素），无 GeoTIFF tag 时为 null。 */
  readonly pixelScale: readonly [number, number, number] | null;
  /** ModelTiepoint 里的栅格原点（经纬度或投影坐标），无 tag 时为 null。 */
  readonly tiepoint: readonly [number, number, number] | null;
  /** 是否带地理参考（可以用它推 bbox）。 */
  readonly geoReferenced: boolean;
}

/** TIFF 标签（只列用到的）。 */
const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  stripOffsets: 273,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  samplesPerPixel: 277,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
} as const;

export function parseGeoTiff(buffer: ArrayBuffer): GeoTiffRaster {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  if (bytes.length < 8) throw new Error('[tabby/terrain] 不是 TIFF：文件太短');
  const b0 = bytes[0] as number;
  const b1 = bytes[1] as number;
  let little: boolean;
  if (b0 === 0x49 && b1 === 0x49) little = true;
  else if (b0 === 0x4d && b1 === 0x4d) little = false;
  else throw new Error('[tabby/terrain] 不是 TIFF：字节序标记无效');

  const magic = view.getUint16(2, little);
  if (magic === 43) {
    throw new Error('[tabby/terrain] 不支持 BigTIFF。请先用 gdal_translate 转成经典 TIFF');
  }
  if (magic !== 42) throw new Error(`[tabby/terrain] 不是 TIFF：magic=${magic}`);

  const ifdOffset = view.getUint32(4, little);
  const entryCount = view.getUint16(ifdOffset, little);

  const tags = new Map<number, { readonly type: number; readonly count: number; readonly valueOffset: number }>();
  for (let i = 0; i < entryCount; i += 1) {
    const at = ifdOffset + 2 + i * 12;
    if (at + 12 > bytes.length) throw new Error('[tabby/terrain] IFD 越界，文件可能被截断');
    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const count = view.getUint32(at + 4, little);
    // 值字段固定 4 字节：能装下就内联，否则是偏移
    tags.set(tag, { type, count, valueOffset: at + 8 });
  }

  const readValues = (tag: number): number[] => {
    const entry = tags.get(tag);
    if (entry === undefined) return [];
    const size = typeSize(entry.type);
    if (size === 0) return [];
    const total = size * entry.count;
    const base = total <= 4 ? entry.valueOffset : view.getUint32(entry.valueOffset, little);
    const out: number[] = [];
    for (let i = 0; i < entry.count; i += 1) {
      out.push(readScalar(view, base + i * size, entry.type, little));
    }
    return out;
  };

  const readFirst = (tag: number, fallback: number): number => {
    const values = readValues(tag);
    return values.length > 0 ? (values[0] as number) : fallback;
  };

  const width = readFirst(TAG.imageWidth, 0);
  const height = readFirst(TAG.imageLength, 0);
  if (width <= 0 || height <= 0) {
    throw new Error(`[tabby/terrain] GeoTIFF 尺寸无效：${width}×${height}`);
  }

  const compression = readFirst(TAG.compression, 1);
  if (compression !== 1) {
    throw new Error(
      `[tabby/terrain] 不支持压缩的 GeoTIFF（Compression=${compression}）。` +
        '请先执行：gdal_translate -co COMPRESS=NONE -co PROFILE=GeoTIFF in.tif out.tif',
    );
  }

  const samplesPerPixel = readFirst(TAG.samplesPerPixel, 1);
  if (samplesPerPixel !== 1) {
    throw new Error(
      `[tabby/terrain] 只支持单波段 GeoTIFF（SamplesPerPixel=${samplesPerPixel}）。` +
        '请先执行：gdal_translate -b 1 in.tif out.tif',
    );
  }

  const bitsPerSample = readFirst(TAG.bitsPerSample, 16);
  const formatCode = readFirst(TAG.sampleFormat, 1);
  const sampleFormat: GeoTiffSampleFormat = formatCode === 2 ? 'int' : formatCode === 3 ? 'float' : 'uint';

  if (sampleFormat === 'float' && bitsPerSample !== 32 && bitsPerSample !== 64) {
    throw new Error(`[tabby/terrain] 浮点波段位深异常：${bitsPerSample}`);
  }
  if (sampleFormat !== 'float' && bitsPerSample !== 8 && bitsPerSample !== 16 && bitsPerSample !== 32) {
    throw new Error(`[tabby/terrain] 不支持 ${bitsPerSample} 位整型波段`);
  }

  const stripOffsets = readValues(TAG.stripOffsets);
  const stripByteCounts = readValues(TAG.stripByteCounts);
  if (stripOffsets.length === 0) {
    throw new Error('[tabby/terrain] 缺少 StripOffsets，可能是分块（Tile）存储的 TIFF');
  }
  const rowsPerStrip = readFirst(TAG.rowsPerStrip, height);

  const bytesPerSample = bitsPerSample / 8;
  const data = new Float32Array(width * height);
  let rowBase = 0;
  for (let s = 0; s < stripOffsets.length; s += 1) {
    const offset = stripOffsets[s] as number;
    const byteCount = stripByteCounts[s] ?? width * rowsPerStrip * bytesPerSample;
    const rows = Math.min(rowsPerStrip, height - rowBase);
    const expected = rows * width * bytesPerSample;
    if (byteCount < expected) {
      throw new Error(`[tabby/terrain] 第 ${s} 条带长度不足：${byteCount} < ${expected}`);
    }
    for (let r = 0; r < rows; r += 1) {
      const outRow = rowBase + r;
      const srcRow = offset + r * width * bytesPerSample;
      for (let col = 0; col < width; col += 1) {
        const at = srcRow + col * bytesPerSample;
        let value: number;
        if (sampleFormat === 'float') {
          value = bitsPerSample === 64 ? view.getFloat64(at, little) : view.getFloat32(at, little);
        } else if (bitsPerSample === 16) {
          value = sampleFormat === 'int' ? view.getInt16(at, little) : view.getUint16(at, little);
        } else if (bitsPerSample === 32) {
          value = sampleFormat === 'int' ? view.getInt32(at, little) : view.getUint32(at, little);
        } else {
          value = sampleFormat === 'int' ? view.getInt8(at) : bytes[at] as number;
        }
        data[outRow * width + col] = value;
      }
    }
    rowBase += rows;
    if (rowBase >= height) break;
  }

  const scale = readValues(TAG.modelPixelScale);
  const tie = readValues(TAG.modelTiepoint);

  return {
    width,
    height,
    samplesPerPixel,
    bitsPerSample,
    sampleFormat,
    data,
    pixelScale: scale.length >= 2 ? [scale[0] as number, scale[1] as number, scale[2] ?? 0] : null,
    tiepoint: tie.length >= 3 ? [tie[0] as number, tie[1] as number, tie[2] as number] : null,
    geoReferenced: scale.length >= 2 && tie.length >= 3,
  };
}

/**
 * 从带地理参考的栅格推 bbox（经纬度）。
 *
 * 约定：tiepoint 在 GeoTIFF 里是「栅格坐标 (0,0) 对应的模型坐标」，
 * 而 (0,0) 是**左上角像素的外角**，不是像素中心。少算这半个像素会让
 * 整张图偏移几十米 —— 对 30 米分辨率的 SRTM 就是一整格。
 */
export function rasterBBox(raster: GeoTiffRaster): {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
} | null {
  if (!raster.geoReferenced || raster.pixelScale === null || raster.tiepoint === null) return null;
  const west = raster.tiepoint[0];
  const north = raster.tiepoint[1];
  const dx = raster.pixelScale[0];
  // 注意：GeoTIFF 的 ModelPixelScale 的 y 分量为正值，向南递减由 tiepoint 表达
  const dy = raster.pixelScale[1];
  return {
    west,
    east: west + raster.width * dx,
    north,
    south: north - raster.height * dy,
  };
}

function typeSize(type: number): number {
  switch (type) {
    case 1:
    case 2:
    case 6:
    case 7:
      return 1;
    case 3:
    case 8:
      return 2;
    case 4:
    case 9:
    case 11:
      return 4;
    case 5:
    case 10:
    case 12:
      return 8;
    default:
      return 0;
  }
}

function readScalar(view: DataView, at: number, type: number, little: boolean): number {
  switch (type) {
    case 1:
    case 7:
      return view.getUint8(at);
    case 3:
      return view.getUint16(at, little);
    case 4:
      return view.getUint32(at, little);
    case 8:
      return view.getInt16(at, little);
    case 9:
      return view.getInt32(at, little);
    case 11:
      return view.getFloat32(at, little);
    case 12:
      return view.getFloat64(at, little);
    default:
      return 0;
  }
}
