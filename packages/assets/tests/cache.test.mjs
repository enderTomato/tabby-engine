/**
 * 资源缓存测试。
 *
 * 这个类的四条不变式，每条都对应一类线上事故：
 *
 * 1. 引用计数归零才谈淘汰 —— 否则「转个视角资源就没了」。
 * 2. 归零后给宽限期 —— 否则「拆了再放」会在同一帧释放再加载。
 * 3. 并发请求合并 —— 否则首帧 40 栋楼共用一张图会发 40 个请求。
 * 4. 失败也缓存 —— 否则弱网下每栋楼各重试一遍注定失败的 URL。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';

function makeCache(overrides = {}) {
  const clock = { t: 0 };
  const log = { loads: [], disposed: [] };
  const cache = new AssetCache({
    loader: async (key) => {
      log.loads.push(key);
      return { key, disposed: false };
    },
    dispose: (value) => {
      value.disposed = true;
      log.disposed.push(value.key);
    },
    clock: () => clock.t,
    graceMs: 100,
    maxEntries: 4,
    failureTtlMs: 50,
    ...overrides,
  });
  return { cache, clock, log };
}

test('同一个 key 取两次只加载一次，引用计数为 2', async () => {
  const { cache, log } = makeCache();
  const a = await cache.acquire('tex');
  const b = await cache.acquire('tex');
  assert.equal(a, b);
  assert.equal(log.loads.length, 1);
  assert.equal(cache.refsOf('tex'), 2);
  assert.equal(cache.stats.hits, 1);
});

test('引用没归零前，过了宽限期也不释放', async () => {
  const { cache, clock, log } = makeCache();
  await cache.acquire('tex');
  await cache.acquire('tex');
  cache.release('tex');
  clock.t = 10000;
  assert.equal(cache.collect(), 0);
  assert.equal(log.disposed.length, 0);
  assert.equal(cache.stats.live, 1);
});

test('归零后进入待淘汰，过了宽限期才真释放', async () => {
  const { cache, clock, log } = makeCache();
  await cache.acquire('tex');
  assert.equal(cache.release('tex'), true);
  assert.equal(cache.stats.pending, 1);

  clock.t = 99;
  assert.equal(cache.collect(), 0);
  assert.equal(log.disposed.length, 0);

  clock.t = 100;
  assert.equal(cache.collect(), 1);
  assert.deepEqual(log.disposed, ['tex']);
  assert.equal(cache.stats.evictions, 1);
});

test('宽限期内重新 acquire 免费救回来（不重新加载）', async () => {
  const { cache, clock, log } = makeCache();
  await cache.acquire('tex');
  cache.release('tex');
  clock.t = 50;
  await cache.acquire('tex');
  assert.equal(log.loads.length, 1);
  assert.equal(cache.stats.revived, 1);
  clock.t = 500;
  assert.equal(cache.collect(), 0);
});

test('并发 acquire 合并成一个请求', async () => {
  const { cache, log } = makeCache();
  const [a, b, c] = await Promise.all([cache.acquire('tex'), cache.acquire('tex'), cache.acquire('tex')]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(log.loads.length, 1);
  assert.equal(cache.stats.coalesced, 2);
  // 合并的三次都要算引用，否则后面 release 会提前归零
  assert.equal(cache.refsOf('tex'), 3);
});

test('加载失败会缓存，短时间内不再发请求', async () => {
  let calls = 0;
  const { cache, clock } = makeCache({
    loader: async () => {
      calls += 1;
      throw new Error('404');
    },
  });
  await assert.rejects(cache.acquire('missing'), /404/);
  assert.equal(calls, 1);

  clock.t = 10;
  await assert.rejects(cache.acquire('missing'), /刚刚加载失败/);
  assert.equal(calls, 1);
  assert.equal(cache.stats.shortCircuits, 1);

  // TTL 到期后允许重试（网络恢复了不该永久躺平）
  clock.t = 60;
  await assert.rejects(cache.acquire('missing'), /404/);
  assert.equal(calls, 2);
});

test('成功之后会清掉失败缓存', async () => {
  let attempt = 0;
  const { cache, clock } = makeCache({
    loader: async (key) => {
      attempt += 1;
      if (attempt === 1) throw new Error('临时失败');
      return { key, disposed: false };
    },
  });
  await assert.rejects(cache.acquire('tex'));
  clock.t = 60;
  const value = await cache.acquire('tex');
  assert.equal(value.key, 'tex');
});

test('容量超限时只强制淘汰待淘汰项，有引用的不动', async () => {
  const { cache, log } = makeCache({ maxEntries: 2 });
  await cache.acquire('a');
  await cache.acquire('b');
  cache.release('a');
  // 第三个进来时超限，a 是唯一可淘汰的
  await cache.acquire('c');
  assert.deepEqual(log.disposed, ['a']);
  assert.equal(cache.refsOf('b'), 1);
  assert.equal(cache.refsOf('c'), 1);
  assert.equal(cache.stats.forced, 1);
});

test('容量超限但有引用的都占着 → 宁可超限也不销毁在用的资源', async () => {
  const { cache, log } = makeCache({ maxEntries: 1 });
  await cache.acquire('a');
  await cache.acquire('b');
  await cache.acquire('c');
  assert.equal(log.disposed.length, 0);
  assert.equal(cache.stats.live, 3);
});

test('release 不配对的调用返回 false，不会把计数减成负数', async () => {
  const { cache } = makeCache();
  assert.equal(cache.release('nope'), false);
  await cache.acquire('tex');
  assert.equal(cache.release('tex'), true);
  assert.equal(cache.release('tex'), false);
  assert.equal(cache.refsOf('tex'), 0);
});

test('peek 不影响引用计数', async () => {
  const { cache } = makeCache();
  await cache.acquire('tex');
  cache.release('tex');
  assert.equal(cache.peek('tex')?.key, 'tex');
  assert.equal(cache.refsOf('tex'), 0);
  assert.equal(cache.stats.pending, 1);
});

test('dispose 抛错不影响缓存内部状态', async () => {
  const { cache, clock } = makeCache({
    dispose: () => {
      throw new Error('已经销毁过了');
    },
  });
  await cache.acquire('tex');
  cache.release('tex');
  clock.t = 100;
  assert.equal(cache.collect(), 1);
  assert.equal(cache.peek('tex'), null);
});

test('clear 无视引用计数全部销毁', async () => {
  const { cache, log } = makeCache();
  await cache.acquire('a');
  await cache.acquire('b');
  cache.clear();
  assert.deepEqual(log.disposed.sort(), ['a', 'b']);
  assert.equal(cache.stats.live, 0);
});

test('逐次 loader 覆盖默认 loader', async () => {
  const { cache } = makeCache();
  const value = await cache.acquire('k', async (key) => ({ key: `custom:${key}`, disposed: false }));
  assert.equal(value.key, 'custom:k');
});
