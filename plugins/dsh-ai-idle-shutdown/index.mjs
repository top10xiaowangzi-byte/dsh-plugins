/**
 * dsh-ai-idle-shutdown —— Host half（DSH 右侧栏「AI 工具空闲后自动关机」）
 *
 * 职责：
 * - 把随包分发的 Python 后端（`backend/ai_auto_shutdown.py`）跑起来，探测 Python 解释器与数据目录。
 * - 运行时状态（config.json / status.json / 监控日志 / 停止标记）写到可写数据目录
 *   `~/.dsh/ai-idle-shutdown`（可用 config.dataDir 或 DSH_AI_IDLE_SHUTDOWN_HOME 覆盖）；
 *   包目录保持只读，因此 pnpm store / node_modules 不会被写入。
 * - 每 pollMs 读一次 status.json，把状态机变化整理成中文「活动事件流」（seq 递增，内存保留最近 100 条）。
 * - 通过本地 Web 路由给客户端提供 status / start / stop 三个接口（全部校验本机同源）。
 *
 * 安全说明：
 * - 后端只做采样（ctypes / Windows API），关机动作只由后端在满足条件后执行；
 *   插件本身只负责启动、读取状态、发送 `--cancel`，不会直接调用 shutdown。
 * - 启动用 `python -B`（不写 __pycache__），detached + 隐藏窗口。
 * - 插件卸载只清理自己的定时器与路由；已 detached 的监控进程继续运行，用「停止 / 取消关机」结束。
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-ai-idle-shutdown';
export const inject = ['webServer'];

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = join(PLUGIN_DIR, 'backend');
const SCRIPT_NAME = 'ai_auto_shutdown.py';
const SCRIPT_PATH = join(BACKEND_DIR, SCRIPT_NAME);
const EXAMPLE_CONFIG = join(BACKEND_DIR, 'config.example.json');
const DATA_ENV = 'DSH_AI_IDLE_SHUTDOWN_HOME';
const DEFAULT_DATA_DIR = join(homedir(), '.dsh', 'ai-idle-shutdown');
const DEFAULT_POLL_MS = 500;
const EVENT_LIMIT = 100;
const START_SETTLE_MS = 1500;
const PYTHON_PROBE_TIMEOUT_MS = 8000;

const STATE_LABELS = {
  waiting: '等待 AI 开始工作',
  monitoring: '监控中',
  countdown: '关机倒计时',
  done: '监控结束',
  starting: '正在启动',
  stopped: '未启用',
};

const PYTHON_VERSION_DIRS = ['Python314', 'Python313', 'Python312', 'Python311', 'Python310'];

// --------------------------------------------------------------------------- //
// 路径与 Python 探测
// --------------------------------------------------------------------------- //

/** 解析 Python 解释器：配置优先，其次常见安装位置，最后 PATH 上的 python。 */
function findPython(configured) {
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text && !candidates.includes(text)) candidates.push(text);
  };

  add(configured);
  add(process.env.DSH_AI_IDLE_SHUTDOWN_PYTHON);

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    for (const version of PYTHON_VERSION_DIRS) {
      add(join(localAppData, 'Programs', 'Python', version, 'python.exe'));
    }
  }
  add(join(homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python314', 'python.exe'));

  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const exe of ['python.exe', 'python3.exe']) {
      add(join(dir, exe));
    }
  }

  for (const candidate of candidates) {
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  // 交给 spawn/execFile 按 PATH 解析（如 py.exe / 商店别名）
  return candidates.find((candidate) => !candidate.includes('\\') && !candidate.includes('/')) || 'python';
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** 运行时数据目录：config.dataDir → 环境变量 → ~/.dsh/ai-idle-shutdown。 */
function resolveDataDir(configured) {
  const first = [configured, process.env[DATA_ENV]].find(
    (value) => typeof value === 'string' && value.trim() !== '',
  );
  return resolve(expandHome(first ? first.trim() : DEFAULT_DATA_DIR));
}

/** 建数据目录 + 首次运行时把 config.example.json 复制成 config.json（不覆盖用户改动）。 */
function ensureDataDir(runtime) {
  try {
    if (!existsSync(runtime.dataDir)) mkdirSync(runtime.dataDir, { recursive: true });
    if (!existsSync(runtime.configPath) && existsSync(EXAMPLE_CONFIG)) {
      copyFileSync(EXAMPLE_CONFIG, runtime.configPath);
      runtime.configSeeded = true;
    }
    runtime.dataDirError = null;
  } catch (error) {
    runtime.dataDirError = String(error && error.message ? error.message : error);
  }
}

/** 探测 Python 是否可用：不接管道（受限环境下带管道 spawn 会 EPERM），让子进程把版本写进文件。 */
function probePython(runtime) {
  if (runtime.pythonProbe) return runtime.pythonProbe;
  runtime.pythonProbe = new Promise((resolvePromise) => {
    const versionFile = join(runtime.dataDir, '.python-version');
    // 写版本号只是「顺手」：数据目录不可写时也必须判成 Python 可用，所以整段包在 try 里，
    // 退出码只反映解释器本身能不能执行。
    const code =
      'import sys\n' +
      'try:\n' +
      '    import pathlib\n' +
      `    pathlib.Path(r"${versionFile}").write_text(sys.version.split()[0], encoding="utf-8")\n` +
      'except Exception:\n' +
      '    pass\n';
    let child;
    try {
      child = spawn(runtime.python, ['-c', code], {
        cwd: runtime.dataDir,
        windowsHide: true,
        stdio: 'ignore',
        env: process.env,
      });
    } catch (error) {
      resolvePromise({ ok: false, error: String(error && error.message ? error.message : error) });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: 'timeout' });
    }, PYTHON_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.once('error', (error) => finish({ ok: false, error: String(error && error.message ? error.message : error) }));
    child.once('exit', (code) => {
      let version = null;
      try {
        if (existsSync(versionFile)) version = readFileSync(versionFile, 'utf8').trim() || null;
      } catch {
        /* ignore */
      }
      finish({ ok: code === 0, version, code });
    });
  });
  return runtime.pythonProbe;
}

