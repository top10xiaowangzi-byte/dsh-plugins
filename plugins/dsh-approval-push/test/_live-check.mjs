/**
 * 真实网络自检（会真的调用外部接口，仅调试用，不发到用户手机上）：
 * 1) 故意用坏 token 打 PushPlus —— 能拿到业务错误码就说明 DNS/TLS/接口都通；
 * 2) ntfy 发一条到随机主题，再读回来 —— 验证发布与回读链路。
 * 运行：node test/_live-check.mjs
 */

import { send, mergeConfig, DEFAULT_CONFIG, requestOnce } from '../push.mjs';

const bad = mergeConfig(DEFAULT_CONFIG, { channel: 'pushplus', pushplus: { token: 'invalid-token-for-test' } });
console.log('pushplus(bad token):', JSON.stringify(await send(bad, { title: 't', content: 'c' })));

const topic = `dsh-approval-${Math.random().toString(36).slice(2, 10)}`;
const ntfy = mergeConfig(DEFAULT_CONFIG, { channel: 'ntfy', ntfy: { topic } });
console.log('ntfy publish:', JSON.stringify(await send(ntfy, { title: 'DSH 链路自检', content: `node:https 直连 OK ${new Date().toISOString()}` })));

const back = await requestOnce(`https://ntfy.sh/${topic}/json?poll=1&since=all`);
const events = back.body.trim().split('\n').map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}).filter(Boolean);
console.log('ntfy readback events:', events.map((event) => event.event).join(','), '| topic:', topic);
console.log(back.status === 200 && events.some((event) => event.event === 'message') ? 'LIVE OK' : 'LIVE FAILED');
