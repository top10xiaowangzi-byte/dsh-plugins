/**
 * push.mjs 的离线单测：用假的 request 验证各渠道请求形状、成功判定、节流与去重。
 * 运行：node test/push.test.mjs
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  mergeConfig,
  maskConfig,
  channelReady,
  send,
  buildApprovalMessage,
  createPusher,
} from '../push.mjs';

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      process.stdout.write(`ok   ${name}\n`);
    })
    .catch((error) => {
      results.push({ name, ok: false, error });
      process.stdout.write(`FAIL ${name}\n     ${error.message}\n`);
    });
}

function baseConfig(patch) {
  return mergeConfig(DEFAULT_CONFIG, { enabled: true, ...patch });
}

/** 装上假 request，记录每次调用，按 queue 依次回包。 */
function installRequest(replies) {
  const calls = [];
  const queue = [...replies];
  const request = async (url, init) => {
    calls.push({ url: String(url), init });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply instanceof Error) throw reply;
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return { status: reply.status ?? 200, body };
  };
  return { calls, request };
}

const tests = [];

tests.push(['mergeConfig 深合并并忽略未知字段', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { enabled: true, channel: 'ntfy', ntfy: { topic: 'abc' }, nope: 1 });
  assert.equal(merged.enabled, true);
  assert.equal(merged.channel, 'ntfy');
  assert.equal(merged.ntfy.topic, 'abc');
  assert.equal(merged.ntfy.server, 'https://ntfy.sh');
  assert.equal('nope' in merged, false);
}]);

tests.push(['maskConfig 打码密钥但保留可用性', () => {
  const masked = maskConfig(baseConfig({ pushplus: { token: 'abcdefgh12345678' }, ntfy: { topic: 'my-secret-topic-xyz' } }));
  assert.notEqual(masked.pushplus.token, 'abcdefgh12345678');
  assert.notEqual(masked.ntfy.topic, 'my-secret-topic-xyz');
  assert.equal(masked.channel, 'pushplus');
}]);

tests.push(['channelReady 按渠道判断密钥是否齐全', () => {
  assert.equal(channelReady(baseConfig({ channel: 'pushplus', pushplus: { token: 'x' } })), true);
  assert.equal(channelReady(baseConfig({ channel: 'pushplus', pushplus: { token: '  ' } })), false);
  assert.equal(channelReady(baseConfig({ channel: 'ntfy', ntfy: { topic: 't' } })), true);
  assert.equal(channelReady(baseConfig({ channel: 'ntfy', ntfy: { topic: '' } })), false);
  assert.equal(channelReady(baseConfig({ channel: 'wecom', wecom: { webhook: 'https://x' } })), true);
  assert.equal(channelReady(baseConfig({ channel: 'nope' })), false);
}]);

tests.push(['pushplus：URL / 请求体 / code=200 判成功', async () => {
  const { calls, request } = installRequest([{ body: { code: 200, msg: '请求成功', data: 'flow-1' } }]);
  const config = baseConfig({ channel: 'pushplus', pushplus: { token: 'tok123' } });
  const result = await send(config, { title: 'T', content: 'C' }, { request });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://www.pushplus.plus/send');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.token, 'tok123');
  assert.equal(body.title, 'T');
  assert.equal(body.content, 'C');
  assert.equal(body.template, 'markdown');
  assert.equal(body.channel, 'wechat');
  assert.match(result.detail, /flow-1/);
}]);

tests.push(['pushplus：channel/app 可切换，标题截断到 100 字', async () => {
  const { calls, request } = installRequest([{ body: { code: 200 } }]);
  await send(baseConfig({ channel: 'pushplus', pushplus: { token: 't', channel: 'app' } }), { title: '标'.repeat(150), content: 'C' }, { request });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.channel, 'app');
  assert.equal(body.title.length, 100);
}]);

tests.push(['pushplus：channel 写多个时走 /batchSend', async () => {
  const { calls, request } = installRequest([{ body: { code: 200, msg: '执行成功', data: [
    { channel: 'wechat', code: 200, shortCode: 'a' },
    { channel: 'app', code: 200, shortCode: 'b' },
  ] } }]);
  const result = await send(baseConfig({ channel: 'pushplus', pushplus: { token: 't', channel: 'app,wechat' } }), { title: 'T', content: 'C' }, { request });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://www.pushplus.plus/batchSend');
  assert.equal(JSON.parse(calls[0].init.body).channel, 'app,wechat');
  assert.match(result.detail, /2 个渠道/);
}]);

tests.push(['pushplus：错误码翻成人话（903/905/900）', async () => {
  const { request } = installRequest([{ body: { code: 905, msg: '无用户接收消息' } }]);
  const result = await send(baseConfig({ channel: 'pushplus', pushplus: { token: 't' } }), { title: 'T', content: 'C' }, { request });
  assert.equal(result.ok, false);
  assert.match(result.detail, /905/);
  assert.match(result.detail, /实名/);
}]);

