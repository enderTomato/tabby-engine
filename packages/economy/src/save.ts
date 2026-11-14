import { EconomyState, PERSISTED_FIELDS, type PersistedField } from './state.js';

const MAGIC = 0x54424531; // "TBE1"
export const SAVE_VERSION = 1;

export interface SaveHeader {
  readonly version: number;
  readonly seed: number;
  readonly day: number;
  readonly month: number;
  readonly year: number;
  readonly tick: number;
  readonly capacity: number;
  readonly cityCount: number;
  readonly resourceCount: number;
  readonly fields: readonly string[];
  /** 迁移过程中产生的告警，读档后由调用方决定是否上报。 */
  readonly warnings: readonly string[];
}

export interface SavePayload {
  readonly state: EconomyState;
  readonly header: SaveHeader;
}

/**
 * 存档容器格式（小端）：
 *
 * ```
 * u32   magic  'TBE1'
 * u32   version
 * u32   headerByteLength
 * u8[]  header (UTF-8 JSON)
 * --- 以下按 header.fields 顺序 ---
 * u32   byteLength
 * u8[]  raw buffer
 * ```
 *
 * 为什么不直接 `JSON.stringify`：
 *
 * - `JSON.stringify(Float32Array)` 得到 `{"0":1.5,"1":2}`，体积约 10 倍，且读回来是对象不是数组。
 * - 10k 实体 × 8 资源 × 4 字节 = 320KB 二进制，JSON 版本 3~4MB。
 * - 二进制可以整体压缩（gzip / zstd），JSON 压完还是比二进制大得多。
 *
 * header 用 JSON 是有意的：它是低频、小体积、需要人类可读的元数据（版本、时间、种子）。
 * 把它也塞进二进制会让版本迁移的排查变得极其痛苦。
 */
export function encodeSave(state: EconomyState, seed: number, warnings: readonly string[] = []): Uint8Array {
  const fields = PERSISTED_FIELDS.filter((f) => ArrayBuffer.isView(asView(state, f)));
  const header: SaveHeader = {
    version: SAVE_VERSION,
    seed,
    day: state.day,
    month: state.month,
    year: state.year,
    tick: state.tick,
    capacity: state.capacity,
    cityCount: state.cityCount,
    resourceCount: state.resourceCount,
    fields: [...fields],
    warnings: [...warnings],
  };
  const headerBytes = encodeUtf8(JSON.stringify(header));

  let buffersLength = 0;
  const chunks: Uint8Array[] = [];
  for (const field of fields) {
    const view = asView(state, field);
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    chunks.push(copy);
    buffersLength += copy.length;
  }

  const total = 12 + headerBytes.length + chunks.length * 4 + buffersLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  view.setUint32(at, MAGIC, true);
  at += 4;
  view.setUint32(at, SAVE_VERSION, true);
  at += 4;
  view.setUint32(at, headerBytes.length, true);
  at += 4;
  out.set(headerBytes, at);
  at += headerBytes.length;

  for (const chunk of chunks) {
    view.setUint32(at, chunk.length, true);
    at += 4;
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function decodeSave(bytes: Uint8Array): SavePayload {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) throw new Error('[tabby/economy] 存档过短');
  const magic = view.getUint32(0, true);
  if (magic !== MAGIC) throw new Error('[tabby/economy] 存档魔数不匹配，可能不是 Tabby 存档');
  const version = view.getUint32(4, true);
  const headerLength = view.getUint32(8, true);
  const headerRaw = bytes.subarray(12, 12 + headerLength);
  const header = JSON.parse(decodeUtf8(headerRaw)) as SaveHeader;

  if (version > SAVE_VERSION) {
    throw new Error(`[tabby/economy] 存档版本 ${version} 高于当前实现 ${SAVE_VERSION}，请升级引擎`);
  }
  // 版本迁移链：只支持逐级迁移，不允许跳跃。当前只有 v1，这里保留入口。
  if (version < SAVE_VERSION) {
    throw new Error(`[tabby/economy] 缺少 v${version} → v${SAVE_VERSION} 的迁移实现`);
  }

  const state = new EconomyState(header.capacity, header.cityCount, header.resourceCount);
  state.day = header.day;
  state.month = header.month;
  state.year = header.year;
  state.tick = header.tick;

  let at = 12 + headerLength;
  const warnings: string[] = [...header.warnings];
  for (const name of header.fields) {
    if (at + 4 > bytes.byteLength) throw new Error('[tabby/economy] 存档在字段长度处截断');
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > bytes.byteLength) throw new Error(`[tabby/economy] 存档在字段 ${name} 处截断`);
    const target = (state as unknown as Record<string, unknown>)[name];
    if (!ArrayBuffer.isView(target)) {
      warnings.push(`字段 ${name} 在当前版本已不存在，已跳过`);
      at += length;
      continue;
    }
    const view0 = target;
    const dst = new Uint8Array(view0.buffer, view0.byteOffset, view0.byteLength);
    const src = bytes.subarray(at, at + length);
    if (src.length !== dst.length) {
      throw new Error(
        `[tabby/economy] 字段 ${name} 长度不匹配：存档 ${src.length} vs 当前 ${dst.length}`,
      );
    }
    dst.set(src);
    at += length;
  }

  // 读档后重建派生数组：这些不进存档，但立刻会被 UI / 诊断读到，
  // 留 0 会让「读档后第一天不产粮」这种偶发 bug 变成必现
  state.clearScratch();
  rebuildStockBounds(state);

  return { state, header: { ...header, warnings } };
}

function rebuildStockBounds(state: EconomyState): void {
  // 防御：存档里可能出现负数或 NaN（旧版本公式、手改存档），在此一次性修掉
  for (let i = 0; i < state.cityStock.length; i += 1) {
    const v = state.cityStock[i] as number;
    if (!Number.isFinite(v) || v < 0) state.cityStock[i] = 0;
  }
  for (let i = 0; i < state.buildingEfficiency.length; i += 1) {
    if (state.alive[i] === 0) continue;
    const v = state.buildingEfficiency[i] as number;
    if (!Number.isFinite(v)) state.buildingEfficiency[i] = 1;
    else if (v > 1) state.buildingEfficiency[i] = 1;
    else if (v < 0) state.buildingEfficiency[i] = 0;
  }
  for (let i = 0; i < state.price.length; i += 1) {
    const v = state.price[i] as number;
    if (!Number.isFinite(v) || v <= 0) state.price[i] = 0;
  }
}

function asView(state: EconomyState, field: PersistedField): ArrayBufferView {
  return (state as unknown as Record<PersistedField, ArrayBufferView>)[field];
}

/** 手写 UTF-8：把 lib 限制在 ES2022 是为了物理性阻止 DOM 依赖，代价是没有 TextEncoder。 */
function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
      i += 1;
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | ((bytes[i + 1] as number) & 0x3f));
      i += 2;
    } else if (b0 < 0xf0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | (((bytes[i + 1] as number) & 0x3f) << 6) | ((bytes[i + 2] as number) & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] as number) & 0x3f) << 12) |
        (((bytes[i + 2] as number) & 0x3f) << 6) |
        ((bytes[i + 3] as number) & 0x3f);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return out;
}
