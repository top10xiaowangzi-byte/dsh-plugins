# dsh-ai-idle-shutdown

**Windows-only sidebar plugin for DeepSeek Harness: shut the PC down when your AI desktop apps stop working.**

The plugin watches the AI desktop tools you actually run — ChatGPT, DeepSeek Harness, WorkBuddy, Cherry Studio, Qoder,
WPS Lingxi, Cursor, or any process list you configure — tracks whether each one is still working (CPU and IO of its
whole process tree, with debounce), and once **all of them** have been idle for a configurable number of minutes it
issues a shutdown with a cancellable countdown. The timer resets the moment any of them starts working again, and it
cancels when you start using the keyboard/mouse.

> English | [中文](#中文)

---

## Why this one

| Plugin | What it watches | When it shuts down |
| --- | --- | --- |
| **dsh-ai-idle-shutdown** (this) | **external AI desktop apps** (ChatGPT, DeepSeek desktop, WorkBuddy, Cherry Studio, Qoder, Cursor, ...) by process-tree CPU/IO | after every watched app has been idle for `idle_minutes` |
| `dsh-auto-shutdown` (ypx01) | DeepSeek Harness **sessions** | after armed sessions have no running turn |
| `dsh-shutdown-after-task` | DeepSeek Harness **tasks** | after DSH tasks complete |
| `dsh-power-xc` | nothing — manual power menu | when you click restart/shutdown |

The others only know about DeepSeek Harness. This one follows the AI apps that do the work on your desktop, which is
what you want when a long agent run happens in ChatGPT / Cursor / Qoder / WorkBuddy while you are away.

## How it decides "still working"

Every `poll_seconds` (default 2s) the bundled Python backend samples each watched target's whole process tree
(children included, because agents spawn node/python/git) and compares CPU time + IO counters between samples.

- one 1–2 second spike does not count;
- a target is **busy** only when most samples in the last `min_busy_seconds` (default 6s) exceed the thresholds
  (`cpu_busy_percent`, `io_busy_kbps`);
- it goes quiet only after most samples in the last `min_quiet_seconds` (default 12s) are below the thresholds;
- any busy target resets the idle timer.

That debounce is the difference between "works" and "shuts down while the model is still streaming": Electron apps
have background timers and updaters, and a naive `new process ⇒ busy` rule flaps constantly.

## Safety

- **Dry-run first**: the checkbox on the panel runs the whole flow with `--dry-run`; nothing is ever executed.
- **Cancellable countdown** (`countdown_seconds`, default 60): new AI activity, or any keyboard/mouse input, cancels it.
- **Wait for you to leave** (`wait_for_user_away`): even after the idle timer expires it only shuts down once the
  keyboard/mouse have been idle for `user_away_minutes` (default 3) — so it never pulls the rug while you are typing.
- **Single instance** (Windows mutex): a second monitor refuses to start instead of double-counting.
- **No network, no telemetry, no credentials**: everything is local (ctypes + Windows API), state is three files in
  `~/.dsh/ai-idle-shutdown`.

## Requirements

- **Windows 10/11** (the backend samples process IO/CPU through `kernel32`/`user32`; the package declares `"os": ["win32"]`).
- **Python 3.10+** on `PATH`, or Python installed under `%LOCALAPPDATA%\Programs\Python\Python31x`, or point
  `config.python` at your `python.exe`. The plugin ships the Python backend itself — only the interpreter is required.
- **DeepSeek Harness 0.2.1-rc.1+** (right-sidebar client APIs).

## Install

From the plugin market: open **Plugins → Plugin Market**, find *AI Idle Auto-Shutdown*, install, then restart the host.

From the CLI:

```sh
dsh plugin --profile <profile> add github:top10xiaowangzi-byte/dsh-plugins#path:/plugins/dsh-ai-idle-shutdown
# or from npm, if published: dsh plugin --profile <profile> add dsh-ai-idle-shutdown
```

Restart DSH afterwards (the host half and the right-sidebar tab load at boot).

## Use

1. Open any session, open the right sidebar, click `+`, and pick **AI 自动关机** (or click the power icon in the
   session header).
2. Optionally tick **演练模式（不会真的关机）** the first time.
3. **✅ 启用** starts the monitor; the panel shows the live countdown, which app is currently working, and a recent
   activity log ("「DeepSeek」正在工作 → 倒计时重置为 15:00", "进入关机倒计时…").
4. **⏹ 停止 / 取消关机** aborts the countdown and stops the monitor.

The panel is provided by this plugin and is off by default; the monitor only runs while you started it (or a previous
monitor process is still alive — the panel shows it either way).

## Configuration

The first run copies the bundled template to `%USERPROFILE%\.dsh\ai-idle-shutdown\config.json`; edit that file (the
panel's "config" line shows the exact path) and restart the monitor by Stop → Start.

Most useful keys (full annotated file: [`backend/config.example.json`](./backend/config.example.json)):

| Key | Default | Meaning |
| --- | --- | --- |
| `targets` | ChatGPT, DeepSeek, WorkBuddy, Cherry Studio, Qoder, WPS 灵犀, Cursor | what to watch; `patterns` are process names with `*` wildcards, `enabled: false` skips one |
| `idle_minutes` | 15 | shut down after all targets stay quiet this long |
| `countdown_seconds` | 60 | cancellable countdown before the action |
| `action` | `shutdown` | `shutdown` / `restart` / `sleep` / `hibernate` / `lock` |
| `cpu_busy_percent` / `io_busy_kbps` | 5.0 / 200 | per-sample "working" thresholds |
| `poll_seconds` | 2.0 | sampling interval |
| `dry_run` | false | force dry-run from the config too |
| `wait_for_user_away` | true | require keyboard/mouse idle before the action |

Overrides that live in the plugin's `cordis.patch.yml` (`config:`) instead of `config.json`:

```yaml
- id: ai-idle-shutdown
  name: dsh-ai-idle-shutdown
  config:
    dataDir: D:\somewhere\state   # default %USERPROFILE%\.dsh\ai-idle-shutdown
    python: C:\Python312\python.exe
    pollMs: 500                   # how often the host re-reads status.json
    dryRunDefault: false
```

## Repository layout

```
.
├─ package.json              # DSH manifest: bundle patch + client entry (dsh.bundle / dsh.client)
├─ cordis.patch.yml          # inserts the host row into a profile's layer stack
├─ index.mjs                 # host half: /ai-idle-shutdown/{status,start,stop}, status polling, activity events
├─ client.js                 # browser half: right-sidebar tab type + panel + header shortcut
├─ backend/                  # bundled Python backend (no third-party deps, Windows API only)
│  ├─ ai_auto_shutdown.py    # CLI + monitor loop
│  ├─ ai_detector.py         # per-target CPU/IO sampling and debounce
│  ├─ ai_guard.py            # state machine, countdown, executor
│  ├─ ai_winapi.py           # ctypes wrappers (processes, IO counters, idle time, mutex)
│  ├─ config.example.json    # seeded into the data dir on first run
│  └─ TUNING.md              # how to calibrate thresholds / watch live
├─ locale/{zh,en}.json       # plugin manager title/description
├─ icon.svg
├─ test/host.test.mjs        # offline integration test (mock webServer + real backend, dry-run only)
└─ .github/workflows/ci.yml
```

## Development

```sh
node build-ai-idle-shutdown.mjs   # (in the packaging workspace) regenerates client/backend/package files
node test/host.test.mjs           # needs Python; DSH_TEST_PYTHON=... to pick an interpreter
node --check index.mjs && node --check client.js
python -m py_compile backend/*.py
```

The test mounts the host half on a fake `webServer`, lets it spawn the real bundled backend in a temporary data
directory, starts it in dry-run mode and stops it again — it asserts the routes, the same-origin gate, the status
shape and the cancel path. **No test path can shut the machine down.**

## License

MIT — see [LICENSE](./LICENSE). The Python backend is the author's own local tool, bundled here so the plugin works
without a separate checkout.

---

## 中文

**Windows 专用**的 DeepSeek Harness 右侧栏插件：等你的 AI 桌面工具都干完活、安静一段时间后，自动关机。

它会盯着你真正在用的 AI 客户端——ChatGPT、DeepSeek Harness、WorkBuddy、Cherry Studio、Qoder、WPS 灵犀、Cursor，
也可以自己改 `targets` 列表——按**整个进程树的 CPU / IO** 判断谁还在干活（带去抖，1~2 秒的尖峰不算）。全部工具
连续安静 `idle_minutes`（默认 15）分钟后发出关机指令，并留 `countdown_seconds`（默认 60 秒）可取消倒计时；
任一工具重新开始工作、或你动了键盘/鼠标，都会取消。

**和市面同类插件的区别**：`dsh-auto-shutdown`（ypx01）看的是 DSH 会话有没有跑完、`dsh-shutdown-after-task` 看 DSH
任务、`dsh-power-xc` 是手动电源菜单。本插件看的是**在别的 AI 桌面工具里跑的长任务**（ChatGPT / Cursor / Qoder /
WorkBuddy……），这是它们都覆盖不到的场景。

**安全设计**

- 先用「演练模式（不会真的关机）」跑一遍，全程只演练不执行；
- 倒计时期间有 AI 新活动、或你动了键鼠，自动取消；
- 即使空闲计时到了，还要确认你已离开电脑（键鼠空闲 `user_away_minutes` 分钟）才真正关机；
- Windows 单实例互斥，重复点击不会启动第二个监控；
- 纯本地：不联网、无遥测、无凭据，状态只有数据目录里的三个文件。

**要求**：Windows 10/11、Python 3.10+（`PATH` / `%LOCALAPPDATA%\Programs\Python\Python31x` / 配置里 `python` 指定三选一）、
DSH 0.2.1-rc.1+。Python 后端随插件分发，不需要另外下载。

**安装**：Plugins → Plugin Market 搜 *AI Idle Auto-Shutdown*，安装后重启宿主；或
`dsh plugin --profile <profile> add github:top10xiaowangzi-byte/dsh-plugins#path:/plugins/dsh-ai-idle-shutdown`。

**使用**：打开右侧栏 → `+` → 「AI 自动关机」（或会话标题栏的电源图标）→ 勾选演练模式试一次 →「✅ 启用」；
「⏹ 停止 / 取消关机」撤销倒计时并停止监控。

**配置**：首次运行会把模板复制到 `%USERPROFILE%\.dsh\ai-idle-shutdown\config.json`（面板上显示完整路径），
改完 Stop → Start 生效。常用键见上方表格，完整带注释的模板在
[`backend/config.example.json`](./backend/config.example.json)，阈值校准方法见 [`backend/TUNING.md`](./backend/TUNING.md)。
`dataDir` / `python` / `pollMs` / `dryRunDefault` 可在插件配置（`cordis.patch.yml` 的 `config:`）里覆盖。
