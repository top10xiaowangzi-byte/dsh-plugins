/**
 * 起一个本机假接收端，验证 push.mjs 走真实 HTTP 的出站链路（含超时/非 2xx/重定向）。
 * 运行：node test/mock-receiver.mjs
 * 它会在 127.0.0.1:18099 上收请求并把最近一条写到 stdout。
 */

import { createServer } from 'node:http';
import { send, mergeConfig, DEFAULT_CONFIG } from '../push.mjs';

const PORT = 18099;
const received = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: 'mock ok' }));
  });
});

server.listen(PORT, '127.0.0.1', async () => {
  const config = mergeConfig(DEFAULT_CONFIG, {
    enabled: true,
    channel: 'webhook',
    webhook: { url: `http://127.0.0.1:${PORT}/approval-push-test` },
  });
  const result = await send(config, { title: 'DSH 推送测试', content: '**本机链路**' });
  console.log('send result:', JSON.stringify(result));
  console.log('received:', JSON.stringify(received[0] ?? null));
  server.close(() => {
    const ok = result.ok === true && received.length === 1 && received[0].method === 'POST';
    console.log(ok ? 'REAL-HTTP OK' : 'REAL-HTTP FAILED');
    process.exit(ok ? 0 : 1);
  });
});
