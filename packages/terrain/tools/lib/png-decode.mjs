// 最小 PNG 解码器：只做「读高度图」这一件事，但保证 16bit 精度一比特不丢。
//
// 为什么不用 pngjs：实测它对 16bit 灰度图返回值失真（137 读成 255），
// 而 P16 的核心诉求就是「浏览器 canvas 会降 8bit，所以要在 Node 侧精确解析」。
// 换一个同样会丢精度的库没有意义。
//
// 支持：8/16 bit，灰度(0) / RGB(2) / 灰度+Alpha(4) / RGBA(6)，非交错。
// 不支持：调色板(3)（高度图不该用调色板）、交错（interlace=1，会直接报错）。
import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readUInt32(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 反 filter，原地处理。stride = 一行字节数，bpp = 每像素字节数。 */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= bpp ? out[rowStart + x - bpp] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let restored;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`[terrain] 未知 PNG filter ${filter}（行 ${y}）`);
      }
      out[rowStart + x] = restored & 0xff;
    }
    pos += stride;
  }
  return out;
}

/**
 * 解码 PNG。
 * @returns {{ width:number, height:number, bitDepth:number, colorType:number,
 *             /** 归一化到 0..1 的高度 *\/ values:Float32Array }}
 */
export function decodePngHeight(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== SIGNATURE[i]) throw new Error('[terrain] 不是合法的 PNG 文件');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (offset < buf.length) {
    const length = readUInt32(buf, offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === 'IHDR') {
      width = readUInt32(buf, dataStart);
      height = readUInt32(buf, dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      interlace = buf[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }

  if (width === 0 || height === 0) throw new Error('[terrain] PNG 缺少 IHDR');
  if (interlace !== 0) throw new Error('[terrain] 不支持交错 PNG，请导出为非交错');
  if (colorType === 3) throw new Error('[terrain] 不支持调色板 PNG，高度图请用灰度或 RGB');
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error(`[terrain] 不支持 ${bitDepth}bit PNG，请用 8bit 或 16bit`);
  }

  const channels = CHANNELS[colorType] ?? 1;
  const bytesPerSample = bitDepth / 8;
  const bpp = channels * bytesPerSample;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = unfilter(inflated, width, height, bpp);

  const values = new Float32Array(width * height);
  const maxValue = bitDepth === 16 ? 65535 : 255;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * bpp;
      let sample;
      if (bitDepth === 16) {
        // 大端
        sample = raw.readUInt16BE(pixelOffset);
      } else {
        sample = raw[pixelOffset];
      }
      values[y * width + x] = sample / maxValue;
    }
  }

  return { width, height, bitDepth, colorType, values };
}
