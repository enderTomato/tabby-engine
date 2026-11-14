#!/usr/bin/env node
/**
 * playground 冒烟：逐个探针挂载，收集异常与控制台错误。
 *
 * 用 CDP 直接驱动 Chromium，不引 playwright —— 这个仓库的依赖已经够多了，
 * 而这里需要的只是「打开页面、点按钮、读日志」。
 *
 * 用法：node tools/smoke-playground.mjs [端口]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '../apps/playground/dist');
const PORT = Number(process.argv[2] ?? 4175);
const DEBUG_PORT = 9333;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ktx2': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(PORT, done));

/**
 * 给 Chromium 用的环境变量：必须摘掉 `DISPLAY`。
 *
 * 容器和 CI 里经常残留 `DISPLAY=:0`，但并没有真的 X server 在跑。
 * ANGLE 一看见 DISPLAY 就优先选 XCB/Vulkan 后端，`xcb_connect()` 失败后
 * 整个 GPU 进程起不来，`canvas.getContext('webgl2')` 恒为 null —— 报出来的
 * 错却是 "A WebGL context could not be created"，看起来像「设备不支持 WebGL」。
 * 摘掉 DISPLAY，ANGLE 才会落到 headless 的 SwiftShader 后端。
 */
function chromeEnv() {
  const env = { ...process.env };
  delete env.DISPLAY;
  return env;
}

const chrome = spawn(
  'chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--window-size=1280,900',
    `http://localhost:${PORT}/`,
  ],
  { stdio: 'ignore', env: chromeEnv() },
);

const sleep = (ms) => delay(ms);
let wsUrl = null;
for (let i = 0; i < 60 && wsUrl === null; i += 1) {
  await sleep(250);
  try {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = targets.find((item) => item.type === 'page');
    if (page !== undefined) wsUrl = page.webSocketDebuggerUrl;
  } catch {
    /* 还没起来 */
  }
}
if (wsUrl === null) {
  console.error('Chromium 没起来');
  chrome.kill();
  server.close();
  process.exit(1);
}

const socket = new WebSocket(wsUrl);
await new Promise((done) => socket.addEventListener('open', done, { once: true }));

let seq = 0;
const pending = new Map();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const slot = pending.get(message.id);
    if (slot !== undefined) {
      pending.delete(message.id);
      slot(message);
    }
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails;
    pageErrors.push(detail.exception?.description ?? detail.text);
  }
  if (message.method === 'Network.loadingFailed') {
    failedRequests.push(`${message.params.type} ${message.params.errorText}`);
  }
});

function send(method, params = {}) {
  seq += 1;
  const id = seq;
  return new Promise((done) => {
    pending.set(id, done);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.result?.exceptionDetails !== undefined) {
    return { error: result.result.exceptionDetails.text };
  }
  return result.result?.result?.value;
};

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await sleep(1500);

// 开跑前先确认这台机器真能拿到 WebGL2。拿不到就直接停 —— 否则后面每个
// 3D 探针都会挂，日志里一堆 "A WebGL context could not be created"，
// 看上去像是我们的代码有 bug，其实是环境没配好。误诊比不测更浪费时间。
const hasWebGL2 = await evaluate(`(() => {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
})()`);
if (hasWebGL2 !== true) {
  console.error('这台机器拿不到 WebGL2 上下文，冒烟无法继续。');
  console.error('常见原因：DISPLAY 指向一个不存在的 X server，ANGLE 选错了后端。');
  console.error('排查：env -u DISPLAY node tools/smoke-playground.mjs');
  socket.close();
  chrome.kill();
  server.close();
  process.exit(1);
}

const ids = await evaluate(`Array.from(document.querySelectorAll('.feature')).map((el) => el.dataset.probe)`);
console.log(`发现 ${ids.length} 个探针：${ids.join(' ')}`);

let bad = 0;
for (const id of ids) {
  const before = pageErrors.length + consoleErrors.length;
  await evaluate(`location.hash = '${id}'`);
  await sleep(900);
  const state = await evaluate(`(() => ({
    title: document.getElementById('probe-title').textContent,
    stats: (document.getElementById('stats').textContent || '').slice(0, 120).replace(/\\s+/g, ' '),
    log: (document.getElementById('log').textContent || '').split('\\n').slice(0, 3).join(' | '),
    canvases: document.querySelectorAll('#probe-host canvas').length,
  }))()`);
  // 有跑分项的顺手跑一次：跑分路径最容易藏着只在点击时才炸的错误
  const benchable = await evaluate(`!document.getElementById('bench-one').disabled`);
  if (benchable === true) {
    await evaluate(`document.getElementById('bench-one').click()`);
    await sleep(1800);
  }
  const after = pageErrors.length + consoleErrors.length;
  const errs = [...pageErrors.slice(before), ...consoleErrors.slice(before)];
  const ok = after === before;
  if (!ok) bad += 1;
  console.log(`${ok ? '✓' : '✗'} ${id.padEnd(11)} canvas=${state.canvases} ${state.title}`);
  if (!ok) console.log(`    异常：${errs.join(' / ').slice(0, 300)}`);
  if (benchable === true) {
    const bench = await evaluate(`(document.getElementById('stats').textContent || '').slice(0, 200).replace(/\\s+/g, ' ')`);
    console.log(`    跑分：${bench}`);
  }
}

const caps = await evaluate(`document.getElementById('caps-line').textContent`);
console.log(`\n能力：${caps}`);
if (failedRequests.length > 0) console.log(`请求失败：${[...new Set(failedRequests)].slice(0, 6).join(' / ')}`);
console.log(`\n结果：${ids.length - bad}/${ids.length} 通过`);

socket.close();
chrome.kill();
server.close();
process.exit(bad === 0 ? 0 : 1);
