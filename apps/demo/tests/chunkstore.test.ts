/**
 * 分块存档与流式加载测试。
 *
 * 重点不是「打包/解包能对上」（那是最低要求），而是三件容易出错的事：
 * 1. 目录里的 offset 必须能随机访问 —— 这才是「不用读全文件」的意义；
 * 2. 校验和必须真的能挡住截断 —— 否则坏档会静默变成空地图；
 * 3. 流式加载的加载/卸载必须是**确定性的**，不能依赖 Set/Map 的遍历序。
 */

import { describe, expect, it } from 'vitest';
import { Cell, GRID_COLS, GRID_ROWS, TILE_COUNT, indexOf } from '../src/game/city';
import {
  CHUNKS_X,
  CHUNKS_Y,
  ChunkStreamer,
  chunkKey,
  chunkOfTile,
  mergeChunks,
  packChunks,
  readChunk,
  readDirectory,
  splitChunks,
} from '../src/game/chunkstore';

function makeWorld(): { cells: Int8Array; entities: Int32Array } {
  const cells = new Int8Array(TILE_COUNT);
  const entities = new Int32Array(TILE_COUNT).fill(-1);
  // 确定性伪随机：用坐标算，不用 Math.random（测试要能复现）
  for (let tile = 0; tile < TILE_COUNT; tile += 1) {
    const col = tile % GRID_COLS;
    const row = (tile - col) / GRID_COLS;
    const kind = (col * 7 + row * 3) % 4;
    cells[tile] = kind === 0 ? Cell.Empty : kind;
    if (kind !== 0) entities[tile] = tile * 3 + 1;
  }
  return { cells, entities };
}

describe('分块切分', () => {
  it('切出来的块覆盖全部格子且不重不漏', () => {
    const { cells, entities } = makeWorld();
    const chunks = splitChunks(cells, entities);
    expect(chunks.length).toBe(CHUNKS_X * CHUNKS_Y);

    const { cells: merged, entities: mergedEntities } = mergeChunks(chunks);
    expect(Array.from(merged)).toEqual(Array.from(cells));
    expect(Array.from(mergedEntities)).toEqual(Array.from(entities));
  });

  it('chunkOfTile 与 chunkKey 自洽', () => {
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const { cx, cy } = chunkOfTile(tile);
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cx).toBeLessThan(CHUNKS_X);
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThan(CHUNKS_Y);
      expect(chunkKey(cx, cy)).toBe((cx << 16) | cy);
    }
    expect(chunkOfTile(indexOf(0, 0))).toEqual({ cx: 0, cy: 0 });
    expect(chunkOfTile(indexOf(GRID_COLS - 1, GRID_ROWS - 1))).toEqual({
      cx: CHUNKS_X - 1,
      cy: CHUNKS_Y - 1,
    });
  });
});

describe('打包与随机访问', () => {
  it('打包后能只读目录，再按需读单块', () => {
    const { cells, entities } = makeWorld();
    const chunks = splitChunks(cells, entities);
    const bytes = packChunks(chunks);

    const header = readDirectory(bytes);
    expect(header.version).toBe(1);
    expect(header.cols).toBe(GRID_COLS);
    expect(header.rows).toBe(GRID_ROWS);
    expect(header.directory.length).toBe(chunks.length);

    for (const entry of header.directory) {
      const payload = readChunk(bytes, entry, header);
      expect(payload.key).toBe(entry.key);
      const original = chunks.find((item) => item.key === entry.key);
      expect(original).toBeDefined();
      expect(Array.from(payload.cells)).toEqual(Array.from(original!.cells));
    }
  });

  it('读单块时不需要解析整张地图：短视图片段也能读出头部目录', () => {
    const { cells } = makeWorld();
    const bytes = packChunks(splitChunks(cells));
    // 只切出「头部 + 目录」这一段，模拟分段下载
    const header = readDirectory(bytes);
    const headBytes = bytes.subarray(0, 24 + header.directory.length * 16);
    const headOnly = readDirectory(headBytes);
    expect(headOnly.directory.length).toBe(header.directory.length);
    // 但数据区不在，读块必须报错而不是返回空块
    expect(() => readChunk(headOnly === header ? bytes : headBytes, header.directory[0]!, header)).toThrow();
  });

  it('存档被截断时校验和报错，而不是静默给空地图', () => {
    const { cells } = makeWorld();
    const bytes = packChunks(splitChunks(cells));
    const header = readDirectory(bytes);
    // 截断伤到的是**最后一块**；读第一块当然能成功（它就在数据区开头）
    const last = header.directory[header.directory.length - 1]!;

    const broken = bytes.slice(0, bytes.length - 2);
    expect(() => readChunk(broken, last, header)).toThrow(/越界|校验失败/);
    // 反向验证：截断后第一块仍然可读，说明「只坏一块不拖垮全局」
    expect(() => readChunk(broken, header.directory[0]!, header)).not.toThrow();
  });

  it('改一个字节就会校验失败', () => {
    const { cells } = makeWorld();
    const bytes = packChunks(splitChunks(cells));
    const header = readDirectory(bytes);
    const entry = header.directory[0]!;
    const base = 24 + header.directory.length * 16;

    const tampered = bytes.slice();
    tampered[base + entry.offset] = (tampered[base + entry.offset]! ^ 0xff) & 0xff;
    expect(() => readChunk(tampered, entry, header)).toThrow(/校验失败/);
  });

  it('拒绝非本格式的字节流', () => {
    expect(() => readDirectory(new Uint8Array(4))).toThrow(/太短/);
    expect(() => readDirectory(new Uint8Array(64))).toThrow(/不是分块存档/);
  });

  it('增量存档只打包传入的块', () => {
    const { cells, entities } = makeWorld();
    const chunks = splitChunks(cells, entities);
    const one = packChunks([chunks[2]!]);
    const header = readDirectory(one);
    expect(header.directory.length).toBe(1);
    expect(header.directory[0]!.key).toBe(chunks[2]!.key);
  });
});