// --------------------------------------------------------------------------- //
// 通用小工具
// --------------------------------------------------------------------------- //

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** mm:ss（>60 分钟时显示 h:mm:ss）。 */
function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
  return `${pad(minutes)}:${pad(rest)}`;
}

function formatMinutes(minutes) {
  return `${minutes} 分钟`;
}

/** status.json 的 updated_at 是本地时间字符串（YYYY-MM-DD HH:MM:SS）。 */
function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const ms = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(text)) return false;
  }
  return undefined;
}

/** 进程是否存活（Windows 上不存在的 pid 抛 ESRCH；权限不足按存活处理）。 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function busyText(names) {
  if (names.length <= 2) return names.join('、');
  return `${names.slice(0, 2).join('、')} 等 ${names.length} 个`;
}

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

/** 只接受本机同源请求，避免外部网页/远程访问驱动关机监控。 */
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

function respondJson(res, statusCode, payload) {
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function forbid(res) {
  if (res.writableEnded || res.headersSent) return;
  respondJson(res, 403, { ok: false, message: '只允许本机同源访问 / loopback same-origin only' });
}

/** 读取请求 JSON body（宽容：空 body / 非 JSON 一律当空对象）。 */
function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolvePromise) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolvePromise({});
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy?.();
        finish({});
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        finish({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        finish(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
  });
}

// --------------------------------------------------------------------------- //
// 运行时状态
// --------------------------------------------------------------------------- //

function createRuntime(options = {}) {
  const dataDir = resolveDataDir(options.dataDir ?? options.projectDir);
  const runtime = {
    pluginDir: PLUGIN_DIR,
    backendDir: BACKEND_DIR,
    dataDir,
    scriptPath: SCRIPT_PATH,
    configPath: join(dataDir, 'config.json'),
    python: findPython(options.python),
    pollMs: clamp(Number(options.pollMs) || DEFAULT_POLL_MS, 200, 5000),
    dryRunDefault: options.dryRunDefault === true,
    activeConfigPath: null,
    configCache: null,
    configSeeded: false,
    dataDirError: null,
    current: null,
    events: [],
    seq: 0,
    pollPromise: null,
    lastPollError: null,
    pythonProbe: null,
    pythonResult: null,
    spawn: { pid: null, dryRun: null, startedAt: 0 },
  };
  ensureDataDir(runtime);
  return runtime;
}

