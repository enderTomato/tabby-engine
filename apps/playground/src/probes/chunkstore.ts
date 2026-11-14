/**
 * 探针：分块存档（TBCK）。
 *
 * 验的是「随机访问单块」这件事有没有真的成立：
 * 读第一块**不该**碰最后一块的数据。所以这里故意把最后一块改坏，
 * 然后看读第一块还成不成功 —— 成功才说明目录在前、数据在后。
 *
 * 如果哪天有人图省事改成「读档时解压整个文件」，这个探针会立刻红。
 */

import {
  CHUNKS_X,
  CHUNKS_Y,
  CHUNK_H,
  CHUNK_W,
  GRID_COLS,
  GRID_ROWS,
  TILE_COUNT,
  chunkKey,
  mergeChunks,
  packChunks,
  readAllChunks,
  readChunk,
  readDirectory,
  splitChunks,
  type ChunkDirectoryEntry,
} from '@tabby/gameplay';
import { addButton, addRow, makeControls, makeOverlay, seededRandom } from './shared.js';
import { batchLine, timeBatch, type BenchResult, type Probe } from '../types.js';

/**
 * 按 key 读单块。
 *
 * `readChunk` 要的是**目录项**而不是 key —— 这是有意的：调用方通常已经拿着目录了
 * （`ChunkStreamer` 就缓存着），不该为每次读再解析一遍文件头。
 * 探针这里为了单点验证，才每次现查目录。
 */
function readChunkByKey(bytes: Uint8Array, key: number) {
  const header = readDirectory(bytes);
  const entry = header.directory.find((item: ChunkDirectoryEntry) => item.key === key);
  if (entry === undefined) throw new Error(`目录里没有块 ${key}`);
  return readChunk(bytes, entry, header);
}

