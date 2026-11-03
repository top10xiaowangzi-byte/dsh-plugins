# 阈值校准与排错（TUNING）

插件只负责「启动 / 停止 / 读状态」，真正的判定在后端 Python 里。想调准阈值、看清每个工具到底忙不忙，
可以直接用后端自带的几个命令行模式（不会启动监控、不会关机）。

以下命令都在**数据目录**里执行（默认 `%USERPROFILE%\.dsh\ai-idle-shutdown`），
`<插件目录>` 指装好的插件包目录（例如 profile 的 `node_modules\dsh-ai-idle-shutdown`）：

```bat
cd /d "%USERPROFILE%\.dsh\ai-idle-shutdown"
set DSH_AI_IDLE_SHUTDOWN_HOME=%CD%
python -B "<插件目录>\backend\ai_auto_shutdown.py" --config "%CD%\config.json" --list
```

> `DSH_AI_IDLE_SHUTDOWN_HOME` 告诉后端把 status / 日志 / 停止标记写在数据目录而不是插件包目录里；
> 插件自己启动监控时会自动设置它。手动跑命令时也建议带上，否则状态文件会写到插件包里。

## 三个排查模式

| 命令 | 作用 | 会不会关机 |
| --- | --- | --- |
| `--list` | 列出每个 `targets` 项当前匹配到的进程名和 PID | 不会 |
| `--once` | 采样两轮，输出 JSON：每个目标 `running / cpu / io / busy` | 不会 |
| `--watch` | 实时刷新「谁在忙、空闲计时还剩多少」 | 不会 |

`--status` 读 `status.json` 看正在运行的监控状态，`--cancel` 撤销关机倒计时并通知监控退出。

## 典型调整

**某个工具根本没被认出来** → `--list` 里它的 `running` 是 0：

1. 看实际进程名（任务管理器 → 详细信息 → 名称），
2. 改 `targets[].patterns`，支持 `*` 通配符、大小写不敏感、可以省略 `.exe`：
   例如 `["Cursor*.exe"]`、`["Code.exe"]`；
3. 重启监控（面板「停止」→「启用」）。

**空闲时也被判成忙碌（倒计时一直重置）** → 用 `--once` 看该目标的 `cpu` / `io` 数值：

- CPU 基线高（Electron 客户端渲染动画）→ 调高 `cpu_busy_percent`，或只给这一项加
  `"cpu_busy_percent": 8.0`（写在 `targets` 项里，覆盖全局）；
- IO 基线高（同步盘、日志、自动更新）→ 调高 `io_busy_kbps`；
- 频繁短尖峰 → 调高 `min_busy_seconds`（如 10）或 `busy_ratio`（如 0.9）。

**真正干活时没被认成忙碌** → 反过来调低阈值：`cpu_busy_percent` 5 → 3、`io_busy_kbps` 200 → 100，
或者调低 `min_busy_seconds` / `busy_ratio`。注意 `poll_seconds` 不建议低于 1 秒（Windows CPU 时间粒度约 15ms，
太密会让 CPU% 呈台阶状）。

**不想监控某个工具** → `"enabled": false`，或直接从 `targets` 里删掉。

**浏览器里的 AI 网页** → 浏览器标签页无法单独识别，只能监控整个浏览器进程；但看视频/开网页也会被算作活动，
所以默认不把浏览器放进 `targets`（双刃剑）。

## 判定规则速查

- 采样对象 = 目标进程 + 它的整棵子进程树（`include_child_processes`，默认 true；agent 起的
  `node` / `python` / `git` 都算）；
- 一次采样里，命中目标的进程树 CPU 合计 ≥ `cpu_busy_percent` 或 IO 合计 ≥ `io_busy_kbps` → 这一次采样算「忙」；
- 最近 `min_busy_seconds` 的窗口里「忙」的占比 ≥ `busy_ratio` → 进入忙碌；
- 忙碌后，最近 `min_quiet_seconds` 的窗口里「忙」的占比 ≤ `quiet_ratio` → 恢复空闲；
- 任一工具忙碌 → 空闲计时清零；全部工具空闲满 `idle_minutes` → 倒计时 → 执行 `action`。

`status.json` 每轮都会写：`state_code`、`pid`、`updated_at`、`idle_remaining_seconds`、
`countdown_remaining_seconds`、`busy_targets`、`running_targets` 等，右侧栏面板就是读它。

## 日志

数据目录里的 `monitor.log`（由 `log_file` 决定）记录每次状态变化、忙碌名单、倒计时、执行结果；
超过 5MB 会自动轮转一次。日志里出现「无法启动 Python」时先确认 `python --version` 能跑通，
再检查 `cordis.patch.yml` 里 `config.python` 是否指对。
