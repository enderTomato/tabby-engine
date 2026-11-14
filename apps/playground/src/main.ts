/**
 * Playground 外壳 —— 用纯 DOM 而不是 Vue。
 *
 * ## 为什么不引框架
 *
 * 这是「逐特性隔离验证台」，验证对象是引擎包。如果这里也用 Vue，
 * 那么 `@tabby/ui` 到底能不能脱离 Vue 就永远测不出来 ——
 * 而那是把它拆出来的唯一理由。所以这里故意用最朴素的 DOM 操作：
 * 侧栏是 `<button>`，探针各自 appendChild，没有任何响应式。
 *
 * 代价是代码啰嗦一点；收益是「引擎不绑框架」这句话变成了可执行的事实。
 */

import { createAssetsProbe } from './probes/assets.js';
import { createBridgeProbe } from './probes/bridge.js';
import { createChunkstoreProbe } from './probes/chunkstore.js';
import { createEconomyProbe } from './probes/economy.js';
import { createFluidProbe } from './probes/fluid.js';
import { createGraphProbe } from './probes/graph.js';
import { createInputProbe } from './probes/input.js';
import { createMinimapProbe } from './probes/minimap.js';
import { createPendulumProbe } from './probes/pendulum.js';
import { createRagdollProbe } from './probes/ragdoll.js';
import { createTerrainProbe } from './probes/terrain.js';
import { createWindProbe } from './probes/wind.js';
import type { BenchResult, Probe, ProbeContext } from './types.js';

const probes: readonly Probe[] = [
  createFluidProbe(),
  createRagdollProbe(),
  createWindProbe(),
  createPendulumProbe(),
  createTerrainProbe(),
  createInputProbe(),
  createAssetsProbe(),
  createGraphProbe(),
  createEconomyProbe(),
  createBridgeProbe(),
  createMinimapProbe(),
  createChunkstoreProbe(),
];

const listEl = requireEl('feature-list');
const hostEl = requireEl('probe-host');
const titleEl = requireEl('probe-title');
const summaryEl = requireEl('probe-summary');
const statsEl = requireEl('stats');
const logEl = requireEl('log');
const capsEl = requireEl('caps-line');
const benchOneEl = requireEl<HTMLButtonElement>('bench-one');
const benchAllEl = requireEl<HTMLButtonElement>('bench-all');

let current: Probe | null = null;
let rafId = 0;
let lastFrame = 0;
/** 当前探针是否要每帧 tick。不需要的把 rAF 停掉，省电也避免假帧率。 */
let needsFrames = false;

function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`Playground 结构缺少 #${id}`);
  return el as T;
}

function logLine(message: string): void {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
  logEl.textContent = `${line}\n${logEl.textContent ?? ''}`.slice(0, 4000);
}

function setStats(lines: readonly string[]): void {
  statsEl.textContent = lines.join('\n');
}