function defaultConfigPath(runtime) {
  return runtime.activeConfigPath || runtime.configPath;
}

function resolveConfigPath(runtime, value) {
  if (typeof value !== 'string' || !value.trim()) return defaultConfigPath(runtime);
  const text = value.trim();
  return isAbsolute(text) ? resolve(text) : resolve(runtime.dataDir, text);
}

function resolveConfiguredPath(runtime, config, key, fallback) {
  const raw = config && config[key];
  const text = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  return isAbsolute(text) ? resolve(text) : resolve(runtime.dataDir, text);
}

async function readConfig(runtime, configPath) {
  try {
    const info = await stat(configPath);
    if (runtime.configCache && runtime.configCache.path === configPath && runtime.configCache.mtimeMs === info.mtimeMs) {
      return runtime.configCache.data;
    }
    const text = await readFile(configPath, 'utf8');
    const data = JSON.parse(text);
    runtime.configCache = { path: configPath, mtimeMs: info.mtimeMs, data };
    return data;
  } catch (error) {
    throw new Error(`无法读取配置 ${configPath}：${error.message}`);
  }
}

function addEvent(runtime, text, at = Date.now()) {
  runtime.seq += 1;
  runtime.events.push({ seq: runtime.seq, at, text });
  if (runtime.events.length > EVENT_LIMIT) {
    runtime.events.splice(0, runtime.events.length - EVENT_LIMIT);
  }
  return runtime.seq;
}

/** 按「当前时刻」推算剩余秒数（status.json 每秒才更新，客户端再按 serverTime 平滑插值）。 */
function remainingFor(current, atMs) {
  if (!current || !current.running) {
    return { idleRemaining: 0, countdownRemaining: null };
  }
  const elapsedSeconds = current.updatedMs !== null
    ? Math.max(0, (atMs - current.updatedMs) / 1000)
    : Math.max(0, (atMs - current.readAt) / 1000);

  if (current.stateCode === 'monitoring') {
    return {
      idleRemaining: clamp(current.baseIdleRemaining - elapsedSeconds, 0, current.totalSeconds),
      countdownRemaining: null,
    };
  }
  if (current.stateCode === 'countdown') {
    return {
      idleRemaining: 0,
      countdownRemaining: clamp((current.baseCountdownRemaining ?? 0) - elapsedSeconds, 0, current.countdownTotal),
    };
  }
  if (current.stateCode === 'waiting' || current.stateCode === 'starting') {
    return { idleRemaining: current.totalSeconds, countdownRemaining: null };
  }
  return { idleRemaining: 0, countdownRemaining: null };
}

function stateEnteredText(current, previousStateCode) {
  const mmss = formatDuration(current.totalSeconds);
  switch (current.stateCode) {
    case 'waiting':
      return '等待 AI 工具开始工作（首次检测到活动后开始倒计时）';
    case 'monitoring':
      if (previousStateCode === 'countdown') return '关机倒计时已取消 → 继续空闲监控';
      if (previousStateCode === 'waiting') return '检测到 AI 活动 → 开始空闲监控';
      return '进入空闲监控';
    case 'countdown':
      return `进入关机倒计时：${current.countdownTotal} 秒后${current.dryRun ? '（演练，不真关机）' : '执行关机'}，可随时取消`;
    case 'done':
      return `监控结束${current.dryRun ? '（演练模式，未真正关机）' : ''}`;
    case 'starting':
      return '监控进程已启动，等待第一次状态上报…';
    default:
      return `状态：${STATE_LABELS[current.stateCode] || current.stateCode}（${mmss}）`;
  }
}

