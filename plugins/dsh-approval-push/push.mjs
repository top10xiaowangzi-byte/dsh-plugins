/**
 * dsh-approval-push —— 出站推送（把「需要审批」发到手机 / 微信 / 手表）。
 *
 * 定位：宿主半（Node）里唯一发网络请求的地方。浏览器半只负责「检测到新审批 → POST 给本机」，
 * 真正的 HTTP 出站由这里做，这样不受 CORS、页面关闭、系统通知权限的限制。
 *
 * 配置：%USERPROFILE%\.dsh\approval-push.push.json（不存在时用内置默认值；首次保存自动创建）。
 * 日志：%TEMP%\dsh-approval-push.push.log（每次推送一行，排查用；不记录密钥）。
 *
 * 支持渠道：
 *   pushplus   微信（pushplus 服务号）  —— 国内常用，免费额度大
 *   serverchan 微信（Server酱）         —— 老牌，免费额度小
 *   ntfy       Android / iOS 通知栏 App —— 不经微信，手表镜像最直接
 *   wecom      企业微信群机器人          —— 公司场景
 *   webhook    自定义 HTTP 回调          —— 接自己的服务器 / Bark 等
 */

import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';

export const CONFIG_PATH = join(homedir(), '.dsh', 'approval-push.push.json');
export const LOG_PATH = join(tmpdir(), 'dsh-approval-push.push.log');

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 显式 agent：既不复用连接，也不吃代理环境变量。
 * 本机 NODE_USE_ENV_PROXY=1 且 HTTPS_PROXY 指向没开的 v2rayN 时，默认 agent 会把国内
 * 推送请求也打到 127.0.0.1:10808 上失败；传显式 agent 就绕过去了（实测 2026-11-02）。
 */
const DIRECT_HTTPS_AGENT = new HttpsAgent({ keepAlive: false });
const DIRECT_HTTP_AGENT = new HttpAgent({ keepAlive: false });

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  // 主渠道：pushplus | serverchan | ntfy | wecom | webhook
  channel: 'pushplus',
  // always = 每条审批都推；unfocused = 只在 Harness 窗口没聚焦时推（人在电脑前就不打扰）
  notifyWhen: 'always',
  // 推文里的原因最多保留多少字
  maxReasonChars: 400,
  // 两条推送之间至少间隔多久（毫秒），防止一次性冒出多条审批时刷屏
  minIntervalMs: 3000,
  // 每分钟最多推几条（PushPlus 免费版限制 1 分钟 5 次）
  maxPerMinute: 4,
  pushplus: { token: '', channel: 'wechat', template: 'markdown' },
  serverchan: { sendKey: '' },
  ntfy: { server: 'https://ntfy.sh', topic: '', priority: 4, tags: 'warning' },
  wecom: { webhook: '' },
  webhook: { url: '', headers: {} },
});

