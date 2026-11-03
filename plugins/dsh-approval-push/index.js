/**
 * dsh-approval-push —— 宿主半。
 *
 * 1. 提醒界面由 client.js 渲染（右下角提醒卡 + 系统通知 + 提示音）。
 * 2. 本文件负责「发到手机」：浏览器半检测到新的待审批后 POST /approval-push/push，
 *    这里用 Node 的 fetch 把消息推到微信 / 手表（渠道与密钥在 %USERPROFILE%\.dsh\approval-push.push.json）。
 * 3. 附带几条只服务本机页面的诊断/配置路由（全部只接受回环请求）。
 *
 * 发网络请求放在宿主半的原因：不受页面 CORS、通知权限、页面是否打开的影响，
 * 也不会把密钥放进浏览器里。
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPusher, CONFIG_PATH, LOG_PATH, maskConfig, loadConfig } from './push.mjs';

export const name = 'dsh-approval-push';

const HEALTH_FILE = join(tmpdir(), 'dsh-approval-push.health.json');
const HOST_FILE = join(tmpdir(), 'dsh-approval-push.host.json');

/** 写配置是一次本机特权操作，要求页面带上这个头，挡住其它本地程序的误 POST。 */
const CONFIG_HEADER = 'x-dsh-approval-push';

function localHost(value) {
  if (typeof value !== 'string') return false;
  return (
    value === 'localhost' ||
    value.startsWith('localhost:') ||
    value === '127.0.0.1' ||
    value.startsWith('127.0.0.1:') ||
    value === '[::1]' ||
    value.startsWith('[::1]:')
  );
}

/** 只接受本机页面来的请求（Host/Origin 均为回环）。 */
function trusted(req) {
  if (!localHost(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return localHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/** 读 JSON 请求体；超过 64KB 视为异常请求。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tailLog(limit = 40) {
  try {
    if (!existsSync(LOG_PATH)) return [];
    const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

export function apply(ctx) {
  const mountedAt = new Date().toISOString();
  const pusher = createPusher({ logger: ctx.logger });

  try {
    writeFileSync(HOST_FILE, `${JSON.stringify({ hostMountedAt: mountedAt, pid: process.pid })}\n`, 'utf8');
  } catch {
    /* 诊断文件只为安装排查服务 */
  }

  ctx.inject(['webServer'], (webCtx) =>
    webCtx.effect(() => {
      const disposers = [];

      const route = (method, path, handler) => {
        disposers.push(
          webCtx.webServer.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              if (!trusted(req)) {
                res.writeHead(403);
                res.end();
                return;
              }
              if (req.method !== method) {
                res.writeHead(405, { allow: method });
                res.end();
                return;
              }
              try {
                await handler(req, res);
              } catch (error) {
                json(res, 400, { ok: false, error: String(error?.message ?? error) });
              }
            },
          }),
        );
      };

      // 浏览器半装载自检（保留原有用途）。
      route('GET', '/approval-push/health', (req, res) => {
        let clientVersion;
        try {
          clientVersion = new URL(req.url ?? '/', 'http://localhost').searchParams.get('client') ?? undefined;
        } catch {
          clientVersion = undefined;
        }
        const record = {
          hostMountedAt: mountedAt,
          clientVersion,
          clientReportedAt: clientVersion === undefined ? undefined : new Date().toISOString(),
        };
        try {
          writeFileSync(HEALTH_FILE, `${JSON.stringify(record)}\n`, 'utf8');
        } catch {
          /* 诊断文件写不进去不影响提醒功能 */
        }
        json(res, 200, { ok: true, plugin: name, hostMountedAt: mountedAt });
      });

      // 新审批到达：浏览器半 POST 过来，这里推到手机。
      route('POST', '/approval-push/push', async (req, res) => {
        const body = await readJsonBody(req);
        const outcome = await pusher.notify({
          key: body.key,
          toolName: body.toolName,
          reason: body.reason,
          sessionId: body.sessionId,
          sessionTitle: body.sessionTitle,
          focused: body.focused === true,
        });
        json(res, 200, { ok: true, ...outcome });
      });

      // 自检：用当前配置立刻发一条测试消息。
      route('POST', '/approval-push/push-test', async (_req, res) => {
        const result = await pusher.test();
        json(res, 200, { ok: result.ok, result, status: pusher.status() });
      });

      // 读配置（密钥打码）+ 运行状态。
      route('GET', '/approval-push/push-status', (_req, res) => {
        json(res, 200, {
          ok: true,
          status: pusher.status(),
          config: maskConfig(loadConfig()),
          configPath: CONFIG_PATH,
        });
      });

      // 写配置（合并）：{ enabled, channel, pushplus: { token }, ... }
      route('POST', '/approval-push/push-config', async (req, res) => {
        if (String(req.headers[CONFIG_HEADER] ?? '') !== '1') {
          json(res, 400, { ok: false, error: '缺少本机配置头' });
          return;
        }
        const body = await readJsonBody(req);
        const next = pusher.updateConfig(body);
        json(res, 200, { ok: true, config: maskConfig(next), status: pusher.status() });
      });

      // 最近的推送记录，排查「到底发出去了没有」。
      route('GET', '/approval-push/push-log', (_req, res) => {
        json(res, 200, { ok: true, entries: tailLog(40), logPath: LOG_PATH });
      });

      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'approval-push: push routes'),
  );

  ctx.logger?.info?.('[approval-push] 审批提醒已挂载：右下角提醒卡 + 手机推送（/approval-push/push）');
}