/** 对比前后两次快照，生成活动事件。 */
function diffEvents(runtime, previous, current) {
  const now = Date.now();
  const mmss = formatDuration(current.totalSeconds);

  if (!previous) {
    if (current.running) {
      addEvent(runtime, `检测到监控已在运行${current.dryRun ? '（演练模式）' : ''}`, now);
      const text = stateEnteredText(current, null);
      if (text) addEvent(runtime, text, now);
    }
    return;
  }

  if (!previous.running && current.running) {
    addEvent(runtime, `监控已启动${current.dryRun ? '（演练模式：不会真的关机）' : '（正式模式：倒计时结束后会关机）'}`, now);
  }
  const endedNow = current.rawStateCode === 'done' && previous.rawStateCode !== 'done';
  if (previous.running && !current.running) {
    addEvent(runtime, endedNow ? `监控已结束${current.dryRun ? '（演练模式，未真正关机）' : ''}` : '监控程序已退出', now);
  } else if (endedNow) {
    addEvent(runtime, `监控已结束${current.dryRun ? '（演练模式，未真正关机）' : ''}`, now);
  }
  if (!current.running) return;

  if (previous.stateCode !== current.stateCode) {
    const text = stateEnteredText(current, previous.stateCode);
    if (text) addEvent(runtime, text, now);
  }

  const added = current.busy.filter((item) => !previous.busy.includes(item));
  const emptied = previous.busy.length > 0 && current.busy.length === 0;
  if (added.length > 0) {
    addEvent(runtime, `「${busyText(added)}」正在工作 → 倒计时重置为 ${mmss}`, now);
  } else if (emptied) {
    addEvent(runtime, `全部 AI 工具已安静 → 重新开始 ${mmss} 倒计时`, now);
  }

  if (
    current.stateCode === 'monitoring' &&
    previous.idleAtRead > 1 &&
    current.idleAtRead <= 0.01
  ) {
    addEvent(runtime, `AI 已连续安静 ${formatMinutes(current.idleMinutes)}，等待你离开电脑后关机`, now);
  }
}

/** 读取一次 status.json，更新 runtime.current 并生成事件。 */
async function doPoll(runtime) {
  ensureDataDir(runtime);
  let config = {};
  let configError = null;
  const configPath = defaultConfigPath(runtime);
  try {
    config = await readConfig(runtime, configPath);
  } catch (error) {
    configError = error.message;
  }

  const statusPath = resolveConfiguredPath(runtime, config, 'status_file', 'status.json');
  let raw = null;
  try {
    raw = JSON.parse(await readFile(statusPath, 'utf8'));
  } catch {
    raw = null;
  }

  const readAt = Date.now();
  const updatedMs = parseTimestamp(raw && raw.updated_at);
  const pid = raw && Number.isInteger(raw.pid) ? raw.pid : null;
  const pidAlive = processAlive(pid);
  const spawnedAlive = processAlive(runtime.spawn.pid);
  const running = Boolean(pidAlive || spawnedAlive);

  const idleMinutesRaw = Number(raw && raw.idle_minutes_needed);
  const idleMinutesFromConfig = Number(config && config.idle_minutes);
  const idleMinutes = Number.isFinite(idleMinutesRaw) && idleMinutesRaw > 0
    ? idleMinutesRaw
    : Number.isFinite(idleMinutesFromConfig) && idleMinutesFromConfig > 0
      ? idleMinutesFromConfig
      : 15;
  const totalSeconds = Math.max(1, Math.round(idleMinutes * 60));

  const countdownFromConfig = Number(config && config.countdown_seconds);
  const countdownTotal = Number.isFinite(countdownFromConfig) && countdownFromConfig > 0
    ? Math.round(countdownFromConfig)
    : 60;

  const stateCode = running
    ? typeof raw?.state_code === 'string' && raw.state_code
      ? raw.state_code
      : 'starting'
    : 'stopped';

  const baseIdleRemaining = Number(raw && raw.idle_remaining_seconds);
  const idleBase = Number.isFinite(baseIdleRemaining) ? baseIdleRemaining : totalSeconds;
  const rawCountdown = raw && raw.countdown_remaining_seconds;
  const countdownBase = typeof rawCountdown === 'number' && Number.isFinite(rawCountdown) ? rawCountdown : null;

  const busy = running && raw && Array.isArray(raw.busy_targets)
    ? raw.busy_targets.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const dryRun = Boolean(
    (raw && raw.dry_run === true) || (spawnedAlive && runtime.spawn.dryRun === true),
  );

  const current = {
    readAt,
    configPath,
    configError,
    statusPath,
    updatedMs,
    updatedAt: raw && typeof raw.updated_at === 'string' ? raw.updated_at : null,
    pid: pidAlive ? pid : spawnedAlive ? runtime.spawn.pid : null,
    pidAlive,
    running,
    stateCode,
    rawStateCode: raw && typeof raw.state_code === 'string' ? raw.state_code : null,
    raw,
    idleMinutes,
    totalSeconds,
    countdownTotal,
    baseIdleRemaining: idleBase,
    baseCountdownRemaining: countdownBase,
    busy,
    dryRun,
  };
  const remaining = remainingFor(current, readAt);
  current.idleAtRead = remaining.idleRemaining;
  current.countdownAtRead = remaining.countdownRemaining;

  diffEvents(runtime, runtime.current, current);
  runtime.current = current;
}