function buildRail(): void {
  let lastGroup = '';
  for (const probe of probes) {
    if (probe.group !== lastGroup) {
      const heading = document.createElement('p');
      heading.className = 'group';
      heading.textContent = probe.group;
      listEl.appendChild(heading);
      lastGroup = probe.group;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'feature';
    button.dataset.probe = probe.id;
    button.innerHTML = `<strong>${probe.title}</strong><em>${probe.summary}</em>`;
    button.addEventListener('click', () => {
      location.hash = probe.id;
    });
    listEl.appendChild(button);
  }
}

function markActive(id: string): void {
  for (const button of listEl.querySelectorAll<HTMLButtonElement>('.feature')) {
    button.classList.toggle('on', button.dataset.probe === id);
  }
}

function stopFrames(): void {
  if (rafId !== 0) cancelAnimationFrame(rafId);
  rafId = 0;
}

function frame(now: number): void {
  rafId = 0;
  const dt = lastFrame === 0 ? 16 : Math.min(100, now - lastFrame);
  lastFrame = now;
  try {
    current?.tick?.(now, dt);
  } catch (error) {
    // 探针挂了不该让整个验证台白屏 —— 这正是隔离验证要暴露的东西
    logLine(`探针 ${current?.id ?? '?'} tick 抛错：${error instanceof Error ? error.message : String(error)}`);
    needsFrames = false;
    return;
  }
  if (needsFrames) rafId = requestAnimationFrame(frame);
}

async function activate(id: string): Promise<void> {
  const probe = probes.find((item) => item.id === id) ?? null;
  if (probe === null) {
    logLine(`没有这个探针：${id}`);
    return;
  }
  if (current !== null) {
    stopFrames();
    needsFrames = false;
    try {
      current.unmount();
    } catch (error) {
      logLine(`探针 ${current.id} unmount 抛错：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  hostEl.replaceChildren();
  logEl.textContent = '';
  statsEl.textContent = '探针挂载中…';
  markActive(probe.id);
  titleEl.textContent = probe.title;
  summaryEl.textContent = probe.summary;
  current = probe;
  benchOneEl.disabled = probe.bench === undefined;

  const ctx: ProbeContext = {
    host: hostEl,
    setStats,
    log: logLine,
  };
  try {
    await probe.mount(ctx);
    logLine(`${probe.title} 已挂载`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(`挂载失败：${message}`);
    statsEl.textContent = `挂载失败：${message}`;
    return;
  }
  // 探针有 tick 才起循环
  if (probe.tick !== undefined) {
    needsFrames = true;
    lastFrame = 0;
    rafId = requestAnimationFrame(frame);
  }
}

function benchResultToText(result: BenchResult): string {
  const lines = result.lines.map((line) => `${line.label.padEnd(14, '　')} ${line.value}${line.hint ? `  // ${line.hint}` : ''}`);
  if (result.ms !== undefined) lines.unshift(`总耗时         ${result.ms.toFixed(2)}ms`);
  return lines.join('\n');
}

async function runBench(probe: Probe | null): Promise<void> {
  if (probe === null || probe.bench === undefined) return;
  benchOneEl.disabled = true;
  benchAllEl.disabled = true;
  try {
    const result = await probe.bench();
    setStats(benchResultToText(result).split('\n'));
    logLine(`${probe.title} 跑分完成`);
  } catch (error) {
    logLine(`跑分失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    benchOneEl.disabled = probe.bench === undefined;
    benchAllEl.disabled = false;
  }
}

async function runAllBench(): Promise<void> {
  benchAllEl.disabled = true;
  const rows: string[] = [];
  for (const probe of probes) {
    if (probe.bench === undefined) {
      rows.push(`${probe.title.padEnd(10, '　')} 无跑分项`);
      continue;
    }
    const started = performance.now();
    try {
      const result = await probe.bench();
      const head = result.lines.map((line) => `${line.label}=${line.value}`).join(' ');
      rows.push(`${probe.title.padEnd(10, '　')} ${(performance.now() - started).toFixed(1).padStart(7)}ms  ${head}`);
    } catch (error) {
      rows.push(`${probe.title.padEnd(10, '　')} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  setStats(rows);
  logLine('全部跑分完成');
  benchAllEl.disabled = false;
}

function route(): void {
  const id = location.hash.replace(/^#/, '') || (probes[0]?.id ?? '');
  void activate(id);
}

async function reportCapabilities(): Promise<void> {
  // 用一个 1x1 的离屏 canvas 探测真实能力：这个探针台本身就是给手机开的，
  // 面板上第一眼就该看到「这台机器能走哪条路」
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext('webgl2');
  const { describeCapabilities, probeAssetCapabilities } = await import('@tabby/assets');
  const caps = probeAssetCapabilities(gl as WebGL2RenderingContext | null, gl !== null);
  capsEl.textContent = describeCapabilities(caps);
  capsEl.dataset.tier = caps.ktx2 ? 'high' : caps.draco ? 'mid' : 'low';
}

buildRail();
benchOneEl.addEventListener('click', () => void runBench(current));
benchAllEl.addEventListener('click', () => void runAllBench());
window.addEventListener('hashchange', route);
route();
void reportCapabilities();