describe('流式加载', () => {
  it('以中心块为焦点常驻半径内的块', () => {
    const { cells, entities } = makeWorld();
    const streamer = new ChunkStreamer(packChunks(splitChunks(cells, entities)));
    streamer.configure({ radius: 1, budget: 99, unloadGraceFrames: 0 });
    streamer.focus(indexOf(0, 0));
    streamer.step();
    // 中心 (0,0)，半径 1 → cx∈{0,1} × cy∈{0,1} 共 4 块
    expect(streamer.residentCount).toBe(4);
    expect(streamer.residentKeys()).toEqual(
      [chunkKey(0, 0), chunkKey(1, 0), chunkKey(0, 1), chunkKey(1, 1)].sort((a, b) => a - b),
    );
  });

  it('每帧只加载 budget 个块', () => {
    const { cells } = makeWorld();
    const streamer = new ChunkStreamer(packChunks(splitChunks(cells)));
    streamer.configure({ radius: 2, budget: 1, unloadGraceFrames: 0 });
    streamer.focus(indexOf(0, 0));

    expect(streamer.step().loaded).toBe(1);
    expect(streamer.residentCount).toBe(1);
    streamer.step();
    expect(streamer.residentCount).toBe(2);
    // 一直推进到全部常驻
    for (let i = 0; i < 10; i += 1) streamer.step();
    expect(streamer.residentCount).toBe(CHUNKS_X * CHUNKS_Y);
  });

  it('焦点的加载顺序是环绕中心的（近的先来）', () => {
    const { cells } = makeWorld();
    const streamer = new ChunkStreamer(packChunks(splitChunks(cells)));
    streamer.configure({ radius: 2, budget: 1, unloadGraceFrames: 0 });
    // 焦点放在右下角块
    streamer.focus(indexOf(GRID_COLS - 1, GRID_ROWS - 1));
    const order: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const before = streamer.residentKeys();
      streamer.step();
      const after = streamer.residentKeys();
      const added = after.find((key) => !before.includes(key));
      if (added !== undefined) order.push(added);
    }
    expect(order[0]).toBe(chunkKey(CHUNKS_X - 1, CHUNKS_Y - 1));
  });

  it('卸载有宽限期，避免边界来回走时反复加载', () => {
    const { cells } = makeWorld();
    const streamer = new ChunkStreamer(packChunks(splitChunks(cells)));
    streamer.configure({ radius: 0, budget: 99, unloadGraceFrames: 3 });
    streamer.focus(indexOf(0, 0));
    streamer.step();
    expect(streamer.residentCount).toBe(1);

    // 焦点移走：宽限期内还在
    streamer.focus(indexOf(GRID_COLS - 1, GRID_ROWS - 1));
    streamer.step();
    expect(streamer.residentCount).toBeGreaterThanOrEqual(1);
    // 一直待在新位置，旧块最终被卸载
    for (let i = 0; i < 6; i += 1) streamer.step();
    expect(streamer.residentKeys()).not.toContain(chunkKey(0, 0));
  });

  it('脏块追踪只报告被标记的块', () => {
    const { cells, entities } = makeWorld();
    const streamer = new ChunkStreamer(packChunks(splitChunks(cells, entities)));
    expect(streamer.dirtyKeys()).toEqual([]);

    streamer.markDirty(chunkKey(1, 1));
    streamer.markDirty(chunkKey(0, 0));
    expect(streamer.dirtyKeys()).toEqual([chunkKey(0, 0), chunkKey(1, 1)].sort((a, b) => a - b));

    streamer.load(chunkKey(0, 0));
    streamer.load(chunkKey(1, 1));
    const incremental = streamer.packDirty();
    expect(readDirectory(incremental).directory.length).toBe(2);

    streamer.clearDirty();
    expect(streamer.dirtyKeys()).toEqual([]);
  });

  it('取未常驻的块返回 null，而不是抛错或返回空块', () => {
    const { cells } = makeWorld();
    const streamer = new ChunkStreamer(packChunks(splitChunks(cells)));
    expect(streamer.get(chunkKey(0, 0))).toBeNull();
    expect(streamer.load(chunkKey(0, 0))).toBe(true);
    const payload = streamer.get(chunkKey(0, 0));
    expect(payload).not.toBeNull();
    expect(payload!.cells.length).toBeGreaterThan(0);
  });
});
