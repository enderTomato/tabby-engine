#!/usr/bin/env node
/**
 * demo 冒烟：起静态服务器 → 无头 Chromium 打开 → 切 3D → 收集错误与控制台。
 *
 * 与 `smoke-playground.mjs` 同一套手法（CDP 直连，不引 playwright）。
 * 单独一个文件而不是合并，是因为两者的「成功判据」不一样：
 * playground 看每个探针能不能挂载 + 跑分，demo 看整条引擎主循环跑起来之后
 * 画质诊断里的数字合不合理。
 *
 * 用法：node tools/smoke-demo.mjs [端口]
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '../apps/demo/dist');
const PORT = Number(process.argv[2] ?? 4176);
const DEBUG_PORT = 9334;

const server = spawn('node', [resolve(ROOT, 'serve.mjs'), String(PORT)], { stdio: 'ignore' });

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
for (let i = 0; i < 80 && wsUrl === null; i += 1) {
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
  server.kill();
  process.exit(1);
}

const socket = new WebSocket(wsUrl);
await new Promise((done) => socket.addEventListener('open', done, { once: true }));

let seq = 0;
const pending = new Map();
const errors = [];
const failed = [];

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
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '));
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params.exceptionDetails;
    errors.push(detail.exception?.description ?? detail.text);
  }
  if (message.method === 'Network.loadingFailed') {
    failed.push(`${message.params.type} ${message.params.errorText}`);
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
  if (result.result?.exceptionDetails !== undefined) return { error: result.result.exceptionDetails.text };
  return result.result?.result?.value;
};

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await sleep(3000);

// 切到 3D：工具栏上那个按钮的文字是「3D」
const switched = await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const target = buttons.find((el) => el.textContent?.trim() === '3D 试验场');
  if (target === undefined) return 'no-button';
  target.click();
  return 'clicked';
})()`);
await sleep(2500);

const state = await evaluate(`(() => {
  const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }));
  const text = (id) => document.getElementById(id)?.textContent ?? null;
  const hud = document.body.innerText.slice(0, 400).replace(/\\s+/g, ' ');
  return { switched: ${JSON.stringify(switched)}, canvases, hud, diag: text('diag') ?? text('diag-text') };
})()`);

// 打开诊断面板（按钮文案「诊断」），把画质信息读出来
const diag = await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const target = buttons.find((el) => el.textContent?.trim().includes('诊断'));
  if (target === undefined) return null;
  if (target.getAttribute('aria-pressed') !== 'true') target.click();
  return true;
})()`);
await sleep(1200);

const diagText = await evaluate(`(() => {
  const pres = Array.from(document.querySelectorAll('pre'));
  const hit = pres.map((p) => p.textContent ?? '').find((t) => t.includes('渲染') || t.includes('draw'));
  return hit ?? null;
})()`);

// 用真机方式触发一次上下文丢失，验证恢复链路不在真机上炸
const contextLost = await evaluate(`(() => {
  // 第一个 canvas 是 3D 视图（renderer 自己创建的那个）；小地图是 2d 上下文，取错了会拿到 null
  const canvas = document.querySelectorAll('canvas')[0];
  const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
  if (gl === undefined || gl === null) return 'no-context';
  const ext = gl.getExtension('WEBGL_lose_context');
  if (ext === null) return 'no-extension';
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), 300);
  return 'lost';
})()`);
await sleep(2000);

const afterRestore = await evaluate(`(() => ({
  errors: 0,
  canvases: Array.from(document.querySelectorAll('canvas')).map((c) => ({ w: c.width, h: c.height })),
}))()`);

const errCount = errors.length;
console.log(`切换 3D：${state?.switched}`);
console.log(`画布：${JSON.stringify(state?.canvases)}`);
console.log(`诊断开关：${diag === true ? '已打开' : '未找到按钮'}`);
if (diagText !== null && diagText !== undefined) {
  console.log('诊断内容：');
  console.log(String(diagText).split('\n').slice(0, 80).map((line) => `  ${line}`).join('\n'));
}
console.log(`上下文丢失测试：${contextLost}`);
console.log(`恢复后画布：${JSON.stringify(afterRestore?.canvases)}`);
if (failed.length > 0) console.log(`请求失败：${[...new Set(failed)].slice(0, 5).join(' / ')}`);
console.log(`控制台错误：${errCount}`);
if (errCount > 0) console.log(errors.slice(0, 6).join('\n'));

socket.close();
chrome.kill();
server.kill();
process.exit(errCount === 0 ? 0 : 1);