function pollOnce(runtime) {
  if (runtime.pollPromise) return runtime.pollPromise;
  runtime.pollPromise = doPoll(runtime)
    .catch((error) => {
      runtime.lastPollError = String(error && error.message ? error.message : error);
    })
    .finally(() => {
      runtime.pollPromise = null;
    });
  return runtime.pollPromise;
}

/** 生成 GET /ai-idle-shutdown/status 的响应体。 */
function statusResponse(runtime) {
  const now = Date.now();
  const current = runtime.current;
  const pythonInfo = runtime.pythonResult;
  const base = {
    pluginDir: runtime.pluginDir,
    backendDir: runtime.backendDir,
    dataDir: runtime.dataDir,
    projectDir: runtime.dataDir, // 兼容旧字段名
    python: runtime.python,
    pythonOk: pythonInfo ? pythonInfo.ok === true : null,
    pythonVersion: pythonInfo && pythonInfo.version ? pythonInfo.version : null,
    pythonError: pythonInfo && pythonInfo.ok !== true ? pythonInfo.error ?? null : null,
    configSeeded: runtime.configSeeded,
    dataDirError: runtime.dataDirError,
    configPath: defaultConfigPath(runtime),
  };
  if (!current) {
    return {
      ...base,
      serverTime: now,
      running: false,
      pidAlive: false,
      pid: null,
      stateCode: 'stopped',
      stateLabel: STATE_LABELS.stopped,
      idleMinutes: 15,
      countdownSeconds: 900,
      idleRemaining: 0,
      countdownRemaining: null,
      shutdownCountdownTotal: 60,
      busy: [],
      dryRun: false,
      updatedAt: null,
      updatedAgoSeconds: null,
      statusPath: null,
      configError: null,
      events: runtime.events.slice(-EVENT_LIMIT),
      lastSeq: runtime.seq,
    };
  }

  const remaining = remainingFor(current, now);
  return {
    ...base,
    serverTime: now,
    running: current.running,
    pidAlive: current.pidAlive,
    pid: current.pid,
    stateCode: current.stateCode,
    stateLabel: STATE_LABELS[current.stateCode] || current.stateCode,
    idleMinutes: current.idleMinutes,
    countdownSeconds: current.totalSeconds,
    idleRemaining: round1(remaining.idleRemaining),
    countdownRemaining: remaining.countdownRemaining === null ? null : round1(remaining.countdownRemaining),
    shutdownCountdownTotal: current.countdownTotal,
    busy: current.busy,
    dryRun: current.dryRun,
    updatedAt: current.updatedAt,
    updatedAgoSeconds: current.updatedMs !== null ? round1(Math.max(0, (now - current.updatedMs) / 1000)) : null,
    configPath: current.configPath,
    statusPath: current.statusPath,
    configError: current.configError,
    events: runtime.events.slice(-EVENT_LIMIT),
    lastSeq: runtime.seq,
  };
}

