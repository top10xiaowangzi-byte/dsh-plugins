/**
 * 本机假接收端：验证「浏览器半 → 宿主半 → 出站 HTTP」整条链路。
 * 收到请求追加写进 test/_mock-inbox.jsonl，并回 200。
 * 运行：node test/_mock-server.mjs [port]
 */

import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const port = Number(process.argv[2] ?? 18099);
const inbox = join(dirname(fileURLToPath(import.meta.url)), '_mock-inbox.jsonl');

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    appendFileSync(inbox, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body })}\n`, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 200, msg: 'mock ok' }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock receiver listening on http://127.0.0.1:${port} inbox=${inbox}`);
});