const SECRET_KEYS = new Set(['token', 'sendKey', 'topic', 'webhook', 'url']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：默认值打底，用户配置覆盖；未知字段忽略。 */
export function mergeConfig(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue;
    if (isPlainObject(out[key]) && !Array.isArray(out[key])) {
      out[key] = mergeConfig(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return mergeConfig(DEFAULT_CONFIG, {});
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(tmp, CONFIG_PATH);
  return config;
}

function maskValue(key, value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!SECRET_KEYS.has(key)) return value;
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** 给 GET /push-config 用：密钥打码，只回显「配没配」。 */
export function maskConfig(config) {
  const out = structuredClone(config);
  for (const [key, value] of Object.entries(out)) {
    if (isPlainObject(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (SECRET_KEYS.has(inner)) value[inner] = maskValue(inner, innerValue);
      }
    } else if (SECRET_KEYS.has(key)) {
      out[key] = maskValue(key, value);
    }
  }
  return out;
}

/** 渠道是否已配置齐全（缺密钥就直接跳过，不报错刷日志）。 */
export function channelReady(config) {
  switch (config.channel) {
    case 'pushplus':
      return typeof config.pushplus?.token === 'string' && config.pushplus.token.trim().length > 0;
    case 'serverchan':
      return typeof config.serverchan?.sendKey === 'string' && config.serverchan.sendKey.trim().length > 0;
    case 'ntfy':
      return (
        typeof config.ntfy?.server === 'string' &&
        config.ntfy.server.trim().length > 0 &&
        typeof config.ntfy?.topic === 'string' &&
        config.ntfy.topic.trim().length > 0
      );
    case 'wecom':
      return typeof config.wecom?.webhook === 'string' && config.wecom.webhook.trim().length > 0;
    case 'webhook':
      return typeof config.webhook?.url === 'string' && config.webhook.url.trim().length > 0;
    default:
      return false;
  }
}

export function logLine(entry) {
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响推送 */
  }
}

/**
 * 一个不读代理环境变量的 HTTP 请求。
 *
 * 为什么不用全局 fetch：本机 HTTPS_PROXY 指向 v2rayN（常常没开），而 Node 24 在
 * NODE_USE_ENV_PROXY=1 时会让 fetch 走系统代理，结果连国内推送服务也一起被拦成
 * ECONNREFUSED。node:https/http 本来就不看代理环境变量，直连最符合这里的需要。
 */
export function requestOnce(url, options = {}) {
  const { method = 'GET', headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`URL 不合法：${url}`));
      return;
    }
    const sendImpl = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const agent = parsed.protocol === 'https:' ? DIRECT_HTTPS_AGENT : DIRECT_HTTP_AGENT;
    const req = sendImpl(
      parsed,
      { method, headers, agent },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 2_000_000) chunks.push(chunk);
        });
        res.on('end', () => {
          const location = res.headers.location;
          const status = res.statusCode ?? 0;
          const hops = options.hops ?? 0;
          if (location && [301, 302, 307, 308].includes(status) && hops < 3) {
            const next = new URL(location, parsed).toString();
            resolve(requestOnce(next, { ...options, method: status === 307 || status === 308 ? method : 'GET', body: status === 307 || status === 308 ? body : undefined, hops: hops + 1 }));
            return;
          }
          resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', (error) => reject(error));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** PushPlus 的常见业务错误码，翻成人话（来源：官方文档 + 实测 2026-11-02）。 */
const PUSHPLUS_ERRORS = {
  903: 'token 不正确',
  905: '账号未实名（PushPlus 要求先实名才能推送）',
  888: '积分不足',
  900: '请求过于频繁（1 分钟 5 次 / 相同内容 1 小时 3 条）',
  907: '内容为空',
};

/** 渠道返回体里的成功标志：各家字段名不一样，统一在这里判定。 */
function judge(channel, status, body) {
  if (!status || status < 200 || status >= 300) return { ok: false, detail: `HTTP ${status} ${body}` };
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: true, detail: body.slice(0, 120) };
  }
  switch (channel) {
    case 'pushplus': {
      if (Number(json.code) === 200) {
        // 注意：PushPlus 的 200 只表示「服务端已收到」，投递是异步的，最终要看手机。
        if (Array.isArray(json.data)) {
          const summary = json.data.map((item) => `${item.channel}:${item.code}`).join(' ');
          return { ok: true, detail: `已提交到 ${json.data.length} 个渠道（${summary}）` };
        }
        return { ok: true, detail: `已提交${json.data ? `（流水号 ${json.data}）` : ''}` };
      }
      const hint = PUSHPLUS_ERRORS[Number(json.code)];
      return { ok: false, detail: `code=${json.code}${hint ? `（${hint}）` : ''} ${json.msg ?? ''}`.trim() };
    }
    case 'serverchan':
      return Number(json.code) === 0
        ? { ok: true, detail: 'ok' }
        : { ok: false, detail: `code=${json.code} ${json.message ?? ''}` };
    case 'wecom':
      return json.errcode === 0
        ? { ok: true, detail: 'ok' }
        : { ok: false, detail: `errcode=${json.errcode} ${json.errmsg ?? ''}` };
    default:
      return { ok: true, detail: 'ok' };
  }
}

/**
 * 发送一条提醒。payload: { title, content }
 * options.request 可注入（单测用），默认走 requestOnce。
 * 返回 { ok, channel, detail }，永不抛异常（推送失败不该影响审批本身）。
 */
export async function send(config, payload, options = {}) {
  const channel = config.channel;
  const title = String(payload.title ?? 'DSH 提醒');
  const content = String(payload.content ?? '');
  const request = options.request ?? requestOnce;
  try {
    switch (channel) {
      case 'pushplus': {
        // pushplus.channel 可写多个：wechat（公众号）、app（PushPlus App，走厂商通道）……
        // 多个时改走 /batchSend，一次请求同时投递，谁先弹手表就镜像谁。
        const channels = String(config.pushplus.channel ?? 'wechat')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        const multi = channels.length > 1;
        const response = await request(multi ? 'https://www.pushplus.plus/batchSend' : 'https://www.pushplus.plus/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: config.pushplus.token.trim(),
            channel: channels.join(','),
            title: title.slice(0, 100),
            content,
            template: config.pushplus.template ?? 'markdown',
          }),
        });
        return { channel: multi ? `pushplus[${channels.join('+')}]` : channel, ...judge(channel, response.status, response.body) };
      }

      case 'serverchan': {
        const sendKey = encodeURIComponent(config.serverchan.sendKey.trim());
        const response = await request(`https://sctapi.ftqq.com/${sendKey}.send`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ title, desp: content }).toString(),
        });
        return { channel, ...judge(channel, response.status, response.body) };
      }

      case 'ntfy': {
        const base = config.ntfy.server.trim().replace(/\/+$/, '');
        // 用 JSON 发布接口：标题/正文里的中文不会被 HTTP header 的 latin-1 限制搞坏。
        const response = await request(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            topic: config.ntfy.topic.trim(),
            title,
            message: content,
            priority: Number(config.ntfy.priority ?? 4),
            tags: String(config.ntfy.tags ?? 'warning').split(',').map((tag) => tag.trim()).filter(Boolean),
          }),
        });
        return { channel, ...judge(channel, response.status, response.body) };
      }

      case 'wecom': {
        const response = await request(config.wecom.webhook.trim(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content: `**${title}**\n${content}` },
          }),
        });
        return { channel, ...judge(channel, response.status, response.body) };
      }

      case 'webhook': {
        const response = await request(config.webhook.url.trim(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.webhook.headers ?? {}) },
          body: JSON.stringify({ title, content }),
        });
        return { channel, ...judge(channel, response.status, response.body) };
      }

      default:
        return { ok: false, channel, detail: `未知渠道 ${channel}` };
    }
  } catch (error) {
    const message = error?.message ?? String(error);
    return { ok: false, channel, detail: /超时/.test(message) ? '请求超时' : message };
  }
}

