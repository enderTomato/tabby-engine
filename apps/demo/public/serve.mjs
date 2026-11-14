// Tabby Engine Demo 本地静态服务器
// 用法：node serve.mjs [端口]   （默认 4173）
//
// 为什么不能直接双击 index.html：
// 1. file:// 下拿不到 WebGL2 上下文
// 2. SharedArrayBuffer 需要页面处于 cross-origin isolated 状态，
//    必须由服务端下发 COOP/COEP 头，否则引擎会静默降级到 worker-copy
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // 粒子缓冲是高频更新的二进制数据，诊断时偶尔要读，先留着
  'Access-Control-Allow-Origin': '*',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));

  try {
    if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    // 单页应用：未知路径回落到 index.html
    filePath = join(ROOT, 'index.html');
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...ISOLATION_HEADERS });
    res.end('404 Not Found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const immutable = filePath.includes(`${'/'}assets${'/'}`);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...ISOLATION_HEADERS,
  });
  createReadStream(filePath).pipe(res);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Tabby Demo  ->  http://localhost:${PORT}/`);
  console.log('COOP/COEP 已下发，SharedArrayBuffer 可用（host.mode 应为 worker-shared）');
});