// --------------------------------------------------------------------------- //
// 启动 / 停止
// --------------------------------------------------------------------------- //

function monitorArgs(runtime, configPath, dryRun) {
  const args = ['-B', runtime.scriptPath, '--config', configPath];
  if (dryRun) args.push('--dry-run');
  return args;
}

/** 子进程环境：告诉后端把状态写到数据目录。 */
function childEnv(runtime) {
  return { ...process.env, [DATA_ENV]: runtime.dataDir };
}

/**
 * 运行一次 Python 子命令并等待退出。刻意不捕获管道输出：受限环境/沙箱下带管道的
 * child_process 调用可能直接 EPERM；需要细节时读后端自己的日志与 status.json。
 */
function runPython(runtime, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(runtime.python, args, {
        cwd: runtime.dataDir,
        windowsHide: true,
        stdio: 'ignore',
        env: childEnv(runtime),
      });
    } catch (error) {
      resolvePromise({ code: null, error });
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish({ code: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

function startFailureMessage(code, configPath, logPath) {
  if (code === 2) {
    return '监控没有启动：已有一个监控实例在运行（Windows 单实例互斥）。请先在右侧栏「停止 / 取消关机」，1~2 分钟后再试。';
  }
  const logHint = logPath ? `日志：${logPath}` : '';
  if (code === null) return `监控进程被系统终止。${logHint}`;
  return `监控进程启动后立即退出（退出码 ${code}）。请检查 Python 与配置文件：${configPath}${logHint ? `；${logHint}` : ''}`;
}

/** detached + 隐藏窗口启动监控；短暂观察是否立刻退出（如单实例保护返回 2）。 */
function spawnMonitor(runtime, { configPath, dryRun, logPath }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(runtime.python, monitorArgs(runtime, configPath, dryRun), {
        cwd: runtime.dataDir,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: childEnv(runtime),
      });
    } catch (error) {
      resolvePromise({ ok: false, message: `无法启动 Python：${error.message}` });
      return;
    }

    let settled = false;
    const settle = (value) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
      return true;
    };

    const timer = setTimeout(() => {
      if (!settle({ ok: true })) return;
      runtime.spawn = { pid: child.pid, dryRun, startedAt: Date.now() };
      addEvent(runtime, `已启动监控进程${dryRun ? '（演练模式）' : '（正式模式）'}，PID ${child.pid}`, Date.now());
      child.on('exit', (code) => {
        if (runtime.spawn.pid === child.pid) runtime.spawn.pid = null;
        addEvent(runtime, `监控进程已退出${typeof code === 'number' ? `（退出码 ${code}）` : ''}`, Date.now());
        pollOnce(runtime).catch(() => {});
      });
      child.unref();
    }, START_SETTLE_MS);

    child.once('error', (error) => {
      settle({ ok: false, message: `启动 Python 失败：${error.message}` });
    });
    child.once('exit', (code) => {
      settle({ ok: false, code, message: startFailureMessage(code, configPath, logPath) });
    });
  });
}

async function waitForStopped(runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await pollOnce(runtime);
    if (!runtime.current || !runtime.current.running) return false;
    await sleep(400);
  }
  return Boolean(runtime.current && runtime.current.running);
}

// --------------------------------------------------------------------------- //
// 插件入口
// --------------------------------------------------------------------------- //