/** 审批提醒的正文（markdown，直接给人看）。 */
export function buildApprovalMessage(config, approval) {
  const limit = Number.isFinite(config.maxReasonChars) ? config.maxReasonChars : 400;
  const reason = String(approval.reason ?? '').trim();
  const clipped = reason.length > limit ? `${reason.slice(0, limit - 1)}…` : reason;
  const title = `DSH 需要你确认：${approval.toolName || '未知工具'}`;
  const lines = [];
  lines.push(`**工具**：${approval.toolName || '未知'}`);
  if (approval.sessionTitle || approval.sessionId) {
    lines.push(`**会话**：${approval.sessionTitle || String(approval.sessionId).slice(0, 12)}`);
  }
  lines.push(`**时间**：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  if (clipped) lines.push('', `> ${clipped.replace(/\n/g, '\n> ')}`);
  lines.push('', '打开电脑上的 DeepSeek Harness，在提醒卡或会话里点「允许一次」或「拒绝」。');
  return { title, content: lines.join('\n') };
}

/**
 * 推送器：节流 + 去重 + 统计，供宿主半的路由调用。
 */
export function createPusher({ getConfig = loadConfig, logger, request = requestOnce } = {}) {
  const seen = new Map(); // key -> 时间戳
  const recent = []; // 最近推送时间戳，用于每分钟限流
  let lastAt = 0;
  let lastResult = null;

  function throttleReason(now) {
    const config = getConfig();
    if (now - lastAt < Number(config.minIntervalMs ?? 0)) return 'too-soon';
    while (recent.length > 0 && now - recent[0] > 60_000) recent.shift();
    const cap = Number(config.maxPerMinute ?? 60);
    if (recent.length >= cap) return 'rate-limited';
    return null;
  }

  return {
    /** 审批到达时调用。返回 { pushed, reason, result }。 */
    async notify(approval) {
      const config = getConfig();
      if (!config.enabled) return { pushed: false, reason: 'disabled' };
      if (!channelReady(config)) return { pushed: false, reason: 'not-configured' };
      // 人就在屏幕前（窗口有焦点）且配置成「没聚焦才推」时，不打扰手机。
      if (config.notifyWhen === 'unfocused' && approval.focused === true) {
        return { pushed: false, reason: 'focused' };
      }

      const key = String(approval.key ?? `${approval.toolName}:${approval.reason}`);
      const now = Date.now();
      const previous = seen.get(key);
      if (previous !== undefined && now - previous < 10 * 60_000) {
        return { pushed: false, reason: 'duplicate' };
      }
      const throttled = throttleReason(now);
      if (throttled) return { pushed: false, reason: throttled };

      seen.set(key, now);
      lastAt = now;
      recent.push(now);

      const message = buildApprovalMessage(config, approval);
      const result = await send(config, message, { request });
      lastResult = { at: new Date().toISOString(), ...result, key };
      logLine({ event: 'approval-push', key, tool: approval.toolName, channel: result.channel, ok: result.ok, detail: result.detail });
      if (!result.ok) logger?.warn?.(`[approval-push] 推送失败：${result.detail}`);
      return { pushed: result.ok, result };
    },

    /** 自检：立刻用当前配置发一条。 */
    async test() {
      const config = getConfig();
      if (!channelReady(config)) return { ok: false, reason: 'not-configured', channel: config.channel };
      const result = await send(config, {
        title: 'DSH 推送测试',
        content: [
          '**这是一条测试消息**',
          '',
          `渠道：${config.channel}`,
          `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          '',
          '收到它说明：审批提醒能发到你手机上了。',
        ].join('\n'),
      }, { request });
      lastResult = { at: new Date().toISOString(), ...result, test: true };
      logLine({ event: 'push-test', channel: result.channel, ok: result.ok, detail: result.detail });
      return result;
    },

    status() {
      const config = getConfig();
      return {
        enabled: config.enabled,
        channel: config.channel,
        notifyWhen: config.notifyWhen,
        ready: channelReady(config),
        configPath: CONFIG_PATH,
        logPath: LOG_PATH,
        lastResult,
      };
    },

    updateConfig(patch) {
      const next = mergeConfig(getConfig(), patch ?? {});
      saveConfig(next);
      return next;
    },
  };
}