tests.push(['pushplus：code≠200 判失败并带原因', async () => {
  const { request } = installRequest([{ body: { code: 999, msg: 'token 错误' } }]);
  const result = await send(baseConfig({ channel: 'pushplus', pushplus: { token: 'bad' } }), { title: 'T', content: 'C' }, { request });
  assert.equal(result.ok, false);
  assert.match(result.detail, /999/);
}]);

tests.push(['serverchan：SendKey 进 URL，title/desp 进表单', async () => {
  const { calls, request } = installRequest([{ body: { code: 0 } }]);
  const result = await send(baseConfig({ channel: 'serverchan', serverchan: { sendKey: 'SCT123abc' } }), {
    title: '标题',
    content: '正文',
  }, { request });
  assert.equal(result.ok, true);
  assert.match(calls[0].url, /^https:\/\/sctapi\.ftqq\.com\/SCT123abc\.send$/);
  const params = new URLSearchParams(calls[0].init.body);
  assert.equal(params.get('title'), '标题');
  assert.equal(params.get('desp'), '正文');
}]);

tests.push(['ntfy：JSON 发布接口，中文标题原样进 body', async () => {
  const { calls, request } = installRequest([{ body: { id: 'abc', event: 'message' } }]);
  const result = await send(baseConfig({ channel: 'ntfy', ntfy: { server: 'https://ntfy.sh/', topic: 'dsh-test' } }), {
    title: '需要确认',
    content: '正文',
  }, { request });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://ntfy.sh');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.topic, 'dsh-test');
  assert.equal(body.title, '需要确认');
  assert.equal(body.message, '正文');
  assert.equal(body.priority, 4);
}]);

tests.push(['wecom：markdown 消息体', async () => {
  const { calls, request } = installRequest([{ body: { errcode: 0, errmsg: 'ok' } }]);
  const result = await send(baseConfig({ channel: 'wecom', wecom: { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' } }), {
    title: 'T',
    content: 'C',
  }, { request });
  assert.equal(result.ok, true);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msgtype, 'markdown');
  assert.match(body.markdown.content, /T/);
}]);

tests.push(['http 非 2xx 判失败', async () => {
  const { request } = installRequest([{ status: 500, body: 'boom' }]);
  const result = await send(baseConfig({ channel: 'webhook', webhook: { url: 'http://127.0.0.1:1/x' } }), { title: 'T', content: 'C' }, { request });
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 500/);
}]);

tests.push(['request 抛错不冒泡，转成 ok:false', async () => {
  const { request } = installRequest([new Error('connect ECONNREFUSED')]);
  const result = await send(baseConfig({ channel: 'webhook', webhook: { url: 'http://127.0.0.1:1/x' } }), { title: 'T', content: 'C' }, { request });
  assert.equal(result.ok, false);
  assert.match(result.detail, /ECONNREFUSED/);
}]);

tests.push(['buildApprovalMessage 截断超长原因并保留工具名', () => {
  const config = baseConfig({ maxReasonChars: 20 });
  const message = buildApprovalMessage(config, { toolName: 'pwsh', reason: '这是一条很长的理由'.repeat(10) });
  assert.match(message.title, /pwsh/);
  assert.match(message.content, /pwsh/);
  assert.ok(message.content.length < 400);
  assert.match(message.content, /…/);
}]);

tests.push(['createPusher：未启用 / 未配置 / 重复 / 节流', async () => {
  let config = baseConfig({ enabled: false });
  const { calls, request } = installRequest([{ body: { code: 200 } }]);
  const pusher = createPusher({ getConfig: () => config, request });

  assert.deepEqual(await pusher.notify({ key: 'a', toolName: 'pwsh', reason: 'r' }), { pushed: false, reason: 'disabled' });

  config = baseConfig({ enabled: true, channel: 'pushplus', pushplus: { token: 't' }, minIntervalMs: 0, maxPerMinute: 100 });
  const first = await pusher.notify({ key: 'a', toolName: 'pwsh', reason: 'r' });
  assert.equal(first.pushed, true);
  assert.equal(calls.length, 1);

  const duplicate = await pusher.notify({ key: 'a', toolName: 'pwsh', reason: 'r' });
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(calls.length, 1);

  config = baseConfig({ enabled: true, channel: 'pushplus', pushplus: { token: 't' }, minIntervalMs: 5000 });
  const throttled = await pusher.notify({ key: 'b', toolName: 'pwsh', reason: 'r2' });
  assert.equal(throttled.reason, 'too-soon');
}]);

tests.push(['createPusher：focused + notifyWhen=unfocused 时不推', async () => {
  const config = baseConfig({ enabled: true, channel: 'pushplus', pushplus: { token: 't' }, notifyWhen: 'unfocused' });
  const { request } = installRequest([{ body: { code: 200 } }]);
  const pusher = createPusher({ getConfig: () => config, request });
  const outcome = await pusher.notify({ key: 'z', toolName: 'pwsh', reason: 'r', focused: true });
  assert.equal(outcome.reason, 'focused');
}]);

for (const [name, fn] of tests) await test(name, fn);

const failed = results.filter((row) => !row.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length > 0) process.exitCode = 1;