export function apply(ctx, config = {}) {
  const options = config && typeof config === 'object' ? config : {};
  const runtime = createRuntime(options);

  ctx.logger?.info?.(
    `[ai-idle-shutdown] 数据目录=${runtime.dataDir}；后端=${runtime.backendDir}；python=${runtime.python}；轮询=${runtime.pollMs}ms`,
  );
  if (runtime.dataDirError) {
    ctx.logger?.warn?.(`[ai-idle-shutdown] 数据目录不可用：${runtime.dataDir}（${runtime.dataDirError}）`);
  }
  if (!existsSync(runtime.scriptPath)) {
    ctx.logger?.warn?.(`[ai-idle-shutdown] 未找到随包分发的后端脚本：${runtime.scriptPath}`);
  }
  // 启动时就把 Python 探一遍，UI 首屏即可显示「Python 未找到 / 版本」。
  probePython(runtime)
    .then((result) => {
      runtime.pythonResult = result;
      if (result.ok) {
        ctx.logger?.info?.(`[ai-idle-shutdown] Python 可用${result.version ? `（${result.version}）` : ''}：${runtime.python}`);
      } else {
        ctx.logger?.warn?.(
          `[ai-idle-shutdown] Python 不可用（${runtime.python}）：${result.error || '未知错误'}。请安装 Python 3.10+，或用 config.python 指定解释器。`,
        );
      }
    })
    .catch(() => {});

  ctx.inject(['webServer'], (webCtx) =>
    webCtx.effect(() => {
      const disposers = [];

      // GET / POST /ai-idle-shutdown/status —— 读取状态 + 活动事件流
      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: '/ai-idle-shutdown/status',
        handler: async (req, res) => {
          if (!trusted(req)) {
            forbid(res);
            return;
          }
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.writeHead(405, { allow: 'GET, POST' });
            res.end();
            return;
          }
          try {
            const query = new URL(req.url || '/', 'http://127.0.0.1');
            const configParam = query.searchParams.get('config');
            if (configParam) runtime.activeConfigPath = resolveConfigPath(runtime, configParam);
            await pollOnce(runtime);
            respondJson(res, 200, statusResponse(runtime));
          } catch (error) {
            respondJson(res, 500, { ok: false, message: String(error && error.message ? error.message : error) });
          }
        },
      }));

      // POST /ai-idle-shutdown/start —— 启动监控（可带 {dryRun, config}）
      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: '/ai-idle-shutdown/start',
        handler: async (req, res) => {
          if (!trusted(req)) {
            forbid(res);
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          try {
            const query = new URL(req.url || '/', 'http://127.0.0.1');
            const body = await readJsonBody(req);
            const configParam = body.config ?? query.searchParams.get('config');
            if (configParam) {
              const resolved = resolveConfigPath(runtime, String(configParam));
              if (!existsSync(resolved)) {
                respondJson(res, 200, { ok: false, message: `配置文件不存在：${resolved}` });
                return;
              }
              runtime.activeConfigPath = resolved;
            }
            ensureDataDir(runtime);
            const configPath = defaultConfigPath(runtime);
            if (!existsSync(runtime.scriptPath)) {
              respondJson(res, 200, {
                ok: false,
                message: `找不到随包分发的监控程序：${runtime.scriptPath}（插件包可能不完整，请重新安装）`,
              });
              return;
            }
            if (!existsSync(configPath)) {
              respondJson(res, 200, {
                ok: false,
                message: `配置文件不存在：${configPath}（数据目录不可写？${runtime.dataDirError || runtime.dataDir}）`,
              });
              return;
            }
            // Python 不可用时给出可执行的提示，而不是让 spawn 失败到看不懂。
            if (runtime.pythonResult === null) {
              try {
                runtime.pythonResult = await probePython(runtime);
              } catch {
                /* ignore */
              }
            }
            if (runtime.pythonResult && runtime.pythonResult.ok !== true) {
              respondJson(res, 200, {
                ok: false,
                message:
                  `找不到可用的 Python 3.10+（当前尝试：${runtime.python}）。` +
                  '请安装 Python（python.org，勾选 Add to PATH），或在 cordis.patch.yml 的 config.python 里指定 python.exe 的完整路径。',
                python: runtime.python,
                pythonError: runtime.pythonResult.error ?? null,
              });
              return;
            }
            let monitorConfig;
            try {
              monitorConfig = await readConfig(runtime, configPath);
            } catch (error) {
              respondJson(res, 200, { ok: false, message: error.message });
              return;
            }

            const dryFlag = Boolean(body && 'dryRun' in body) ? body.dryRun : query.searchParams.get('dryRun');
            const parsedDry = parseBoolean(dryFlag);
            const dryRun = parsedDry === undefined ? runtime.dryRunDefault : parsedDry;
            const logPath = resolveConfiguredPath(runtime, monitorConfig, 'log_file', 'monitor.log');

            await pollOnce(runtime);
            if (runtime.current && runtime.current.running) {
              respondJson(res, 200, {
                ok: false,
                message: '监控已经在运行了（单实例保护）',
                pid: runtime.current.pid,
                running: true,
              });
              return;
            }

            addEvent(runtime, `收到「启用」请求${dryRun ? '（演练模式）' : '（正式模式）'}`, Date.now());
            const result = await spawnMonitor(runtime, { configPath, dryRun, logPath });
            if (!result.ok) {
              addEvent(runtime, `启动失败：${result.message}`, Date.now());
              respondJson(res, 200, { ok: false, message: result.message, code: result.code ?? null });
              return;
            }
            await pollOnce(runtime);
            respondJson(res, 200, {
              ok: true,
              message: `监控已启动${dryRun ? '（演练模式：不会真的关机）' : '（正式模式）'}`,
              pid: runtime.spawn.pid,
              dryRun,
              configPath,
              dataDir: runtime.dataDir,
            });
          } catch (error) {
            respondJson(res, 500, { ok: false, message: String(error && error.message ? error.message : error) });
          }
        },
      }));

      // POST /ai-idle-shutdown/stop —— 撤销关机倒计时并停止监控
      disposers.push(webCtx.webServer.register({
        kind: 'exact',
        path: '/ai-idle-shutdown/stop',
        handler: async (req, res) => {
          if (!trusted(req)) {
            forbid(res);
            return;
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          try {
            const query = new URL(req.url || '/', 'http://127.0.0.1');
            const body = await readJsonBody(req);
            const configParam = body.config ?? query.searchParams.get('config');
            if (configParam) runtime.activeConfigPath = resolveConfigPath(runtime, String(configParam));
            ensureDataDir(runtime);
            const configPath = defaultConfigPath(runtime);
            if (!existsSync(configPath)) {
              respondJson(res, 200, { ok: false, message: `配置文件不存在：${configPath}` });
              return;
            }
            if (!existsSync(runtime.scriptPath)) {
              respondJson(res, 200, { ok: false, message: `找不到随包分发的监控程序：${runtime.scriptPath}` });
              return;
            }

            addEvent(runtime, '收到「停止 / 取消关机」请求：撤销系统关机倒计时并通知监控退出', Date.now());
            const result = await runPython(runtime, ['-B', runtime.scriptPath, '--config', configPath, '--cancel'], 30000);
            if (result.error) {
              addEvent(runtime, `停止指令执行失败：${result.error.message}`, Date.now());
              respondJson(res, 200, { ok: false, message: `执行「--cancel」失败：${result.error.message}` });
              return;
            }
            const stillRunning = await waitForStopped(runtime, 6000);
            respondJson(res, 200, {
              ok: true,
              running: stillRunning,
              message: stillRunning
                ? '已发送停止指令，监控进程仍在退出中…'
                : `已停止监控并撤销关机倒计时${result.timedOut ? '（取消命令超时，已等待监控自行退出）' : ''}`,
            });
          } catch (error) {
            respondJson(res, 500, { ok: false, message: String(error && error.message ? error.message : error) });
          }
        },
      }));

      // Host 内部每 pollMs 读取一次 status.json，维护事件流
      pollOnce(runtime).catch(() => {});
      const timer = setInterval(() => {
        pollOnce(runtime).catch((error) => {
          runtime.lastPollError = String(error && error.message ? error.message : error);
        });
      }, runtime.pollMs);
      timer.unref?.();

      return () => {
        clearInterval(timer);
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* ignore */
          }
        }
        // 已 detached 的监控进程不在这里杀：交给「停止 / 取消关机」处理。
      };
    }, 'dsh-ai-idle-shutdown: routes'),
  );
}
