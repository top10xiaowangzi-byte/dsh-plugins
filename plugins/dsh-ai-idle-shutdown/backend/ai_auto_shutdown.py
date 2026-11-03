# -*- coding: utf-8 -*-
"""
AI任务完成自动关机 —— 主程序

它会盯着你指定的 AI 工具（ChatGPT、DeepSeek、WorkBuddy、Cherry Studio、Qoder、WPS 灵犀……）。
只要这些工具里还有任意一个在干活（CPU / 网络 / 子进程有活动），它就安静等着；
等所有工具都彻底安静下来、并且连续安静了指定时长（默认 15 分钟），
它才发出关机指令，并留出 60 秒倒计时——期间又有任务开始、或者你回到电脑前动键鼠，
关机都会自动取消。

用法（一般只需双击「启动监控.bat」）：
    python ai_auto_shutdown.py                 # 正式监控
    python ai_auto_shutdown.py --dry-run       # 演练：一切照走，只是不真的关机
    python ai_auto_shutdown.py --watch         # 实时看每个工具忙不忙（校准用）
    python ai_auto_shutdown.py --list          # 列出当前匹配到的目标进程
    python ai_auto_shutdown.py --status        # 查看正在运行的监控状态
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

# DSH 插件上架版：Python 代码随包分发，包目录可能只读（pnpm store 不可写），
# 所以运行时状态（config / status / log / 停止标记）统一写到宿主指定的数据目录。
# 宿主（index.mjs）通过 DSH_AI_IDLE_SHUTDOWN_HOME 传入，默认仍是脚本同目录（本机原样行为）。
SCRIPT_DIR = Path(__file__).resolve().parent
BASE_DIR = Path(os.environ.get("DSH_AI_IDLE_SHUTDOWN_HOME") or SCRIPT_DIR).expanduser().resolve()
sys.path.insert(0, str(SCRIPT_DIR))

from ai_detector import ActivityDetector, DetectorConfig, TargetDef, _matches_name  # noqa: E402
from ai_guard import (  # noqa: E402
    GuardConfig, GuardEngine, GuardState, STATE_LABELS, ShutdownExecutor,
    format_duration,
)
from ai_winapi import (  # noqa: E402
    create_single_instance_mutex, keep_system_awake, last_input_idle_seconds,
    list_processes, sample_process,
)

VERSION = "1.0"

DEFAULT_CONFIG: dict = {
    # ── 监控哪些 AI 工具（进程名支持 * 通配符，大小写不敏感，可以不带 .exe） ──
    "targets": [
        {"name": "ChatGPT", "patterns": ["ChatGPT.exe"], "enabled": True},
        {"name": "DeepSeek", "patterns": ["DeepSeek Harness.exe"], "enabled": True},
        {"name": "WorkBuddy", "patterns": ["WorkBuddy*.exe"], "enabled": True},
        {"name": "Cherry Studio", "patterns": ["Cherry Studio.exe"], "enabled": True},
        {"name": "Qoder", "patterns": ["Qoder*.exe"], "enabled": True},
        {"name": "WPS 灵犀", "patterns": ["WPS 灵犀.exe"], "enabled": True},
        {"name": "Cursor", "patterns": ["Cursor.exe"], "enabled": True},
    ],
    # ── 「正在干活」的判定阈值 ──
    "cpu_busy_percent": 2.0,      # 目标进程树 CPU 合计超过单核 2% 视为在忙
    "io_busy_kbps": 150.0,        # 目标进程树 IO/网络合计超过 150 KB/s 视为在忙
    "include_child_processes": True,   # 连 Agent 起的 node/python/命令行等子进程一起算
    "treat_spawn_as_activity": True,   # 新冒出子进程也算开始干活
    # ── 时间参数 ──
    "poll_seconds": 2.0,          # 每 2 秒采样一次
    "idle_minutes": 15,           # 全部安静达到多少分钟 → 关机
    "wait_for_first_task": True,  # 先看到任务活动才开始计时（防止空转误关机）
    "no_activity_warn_minutes": 60,  # 一直没活动多久后给出提示
    "countdown_seconds": 60,      # 发出关机指令后的可取消倒计时
    # ── 关机动作与安全 ──
    "action": "shutdown",         # shutdown / restart / sleep / hibernate / lock
    "force_close_apps": False,    # True 时用 /f 强制结束阻止关机程序（可能丢未保存内容）
    "cancel_on_user_input": True, # 倒计时期间你动键鼠 → 自动取消关机
    "stop_on_user_cancel": True,  # 因你使用电脑而取消后，直接停止监控
    "wait_for_user_away": True,   # 关机前确认你已经离开电脑（键鼠空闲）
    "user_away_minutes": 3,       # 键鼠空闲多少分钟算「离开电脑」
    "prevent_sleep": True,        # 监控期间阻止系统自动睡眠
    "dry_run": False,             # True = 只演练不真的关机
    # ── 文件 ──
    "heartbeat_minutes": 5,
    "log_file": "监控日志.txt",
    "status_file": "status.json",
    "stop_flag": "停止监控.flag",
}


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def setup_console() -> None:
    """让 Windows 控制台正确显示中文。"""
    try:
        # line_buffering：输出被重定向到文件/管道时也能及时看到
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:  # noqa: BLE001
        pass
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:  # noqa: BLE001
            pass


def _is_tty() -> bool:
    try:
        return bool(sys.stdout.isatty())
    except Exception:  # noqa: BLE001
        return False


def _clear_line() -> None:
    """抹掉正在刷新的实时状态行（仅交互终端需要）。"""
    if _is_tty():
        sys.stdout.write("\r" + " " * 100 + "\r")
        sys.stdout.flush()


class Logger:
    """同时往控制台和日志文件写；日志超过 5MB 自动改名轮转一次。"""

    MAX_BYTES = 5 * 1024 * 1024

    def __init__(self, path: Path):
        self.path = path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > self.MAX_BYTES:
                backup = path.with_suffix(path.suffix + ".1")
                try:
                    if backup.exists():
                        backup.unlink()
                    path.rename(backup)
                except OSError:
                    pass
            self._fh = open(path, "a", encoding="utf-8")
        except OSError:
            self._fh = None

    def __call__(self, text: str, level: str = "info") -> None:
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{stamp}] {text}"
        if self._fh is not None:
            try:
                self._fh.write(line + "\n")
                self._fh.flush()
            except OSError:
                pass
        _clear_line()
        print(line, flush=True)

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass


def deep_merge(base: dict, override: dict) -> dict:
    result = dict(base)
    for key, value in (override or {}).items():
        if key.startswith("_"):
            continue
        result[key] = value
    return result


def load_config(path: Path) -> dict:
    config = dict(DEFAULT_CONFIG)
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8-sig") as fh:
                user = json.load(fh)
            config = deep_merge(config, user if isinstance(user, dict) else {})
        except (OSError, json.JSONDecodeError) as exc:
            print(f"⚠ 配置文件 {path.name} 读取失败，将使用默认设置：{exc}")
    return config


def build_detector(config: dict) -> ActivityDetector:
    targets = []
    for item in config.get("targets", []):
        targets.append(TargetDef(
            name=str(item.get("name", "未命名")),
            patterns=[str(p) for p in item.get("patterns", [])],
            enabled=bool(item.get("enabled", True)),
        ))
    det_cfg = DetectorConfig(
        targets=targets,
        cpu_busy_percent=float(config.get("cpu_busy_percent", 2.0)),
        io_busy_kbps=float(config.get("io_busy_kbps", 150.0)),
        include_children=bool(config.get("include_child_processes", True)),
        treat_spawn_as_activity=bool(config.get("treat_spawn_as_activity", True)),
        exclude_pids=[os.getpid()],
    )
    return ActivityDetector(det_cfg)


def build_guard_config(config: dict) -> GuardConfig:
    return GuardConfig(
        idle_minutes=float(config.get("idle_minutes", 15)),
        countdown_seconds=int(config.get("countdown_seconds", 60)),
        wait_for_first_task=bool(config.get("wait_for_first_task", True)),
        no_activity_warn_minutes=float(config.get("no_activity_warn_minutes", 60)),
        cancel_on_user_input=bool(config.get("cancel_on_user_input", True)),
        stop_on_user_cancel=bool(config.get("stop_on_user_cancel", True)),
        wait_for_user_away=bool(config.get("wait_for_user_away", True)),
        user_away_minutes=float(config.get("user_away_minutes", 3.0)),
        action=str(config.get("action", "shutdown")),
        force_close_apps=bool(config.get("force_close_apps", False)),
        comment=str(config.get("comment", "AI 任务已全部结束，系统即将关机")),
        heartbeat_seconds=float(config.get("heartbeat_minutes", 5)) * 60.0,
    )


def atomic_write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except OSError:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


def build_status(config: dict, engine: GuardEngine, sample, dry_run: bool,
                 include_processes: list[str] | None = None) -> dict:
    targets = []
    if sample is not None:
        for t in sample.targets:
            targets.append({
                "name": t.name,
                "running": t.running,
                "cpu_percent": round(t.cpu_pct, 2),
                "io_kbps": round(t.io_kbps, 1),
                "busy": t.busy,
            })
    return {
        "version": VERSION,
        "pid": os.getpid(),
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "state": STATE_LABELS.get(engine.state, str(engine.state)),
        "state_code": engine.state.value,
        "dry_run": dry_run,
        "idle_seconds": round(engine.idle_seconds(), 1),
        "idle_minutes_needed": float(config.get("idle_minutes", 15)),
        "idle_remaining_seconds": round(engine.idle_remaining(), 1),
        "countdown_remaining_seconds": (round(engine.countdown_remaining(), 1)
                                        if engine.state is GuardState.COUNTDOWN else None),
        "busy_targets": sample.busy_names() if sample is not None and hasattr(sample, "busy_names") else [],
        "running_targets": include_processes or [],
        "targets": targets,
    }


def truncate(text: str, width: int) -> str:
    return text if len(text) <= width else text[: width - 1] + "…"


def short_busy(sample) -> str:
    try:
        names = sample.busy_names()
    except Exception:  # noqa: BLE001
        return ""
    if not names:
        return ""
    if len(names) <= 2:
        return "、".join(names)
    return "、".join(names[:2]) + f" 等 {len(names)} 个"


# --------------------------------------------------------------------------- #
# 各模式
# --------------------------------------------------------------------------- #
def mode_list(config: dict) -> int:
    detector = build_detector(config)
    procs = list_processes()
    print("当前匹配到的目标进程：")
    total = 0
    for target in detector.cfg.targets:
        if not target.enabled:
            print(f"  {target.name:<14} （已在 config.json 里禁用）")
            continue
        matched = [p for p in procs if _matches_name(p.name, target.patterns)]
        total += len(matched)
        if matched:
            for p in matched[:8]:
                print(f"  {target.name:<14} pid={p.pid:<7} 父进程={p.ppid:<7} {p.name}")
            if len(matched) > 8:
                print(f"  {target.name:<14} …… 还有 {len(matched) - 8} 个进程")
        else:
            print(f"  {target.name:<14} 未运行")
    print(f"\n共匹配到 {total} 个进程。")
    return 0


def mode_status(config: dict) -> int:
    path = BASE_DIR / str(config.get("status_file", "status.json"))
    if not path.exists():
        print("监控程序当前没有运行（找不到 status.json）。")
        print("双击「启动监控.bat」即可开始监控。")
        return 0
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"状态文件读取失败：{exc}")
        return 1
    print("=" * 60)
    print("  AI 任务完成自动关机 —— 当前状态")
    print("=" * 60)
    pid = data.get("pid")
    alive = isinstance(pid, int) and sample_process(pid) is not None
    if not alive:
        print("  ⚠ 监控程序已经退出，以下是它最后一次保存的状态。")
    print(f"  状态        : {data.get('state')}")
    print(f"  更新时间    : {data.get('updated_at')}")
    print(f"  模式        : {'演练（不会真关机）' if data.get('dry_run') else '正式运行'}")
    idle = float(data.get("idle_seconds", 0))
    need = float(data.get("idle_minutes_needed", 15))
    print(f"  已空闲      : {format_duration(idle)} / 需要 {need:g} 分钟")
    if data.get("state_code") == "countdown":
        print(f"  关机倒计时  : {float(data.get('countdown_remaining_seconds') or 0):.0f} 秒")
    busy = data.get("busy_targets") or []
    print(f"  正在干活    : {'、'.join(busy) if busy else '无'}")
    print("-" * 60)
    print(f"  {'工具':<14}{'进程':>5}{'CPU%':>9}{'IO KB/s':>11}   状态")
    for t in data.get("targets", []):
        state = "忙碌" if t.get("busy") else ("空闲" if t.get("running") else "未运行")
        print(f"  {t.get('name', ''):<14}{t.get('running', 0):>5}"
              f"{float(t.get('cpu_percent', 0)):>9.2f}{float(t.get('io_kbps', 0)):>11.1f}   {state}")
    print("=" * 60)
    return 0


def mode_watch(config: dict) -> int:
    detector = build_detector(config)
    print("实时监视模式（只观察，绝不关机和重启）——按 Ctrl+C 退出")
    print(f"阈值：CPU ≥ {config.get('cpu_busy_percent')}% 或 IO ≥ {config.get('io_busy_kbps')} KB/s 视为忙碌")
    print("")
    try:
        while True:
            sample = detector.sample()
            print(f"=== {datetime.now().strftime('%H:%M:%S')} ===")
            for t in sample.targets:
                state = "忙碌" if t.busy else ("空闲" if t.running else "未运行")
                print(f"  {t.name:<14} 进程 {t.running:>3}   CPU {t.cpu_pct:>7.2f}%   "
                      f"IO {t.io_kbps:>9.1f} KB/s   {state}")
            print(f"  → 合计：{'有 AI 正在干活' if sample.any_busy else '全部安静'}")
            print("")
            time.sleep(float(config.get("poll_seconds", 2.0)))
    except KeyboardInterrupt:
        print("已退出监视模式。")
    return 0


def mode_cancel(config: dict) -> int:
    """用户主动取消：撤销系统关机倒计时 + 让监控程序停下来。"""
    import subprocess
    print("正在取消关机倒计时并停止监控……")
    try:
        proc = subprocess.run(["shutdown", "/a"], capture_output=True, text=True,
                              encoding="mbcs", errors="replace", timeout=30)
        if proc.returncode == 0:
            print("✅ 已取消 Windows 的关机倒计时。")
        else:
            print("（当前没有待执行的关机倒计时）")
    except Exception as exc:  # noqa: BLE001
        print(f"执行 shutdown /a 失败：{exc}")

    stop_flag = BASE_DIR / str(config.get("stop_flag", "停止监控.flag"))
    try:
        stop_flag.parent.mkdir(parents=True, exist_ok=True)
        with open(stop_flag, "w", encoding="utf-8") as fh:
            fh.write(f"用户于 {datetime.now():%Y-%m-%d %H:%M:%S} 取消\n")
        print("✅ 已通知监控程序停止（如果它正在运行）。")
    except OSError as exc:
        print(f"⚠ 无法创建停止标记文件：{exc}")
    print("下次双击「启动监控.bat」会重新开始监控。")
    return 0


def mode_once(config: dict) -> int:
    detector = build_detector(config)
    detector.sample()          # 第一轮只建立基线
    time.sleep(float(config.get("poll_seconds", 2.0)))
    sample = detector.sample()
    print(json.dumps({
        "running": sample.running_names(),
        "busy": sample.busy_names(),
        "any_busy": sample.any_busy,
        "targets": [
            {"name": t.name, "running": t.running, "cpu": round(t.cpu_pct, 2),
             "io": round(t.io_kbps, 1), "busy": t.busy}
            for t in sample.targets
        ],
    }, ensure_ascii=False, indent=2))
    return 0


def render_status_line(config: dict, engine: GuardEngine, sample) -> str:
    clock = datetime.now().strftime("%H:%M:%S")
    if engine.state is GuardState.WAITING_FIRST_TASK:
        busy_names = short_busy(sample)
        extra = f" | 运行中程序有活动征兆: {busy_names}" if busy_names else ""
        return (f"[{clock}] 等待 AI 开始工作… 已等待 "
                f"{format_duration(engine.waiting_seconds())}{extra}")
    if engine.state is GuardState.MONITORING:
        idle = engine.idle_seconds()
        need = float(config.get("idle_minutes", 15)) * 60
        busy = short_busy(sample)
        if busy:
            return f"[{clock}] 监控中 | AI 正在干活：{busy} | 空闲计时已清零"
        if idle >= need:
            return f"[{clock}] AI 已安静 {format_duration(idle)}，等你离开电脑后关机"
        return (f"[{clock}] 监控中 | 全部安静 {format_duration(idle)}"
                f" / 还需 {format_duration(max(0.0, need - idle))}")
    if engine.state is GuardState.COUNTDOWN:
        return (f"[{clock}] ⏰ {engine.countdown_remaining():.0f} 秒后"
                f"{config.get('action_label', '关机')}！"
                f"有新的 AI 活动或你动键鼠都会自动取消")
    return f"[{clock}] 已结束"


# --------------------------------------------------------------------------- #
# 正式监控
# --------------------------------------------------------------------------- #
def run_guard(config: dict) -> int:
    log = Logger(BASE_DIR / str(config.get("log_file", "监控日志.txt")))
    stop_flag = BASE_DIR / str(config.get("stop_flag", "停止监控.flag"))
    status_path = BASE_DIR / str(config.get("status_file", "status.json"))
    dry_run = bool(config.get("dry_run", False))

    if stop_flag.exists():
        try:
            stop_flag.unlink()
            log("发现上一次残留的「停止监控.flag」，已清理")
        except OSError:
            pass

    detector = build_detector(config)
    guard_cfg = build_guard_config(config)

    # 键鼠空闲状态读不到时安全降级（否则会永远等不到「用户离开」而永不关机）
    try:
        probe = last_input_idle_seconds()
    except Exception:  # noqa: BLE001
        probe = None
    if probe is None:
        guard_cfg.wait_for_user_away = False
        guard_cfg.cancel_on_user_input = False

    executor = ShutdownExecutor(guard_cfg, logger=log, dry_run=dry_run)
    engine = GuardEngine(guard_cfg, stop_requested_fn=stop_flag.exists)

    # 头信息
    log("=" * 66)
    log(f"AI 任务完成自动关机 v{VERSION} 启动"
        f"{'（演练模式：不会真的关机）' if dry_run else ''}")
    log(f"规则：以下 AI 工具全部安静 {guard_cfg.idle_minutes:g} 分钟后关机；"
        f"有活动就重新计时")
    if guard_cfg.wait_for_first_task:
        log("启动阶段：等待第一次 AI 活动后才开始空闲计时（避免还没开始就关机）")
    else:
        log("启动阶段：直接从启动时刻开始空闲计时")
    log(f"关机动作：{guard_cfg.action}｜可取消倒计时 {guard_cfg.countdown_seconds} 秒"
        f"｜{'检测到键鼠活动会取消关机' if guard_cfg.cancel_on_user_input else '不检测键鼠活动'}")
    if guard_cfg.wait_for_user_away:
        log(f"安全保护：只有你离开电脑（键鼠空闲 {guard_cfg.user_away_minutes:g} 分钟）时才真正关机")
    else:
        log("安全保护：未启用「离开电脑才关机」，即使你正在用电脑也会按计划关机")
    if probe is None:
        log("⚠ 无法读取键鼠空闲状态：已自动停用「离开电脑才关机」和「键鼠取消关机」保护")
    for target in detector.cfg.targets:
        log(f"  · 监控目标：{target.name}  ({', '.join(target.patterns)})"
            f"{'' if target.enabled else '  [已禁用]'}")
    running = detector.describe_running()
    running_text = "、".join(f"{k}×{v}" for k, v in running.items() if v > 0) or "无"
    log(f"当前已运行的 AI 工具：{running_text}")
    if not any(v > 0 for v in running.values()):
        log("⚠ 现在没有检测到任何目标 AI 工具在运行；等你打开它们并开始任务后，我会照常监控")
    if guard_cfg.action != "shutdown":
        log(f"⚠ 注意：当前动作是「{guard_cfg.action}」，不是关机")
    log("-" * 66)

    if config.get("prevent_sleep", True):
        keep_system_awake(True)

    keep_armed_after_exit = False
    non_tty_counter = 0
    poll_seconds = max(0.2, float(config.get("poll_seconds", 2.0)))
    try:
        while True:
            sample = detector.sample()
            events = engine.tick(sample)

            for event in events:
                prefix = {"arm": "⏰ ", "cancel": "✅ ", "warn": "⚠ ", "done": "■ ",
                          "fire": "⏰ ", "state": "▶ ", "info": "· "}.get(event.kind, "")
                log(prefix + event.message)
                if event.kind == "arm":
                    if executor.supports_os_countdown:
                        ok, detail = executor.arm()
                        if not ok:
                            log(engine.abort_countdown("关机指令发送失败").message, "warn")
                    else:
                        # 睡眠/休眠/锁屏没有系统级倒计时，由本程序自己等到倒计时结束再执行
                        log(f"    将在 {guard_cfg.countdown_seconds} 秒后执行"
                            f"「{config.get('action_label')}」，期间可随时取消", "info")
                elif event.kind == "cancel":
                    ok, _detail = executor.cancel()
                    if not ok:
                        log("⚠ 取消关机失败，会继续重试；必要时请手动运行「取消关机.bat」", "warn")
                elif event.kind == "fire":
                    if executor.supports_os_countdown:
                        # 关机/重启已经交给 Windows 倒计时，别再发 cancel
                        if executor.armed:
                            keep_armed_after_exit = True
                    else:
                        ok, _detail = executor.execute_direct()
                        if not ok:
                            log(engine.abort_countdown(
                                f"执行「{config.get('action_label')}」失败").message, "warn")

            # 系统关机倒计时被取消失败时，继续重试（直到成功或已进入关闭流程）
            if executor.armed and engine.state is GuardState.MONITORING:
                ok, _detail = executor.cancel()
                if ok:
                    log("已确认取消系统关机倒计时")

            atomic_write_json(status_path, build_status(
                config, engine, sample, dry_run,
                include_processes=[k for k, v in running.items() if v > 0]))

            if engine.state is GuardState.DONE:
                break

            # 交互终端：同一行实时刷新；被重定向/管道：每 15 秒打一行
            line = render_status_line(config, engine, sample)
            if _is_tty():
                sys.stdout.write("\r" + line[:118].ljust(100))
                sys.stdout.flush()
            else:
                non_tty_counter += 1
                if non_tty_counter >= max(1, int(15 / poll_seconds)):
                    print(line, flush=True)
                    non_tty_counter = 0
            if engine.should_heartbeat():
                log("状态心跳：" + line.strip())
            time.sleep(poll_seconds)
    except KeyboardInterrupt:
        print()
        log("你按下了 Ctrl+C，正在退出监控")
        if executor.armed and not keep_armed_after_exit:
            executor.cancel()
    finally:
        if executor.armed and not keep_armed_after_exit:
            executor.cancel()
        if config.get("prevent_sleep", True):
            keep_system_awake(False)
        log("监控结束。")
        log.close()

    print()
    return 0


# --------------------------------------------------------------------------- #
# 命令行
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="AI 任务完成自动关机：等所有 AI 工具都干完活并空闲指定时间后自动关机",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python ai_auto_shutdown.py                  正式监控（15 分钟后关机）\n"
            "  python ai_auto_shutdown.py --dry-run        演练，不真的关机\n"
            "  python ai_auto_shutdown.py --watch          只看各工具忙不忙\n"
            "  python ai_auto_shutdown.py --idle-minutes 5 --dry-run\n"
        ),
    )
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"),
                        help="配置文件路径（默认同目录 config.json）")
    parser.add_argument("--idle-minutes", type=float, default=None,
                        help="全部安静多少分钟后关机（默认 15）")
    parser.add_argument("--countdown-seconds", type=int, default=None,
                        help="发出关机指令后的可取消倒计时（默认 60 秒）")
    parser.add_argument("--poll-seconds", type=float, default=None,
                        help="采样间隔秒数（默认 2）")
    parser.add_argument("--action", default=None,
                        choices=["shutdown", "restart", "sleep", "hibernate", "lock"],
                        help="满足条件后执行的动作（默认 shutdown 关机）")
    parser.add_argument("--force", action="store_true",
                        help="关机时强制结束阻止关机的程序（可能丢失未保存内容）")
    parser.add_argument("--dry-run", action="store_true", help="演练模式：不真的关机")
    parser.add_argument("--no-wait-first-task", action="store_true",
                        help="启动后立即开始空闲计时（默认要先看到 AI 活动）")
    parser.add_argument("--no-cancel-on-input", action="store_true",
                        help="倒计时期间不因为键鼠活动取消关机")
    parser.add_argument("--no-wait-user-away", action="store_true",
                        help="不检查你是否离开电脑（默认只有键鼠空闲时才关机）")
    parser.add_argument("--no-prevent-sleep", action="store_true",
                        help="监控期间允许系统自动睡眠")
    parser.add_argument("--watch", action="store_true", help="实时监视模式（不关机）")
    parser.add_argument("--list", action="store_true", help="列出匹配到的目标进程")
    parser.add_argument("--status", action="store_true", help="查看当前监控状态")
    parser.add_argument("--cancel", action="store_true",
                        help="取消即将执行的关机并停止正在运行的监控")
    parser.add_argument("--once", action="store_true", help="采样一次并输出 JSON（排错用）")
    parser.add_argument("--version", action="version", version=f"AI 任务完成自动关机 v{VERSION}")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    setup_console()
    args = parse_args(sys.argv[1:] if argv is None else argv)

    config = load_config(Path(args.config))

    # 命令行覆盖
    if args.idle_minutes is not None:
        config["idle_minutes"] = args.idle_minutes
    if args.countdown_seconds is not None:
        config["countdown_seconds"] = args.countdown_seconds
    if args.poll_seconds is not None:
        config["poll_seconds"] = args.poll_seconds
    if args.action is not None:
        config["action"] = args.action
    if args.force:
        config["force_close_apps"] = True
    if args.dry_run:
        config["dry_run"] = True
    if args.no_wait_first_task:
        config["wait_for_first_task"] = False
    if args.no_cancel_on_input:
        config["cancel_on_user_input"] = False
    if args.no_wait_user_away:
        config["wait_for_user_away"] = False
    if args.no_prevent_sleep:
        config["prevent_sleep"] = False

    action_labels = {"shutdown": "关机", "restart": "重启", "sleep": "睡眠",
                     "hibernate": "休眠", "lock": "锁屏"}
    config["action_label"] = action_labels.get(str(config.get("action")).lower(), "关机")

    if args.status:
        return mode_status(config)
    if args.cancel:
        return mode_cancel(config)
    if args.list:
        return mode_list(config)
    if args.once:
        return mode_once(config)
    if args.watch:
        return mode_watch(config)

    # 正式监控：单实例保护
    try:
        mutex_handle, is_first = create_single_instance_mutex()
        if not is_first:
            print("已经有一个监控程序在运行了。")
            print("如果想重启：先双击「取消关机.bat」停止旧的，再重新启动。")
            return 2
    except OSError:
        mutex_handle = None

    print()
    print("  ╔══════════════════════════════════════════════════════╗")
    print("  ║        AI 任务完成自动关机  —  监控中                ║")
    print("  ╚══════════════════════════════════════════════════════╝")
    if config.get("dry_run"):
        print("  【演练模式】本次不会真的关机，只演示完整流程")
    print("  随时可双击「取消关机.bat」立刻中止（或按 Ctrl+C）")
    print()

    try:
        return run_guard(config)
    finally:
        if mutex_handle:
            try:
                pass  # 进程退出时系统自动释放互斥体
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    raise SystemExit(main())
