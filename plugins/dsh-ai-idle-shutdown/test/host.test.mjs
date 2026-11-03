#!/usr/bin/env node
/**
 * 离线联调测试：把 Host 半挂到一个假的 DSH webServer 上，真的去调随包分发的 Python 后端。
 *
 * 覆盖：
 *  - 三个路由注册（status / start / stop）；
 *  - 首次运行自动建数据目录、把 config.example.json 复制成 config.json；
 *  - Python 探测（pythonOk / pythonVersion）；
 *  - GET status 的字段形状、本机同源校验（Host 头不是 loopback → 403）；
 *  - 演练模式 start → 真的拉起监控进程 → stop → 撤销并退出。
 *
 * 全程 dry-run：绝不真的关机。用 `node test/host.test.mjs` 运行。
 * 指定解释器：设置环境变量 DSH_TEST_PYTHON 或 PYTHON（默认 win32 用 python，其余 python3）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.mjs';

const PYTHON = process.env.DSH_TEST_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-ai-idle-shutdown-test-'));
const handlers = new Map();
const pass = (message) => console.log(`ok   ${message}`);

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  inject(_services, factory) {
    factory({
      webServer: {
        register(route) {
          handlers.set(route.path, route.handler);
          return () => handlers.delete(route.path);
        },
      },
      effect(factoryInner) {
        factoryInner();
      },
    });
  },
};

function makeReq({ method = 'GET', url = '/ai-idle-shutdown/status', host = '127.0.0.1:55817', origin, body }) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    destroy() {},
  };
  queueMicrotask(() => {
    if (body !== undefined) {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(JSON.stringify(body)));
    }
    for (const listener of listeners.get('end') ?? []) listener();
  });
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.writableEnded = true;
    },
  };
}

async function call(path, options = {}) {
  const handler = handlers.get(path);
  assert.ok(handler, `路由未注册：${path}`);
  const res = makeRes();
  await handler(makeReq({ url: path, ...options }), res);
  let json = null;
  try {
    json = res.body ? JSON.parse(res.body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, raw: res.body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(250);
  }
  throw new Error(`超时等待：${label}`);
}

let exitCode = 0;
try {
  apply(ctx, { dataDir, python: PYTHON, pollMs: 300 });

  // ---------- 路由 ----------
  assert.equal(handlers.size, 3, '应注册 status / start / stop 三条路由');
  pass('注册 3 条本机路由（status / start / stop）');

  // ---------- 数据目录与配置 ----------
  assert.ok(existsSync(dataDir), '数据目录应自动创建');
  const configPath = join(dataDir, 'config.json');
  assert.ok(existsSync(configPath), '首次运行应复制 config.example.json → config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.idle_minutes, 15);
  assert.equal(config.action, 'shutdown');
  assert.equal(config.dry_run, false);
  pass('数据目录自动创建，config.json 从内置模板播种（15 分钟 / shutdown）');

  // ---------- Python 探测 ----------
  await waitFor(async () => {
    const { json } = await call('/ai-idle-shutdown/status');
    return json?.pythonOk !== null;
  }, 15000, 'Python 探测完成');
  const firstStatus = await call('/ai-idle-shutdown/status');
  assert.equal(firstStatus.status, 200);
  assert.equal(firstStatus.json.pythonOk, true, `Python 应可用（${PYTHON}）：${firstStatus.json.pythonError}`);
  assert.match(String(firstStatus.json.pythonVersion), /^3\./, '应能读到 Python 版本');
  assert.equal(firstStatus.json.dataDir, dataDir);
  assert.equal(firstStatus.json.configPath, configPath);
  assert.equal(firstStatus.json.stateCode, 'stopped');
  assert.ok(Array.isArray(firstStatus.json.events));
  pass(`Python 探测通过（${firstStatus.json.pythonVersion}），status 字段形状正确`);

  // ---------- 同源校验 ----------
  const forbidden = await call('/ai-idle-shutdown/status', { host: 'evil.example:443' });
  assert.equal(forbidden.status, 403);
  const forbiddenPost = await call('/ai-idle-shutdown/start', { method: 'GET' });
  assert.equal(forbiddenPost.status, 405, 'start 只接受 POST');
  pass('本机同源校验生效：非 loopback → 403；GET start → 405');

  // 安全前提：即便是演练测试，也让配置文件本身 dry_run=true —— 万一启动参数丢了，
  // 后端也不会真的关机（测试绝不能有真实的关机路径）。
  writeFileSync(configPath, JSON.stringify({ ...config, dry_run: true }, null, 2), 'utf8');

  // ---------- 演练模式启动 ----------
  let started = await call('/ai-idle-shutdown/start', { method: 'POST', body: { dryRun: true } });
  if (started.json?.ok !== true && started.json?.code === 2) {
    // 本机已有另一个监控实例（单实例互斥）：先取消再重试一次。
    await call('/ai-idle-shutdown/stop', { method: 'POST', body: {} });
    await sleep(2000);
    started = await call('/ai-idle-shutdown/start', { method: 'POST', body: { dryRun: true } });
  }
  assert.equal(started.json?.ok, true, `启动失败：${started.json?.message ?? JSON.stringify(started.json)}`);
  assert.equal(started.json.dryRun, true);
  assert.ok(Number.isInteger(started.json.pid) && started.json.pid > 0, '应返回监控进程 PID');
  pass(`演练模式启动成功（PID ${started.json.pid}）`);

  await waitFor(async () => {
    const { json } = await call('/ai-idle-shutdown/status');
    return json?.running === true;
  }, 15000, '监控进程状态上报');
  const runningStatus = await call('/ai-idle-shutdown/status');
  assert.equal(runningStatus.json.running, true);
  assert.equal(runningStatus.json.dryRun, true);
  assert.ok(['waiting', 'monitoring', 'countdown', 'starting'].includes(runningStatus.json.stateCode));
  pass(`status 跟随监控进程：running=true, dryRun=true, state=${runningStatus.json.stateCode}`);

  // ---------- 停止（撤销关机倒计时） ----------
  const stopped = await call('/ai-idle-shutdown/stop', { method: 'POST', body: {} });
  assert.equal(stopped.json?.ok, true, `停止失败：${stopped.json?.message ?? JSON.stringify(stopped.json)}`);
  pass('停止成功：--cancel 已执行，状态回到未启用');

  await waitFor(async () => {
    const { json } = await call('/ai-idle-shutdown/status');
    return json?.running === false;
  }, 15000, '监控进程退出');
  pass('监控进程已退出，status running=false');
} catch (error) {
  exitCode = 1;
  console.error(`FAIL ${error && error.message ? error.message : error}`);
} finally {
  for (const handler of [...handlers.keys()]) handlers.delete(handler);
  try {
    // 兜底：如果测试中途异常，确保测试启动的监控不会一直挂着。
    const statusPath = join(dataDir, 'status.json');
    if (existsSync(statusPath)) {
      const status = JSON.parse(readFileSync(statusPath, 'utf8'));
      if (Number.isInteger(status?.pid)) {
        try {
          process.kill(status.pid, 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  // 监控进程退出时可能还短暂占用数据目录（cwd），等它释放再删。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(300);
    }
  }
  console.log(exitCode === 0 ? '\nPASS — host 半与随包 Python 后端联调通过' : '\nFAIL — 见上方错误');
  process.exit(exitCode);
}