export function createChunkstoreProbe(): Probe {
  let cells = new Int8Array(TILE_COUNT);
  let entities = new Int32Array(TILE_COUNT).fill(-1);
  let archive: Uint8Array = new Uint8Array(0);
  let rowChunks: HTMLSpanElement | null = null;
  let rowBytes: HTMLSpanElement | null = null;
  let rowCheck: HTMLSpanElement | null = null;
  let rowRandom: HTMLSpanElement | null = null;

  function regenerate(seed: number): void {
    const rng = seededRandom(seed);
    cells = new Int8Array(TILE_COUNT);
    entities = new Int32Array(TILE_COUNT).fill(-1);
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      const roll = rng();
      cells[tile] = roll < 0.6 ? 0 : roll < 0.8 ? 1 : roll < 0.95 ? 2 : 3;
      if (cells[tile] !== 0) entities[tile] = tile * 3 + 1;
    }
    archive = packChunks(splitChunks(cells, entities));
  }

  function describe(): void {
    if (archive.length === 0) return;
    let header: ReturnType<typeof readDirectory> | null = null;
    try {
      header = readDirectory(archive);
    } catch (error) {
      if (rowCheck !== null) rowCheck.textContent = `目录解析失败：${error instanceof Error ? error.message : '?'}`;
      return;
    }
    if (rowChunks !== null) rowChunks.textContent = `${header.directory.length} 块（${CHUNKS_X}×${CHUNKS_Y}）`;
    if (rowBytes !== null) rowBytes.textContent = `${archive.length} 字节`;

    // 随机访问：只读中间那一块，不碰别的
    const middleKey = chunkKey(Math.floor(CHUNKS_X / 2), Math.floor(CHUNKS_Y / 2));
    const started = performance.now();
    let ok = false;
    try {
      const payload = readChunkByKey(archive, middleKey);
      ok = payload.cells.length === CHUNK_W * CHUNK_H;
    } catch (error) {
      if (rowRandom !== null) rowRandom.textContent = `读失败：${error instanceof Error ? error.message : '?'}`;
    }
    const cost = performance.now() - started;
    if (ok && rowRandom !== null) rowRandom.textContent = `1 块 / ${cost.toFixed(3)}ms`;

    // 拿全部块合并回来，必须与原始 cells 逐格相等
    const merged = mergeChunks(readAllChunks(archive));
    let mismatch = 0;
    for (let tile = 0; tile < TILE_COUNT; tile += 1) {
      if (merged.cells[tile] !== cells[tile]) mismatch += 1;
      else if (merged.entities[tile] !== entities[tile]) mismatch += 1;
    }
    if (rowCheck !== null) {
      rowCheck.textContent = mismatch === 0 ? '合并结果与原始逐格一致 ✓' : `${mismatch} 格不一致 ✗`;
      rowCheck.style.color = mismatch === 0 ? 'var(--good)' : 'var(--bad)';
    }
  }

  return {
    id: 'chunkstore',
    title: '分块存档',
    summary: 'TBCK：目录在前数据在后，读单块不扫全文件；坏一块不拖垮全局',
    group: '经营',

    mount(context) {
      regenerate(7);
      const overlay = makeOverlay(context.host, '分块存档');
      rowChunks = addRow(overlay, '块数');
      rowBytes = addRow(overlay, '归档体积');
      rowCheck = addRow(overlay, '合并校验');
      rowRandom = addRow(overlay, '随机读 1 块');
      const controls = makeControls(context.host);
      addButton(controls, '重新生成地图', () => {
        regenerate(Math.floor(Math.random() * 1e6));
        describe();
        context.log('已重新生成并打包');
      });
      addButton(controls, '截断最后一块', () => {
        if (archive.length === 0) return;
        const broken = archive.slice(0, archive.length - 12);
        try {
          // 只坏尾部：最后一块的校验和会失败
          const lastKey = chunkKey(CHUNKS_X - 1, CHUNKS_Y - 1);
          readChunkByKey(broken, lastKey);
          context.log('截断后仍读到了最后一块 —— 校验和没生效？');
        } catch (error) {
          context.log(`最后一块按预期报错：${error instanceof Error ? error.message : '?'}`);
        }
        try {
          const first = readChunkByKey(broken, chunkKey(0, 0));
          context.log(`但第一块仍可读（${first.cells.length} 格）—— 这才是「只坏一块不拖垮全局」`);
        } catch (error) {
          context.log(`第一块也读不了了：${error instanceof Error ? error.message : '?'} —— 说明数据没分块`);
        }
      });
      describe();
      context.log(`网格 ${GRID_COLS}×${GRID_ROWS}，切成 ${CHUNKS_X}×${CHUNKS_Y} 块`);
    },

    unmount() {
    },

    bench(): BenchResult {
      regenerate(7);
      const packing = timeBatch(() => packChunks(splitChunks(cells, entities)), 500);

      // 读单块要按**真实使用方式**测：目录只解析一次，之后每次只读那一块的数据。
      // 若把 `readDirectory` 算进来，量到的就成了「每帧重新扫全表」，
      // 那正是分块存档要避免的事。
      const header = readDirectory(archive);
      const middle = header.directory[Math.floor(header.directory.length / 2)];
      const readOne = middle === undefined ? null : timeBatch(() => readChunk(archive, middle, header), 2000);
      const readAll = timeBatch(() => mergeChunks(readAllChunks(archive)), 500);

      return {
        lines: [
          { label: '归档体积', value: `${archive.length} 字节`, hint: `${GRID_COLS}×${GRID_ROWS} 格 + 实体 id，共 ${header.directory.length} 块` },
          batchLine('打包一次', packing.perCallUs, '500 次批量均值'),
          readOne === null
            ? { label: '读单块', value: '—', hint: '目录为空' }
            : batchLine('读单块', readOne.perCallUs, '2000 次批量均值，目录已预解析'),
          batchLine('读全部并合并', readAll.perCallUs, `单块的 ${readOne === null || readOne.perCallUs === 0 ? '?' : (readAll.perCallUs / readOne.perCallUs).toFixed(0)} 倍 —— 差得越多说明随机访问越值`),
        ],
      };
    },
  };
}
