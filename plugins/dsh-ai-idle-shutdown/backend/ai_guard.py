# -*- coding: utf-8 -*-
"""
ai_guard.py —— 监控状态机 + 关机执行器

状态机（与界面/命令行无关，方便单元测试）：

    等待首个任务 ──检测到活动──▶ 监控中 ──连续空闲 idle_minutes──▶ 关机倒计时
                                    ▲                                  │
                                    └────── 又检测到活动 / 用户回来自动取消 ──────┘

「监控中」阶段：只要有任意目标工具在**持续**干活（ai_detector.py 里的去抖判定，
单次 1~2 秒的尖峰不算），空闲计时就清零；连续 idle_minutes 分钟全部安静，
才进入「关机倒计时」，倒计时期间一旦又有任务活动（或用户回到电脑前键鼠有动作），
立即取消关机并回到监控。

日志降噪：状态机只在 busy 状态「真正发生翻转」时写一条「AI 正在工作 / AI 工具已安静下来」；
短暂尖峰（sample.hot 但未达到持续忙碌标准）不会产生任何事件，也不重置计时。
"""
from __future__ import annotations

import subprocess
import time
from dataclasses import dataclass, field
from enum import Enum

from ai_winapi import last_input_idle_seconds


# --------------------------------------------------------------------------- #
# 基础类型
# --------------------------------------------------------------------------- #
class GuardState(str, Enum):
    WAITING_FIRST_TASK = "waiting"      # 还没看到任何 AI 活动
    MONITORING = "monitoring"           # 正在监控，空闲计时中
    COUNTDOWN = "countdown"             # 已发出关机指令，倒计时中（可取消）
    DONE = "done"                       # 结束


STATE_LABELS = {
    GuardState.WAITING_FIRST_TASK: "等待 AI 开始工作",
    GuardState.MONITORING: "监控中",
    GuardState.COUNTDOWN: "关机倒计时",
    GuardState.DONE: "已结束",
}


@dataclass
class GuardEvent:
    """状态机产生的事件，交给主程序打印/写日志/执行关机。"""
    kind: str            # state | info | warn | arm | cancel | done
    message: str


@dataclass
class GuardConfig:
    idle_minutes: float = 15.0
    countdown_seconds: int = 60
    wait_for_first_task: bool = True
    no_activity_warn_minutes: float = 60.0
    cancel_on_user_input: bool = True
    stop_on_user_cancel: bool = True
    # 只有在用户离开电脑（键鼠空闲）时才真正关机，避免正在使用电脑时被关掉
    wait_for_user_away: bool = True
    user_away_minutes: float = 3.0
    action: str = "shutdown"
    force_close_apps: bool = False
    comment: str = "AI 任务已全部结束，系统即将关机"
    # 心跳日志间隔（秒）
    heartbeat_seconds: float = 300.0


def format_duration(seconds: float) -> str:
    """把秒数格式化成「1 小时 03 分」「12.3 秒」这种可读形式。"""
    seconds = max(0.0, float(seconds))
    if seconds >= 3600:
        h = int(seconds // 3600)
        m = int((seconds % 3600) // 60)
        return f"{h} 小时 {m:02d} 分"
    if seconds >= 60:
        m = int(seconds // 60)
        s = int(seconds % 60)
        return f"{m} 分 {s:02d} 秒"
    return f"{seconds:.1f} 秒"


# --------------------------------------------------------------------------- #
# 关机执行器
# --------------------------------------------------------------------------- #
class ShutdownExecutor:
    """真正调用 Windows 关机/重启/睡眠命令。dry_run 时只记录不执行。"""

    def __init__(self, config: GuardConfig, logger=None, dry_run: bool = False):
        self.cfg = config
        self.logger = logger
        self.dry_run = dry_run
        self.armed = False

    # ------------------------------------------------------------------ #
    def _log(self, text: str, level: str = "info") -> None:
        if self.logger is not None:
            self.logger(text, level)

    @property
    def action(self) -> str:
        return (self.cfg.action or "shutdown").lower()

    @property
    def supports_os_countdown(self) -> bool:
        """关机/重启可以交给 Windows 做「N 秒后执行 + shutdown /a 取消」；
        睡眠/休眠/锁屏没有这种机制，需要软件自己倒计时。"""
        return self.action in ("shutdown", "restart")

    def build_arm_command(self) -> list[str]:
        action = self.action
        n = max(0, int(self.cfg.countdown_seconds))
        if action == "restart":
            cmd = ["shutdown", "/r", "/t", str(n)]
        elif action == "hibernate":
            cmd = ["shutdown", "/h"]
        elif action == "sleep":
            cmd = ["rundll32.exe", "powrprof.dll,SetSuspendState", "0,0,0"]
        elif action == "lock":
            cmd = ["rundll32.exe", "user32.dll,LockWorkStation"]
        else:  # shutdown
            cmd = ["shutdown", "/s", "/t", str(n)]
        if action in ("shutdown", "restart"):
            if self.cfg.force_close_apps:
                cmd.append("/f")
            if self.cfg.comment:
                cmd += ["/c", self.cfg.comment[:500]]
        return cmd

    def arm(self) -> tuple[bool, str]:
        """发出关机/重启指令（Windows 自己会在 N 秒后执行）。"""
        cmd = self.build_arm_command()
        shown = " ".join(cmd)
        if self.dry_run:
            self.armed = True
            self._log(f"[模拟运行] 本应执行：{shown}", "dry")
            return True, shown
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  encoding="mbcs", errors="replace", timeout=30)
        except Exception as exc:  # noqa: BLE001
            self._log(f"执行关机命令失败：{exc}", "error")
            return False, str(exc)
        if proc.returncode == 0:
            self.armed = True
            self._log(f"已发出关机指令：{shown}", "info")
            return True, shown
        err = (proc.stderr or proc.stdout or "").strip()
        self._log(f"关机命令返回错误码 {proc.returncode}：{err}", "error")
        return False, err

    def execute_direct(self) -> tuple[bool, str]:
        """立即执行不支持系统倒计时的动作（睡眠/休眠/锁屏）。"""
        cmd = self.build_arm_command()
        shown = " ".join(cmd)
        if self.dry_run:
            self._log(f"[模拟运行] 本应执行：{shown}", "dry")
            return True, shown
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  encoding="mbcs", errors="replace", timeout=30)
        except Exception as exc:  # noqa: BLE001
            self._log(f"执行{self.action}命令失败：{exc}", "error")
            return False, str(exc)
        if proc.returncode == 0:
            self._log(f"已执行：{shown}", "info")
            return True, shown
        err = (proc.stderr or proc.stdout or "").strip()
        self._log(f"{self.action} 命令返回错误码 {proc.returncode}：{err}", "error")
        return False, err

    def cancel(self) -> tuple[bool, str]:
        """取消已经发出的系统关机倒计时。失败时保留 armed 并重试一次。"""
        if not self.armed:
            return True, "当前没有待执行的关机指令"
        if self.dry_run:
            self.armed = False
            self._log("[模拟运行] 本应执行：shutdown /a（取消关机）", "dry")
            return True, "模拟取消"
        last_err = ""
        for attempt in range(2):
            try:
                proc = subprocess.run(["shutdown", "/a"], capture_output=True, text=True,
                                      encoding="mbcs", errors="replace", timeout=30)
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
            else:
                if proc.returncode == 0:
                    self.armed = False
                    self._log("已执行 shutdown /a：取消本次关机", "info")
                    return True, "已取消"
                last_err = (proc.stderr or proc.stdout or "").strip()
            if attempt == 0:
                time.sleep(0.3)
        self._log(f"⚠ 取消关机失败（{last_err}），请手动运行 取消关机.bat 或 shutdown /a", "error")
        return False, last_err


# --------------------------------------------------------------------------- #
# 状态机
# --------------------------------------------------------------------------- #
class GuardEngine:
    """
    只负责「什么时候该发出关机指令 / 什么时候该取消」的决策，
    不碰文件、不碰命令行 —— 方便用假时钟做单元测试。
    """

    def __init__(self, config: GuardConfig,
                 now_fn=time.monotonic,
                 input_idle_fn=last_input_idle_seconds,
                 stop_requested_fn=lambda: False):
        self.cfg = config
        self._now = now_fn
        self._input_idle = input_idle_fn
        self._stop_requested = stop_requested_fn

        self.state = (GuardState.WAITING_FIRST_TASK if config.wait_for_first_task
                      else GuardState.MONITORING)
        self.started_at = self._now()
        self.last_activity: float | None = (None if config.wait_for_first_task
                                            else self.started_at)
        self.armed_at: float | None = None
        self.deadline: float | None = None
        self.input_idle_at_arm: float = 0.0
        self.waited_warning_at: float | None = None
        self.last_heartbeat: float = self.started_at
        self._last_busy = False
        self._last_busy_span = 0.0
        self._waiting_user_away = False
        self._degraded_warned = False

    # ------------------------------------------------------------------ #
    def idle_seconds(self) -> float:
        if self.last_activity is None:
            return 0.0
        return max(0.0, self._now() - self.last_activity)

    def idle_remaining(self) -> float:
        return max(0.0, self.cfg.idle_minutes * 60.0 - self.idle_seconds())

    def countdown_remaining(self) -> float:
        if self.deadline is None:
            return 0.0
        return max(0.0, self.deadline - self._now())

    def waiting_seconds(self) -> float:
        return max(0.0, self._now() - self.started_at)

    def _read_user_idle(self) -> float | None:
        """读键鼠空闲秒数；读不到时返回 None，调用方按「无法判断」降级处理。"""
        try:
            value = self._input_idle()
        except Exception:  # noqa: BLE001
            return None
        if value is None:
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _busy_span(sample) -> float:
        """从采样结果里取「本轮 busy 已持续多少秒」（去抖后的持续时间，用于日志）。"""
        targets = getattr(sample, "targets", None)
        span = 0.0
        try:
            for target in targets or ():
                if getattr(target, "busy", False):
                    span = max(span, float(getattr(target, "busy_seconds", 0.0) or 0.0))
        except (TypeError, ValueError):
            return 0.0
        return span

    def _busy_detail(self, sample) -> str:
        """给日志补充「忙碌证据」：优先显示已持续时长，其次显示去抖窗口里的超阈值次数。"""
        span = self._busy_span(sample)
        if span >= 1.0:
            return f"（已持续 {span:.0f} 秒）"
        targets = getattr(sample, "targets", None)
        try:
            for target in targets or ():
                if getattr(target, "busy", False):
                    evidence = str(getattr(target, "busy_evidence", "") or "")
                    if evidence:
                        return f"（{evidence}）"
        except (TypeError, ValueError):
            return ""
        return ""

    # ------------------------------------------------------------------ #
    def tick(self, sample) -> list[GuardEvent]:
        """推进一次状态机。sample 需要有 any_busy / busy_names() 属性。"""
        now = self._now()
        events: list[GuardEvent] = []
        if self.state is GuardState.DONE:
            return events

        # 1) 停止标记（取消关机脚本会创建它）
        if self._stop_requested():
            if self.state is GuardState.COUNTDOWN:
                events.append(GuardEvent("cancel", "收到停止指令，取消本次关机"))
            self.state = GuardState.DONE
            events.append(GuardEvent("done", "已按你的要求停止监控，电脑不会被关机"))
            return events

        busy = bool(getattr(sample, "any_busy", False))
        busy_names = []
        if hasattr(sample, "busy_names"):
            try:
                busy_names = sample.busy_names()
            except Exception:  # noqa: BLE001
                busy_names = []
        busy_text = "、".join(busy_names[:4]) if busy_names else "AI 工具"
        busy_detail = self._busy_detail(sample)

        # 1b) 采样不可靠（读不到进程信息）：绝不能当成「空闲」，安全起见暂停计时
        degraded = bool(getattr(sample, "degraded", False))
        if degraded:
            if not self._degraded_warned:
                self._degraded_warned = True
                reason = str(getattr(sample, "degraded_reason", "") or "未知原因")
                events.append(GuardEvent(
                    "warn", f"读取 AI 工具进程状态失败（{reason}），先不关机；恢复后继续计时"))
            if self.state is GuardState.COUNTDOWN:
                events.append(GuardEvent("cancel", "读不到 AI 工具状态，已取消关机"))
                self._back_to_monitoring(now)
            elif self.state is GuardState.MONITORING:
                self.last_activity = now
                self._last_busy = False
            return events
        self._degraded_warned = False

        # 2) 等待首个任务阶段
        if self.state is GuardState.WAITING_FIRST_TASK:
            if busy:
                self.state = GuardState.MONITORING
                self.last_activity = now
                self._last_busy = True
                events.append(GuardEvent(
                    "state", f"检测到 AI 开始工作：{busy_text}{busy_detail}，开始监控"))
            else:
                waited = self.waiting_seconds()
                warn_seconds = self.cfg.no_activity_warn_minutes * 60.0
                if waited >= warn_seconds and self.waited_warning_at is None:
                    self.waited_warning_at = now
                    events.append(GuardEvent(
                        "warn",
                        f"已经等了 {format_duration(waited)}，还没有检测到任何 AI 活动。"
                        f"如果你确认任务已经在跑（或想让电脑直接闲置 {self.cfg.idle_minutes:g} 分钟后关机），"
                        f"请用「--no-wait-first-task」重新启动。"))
                return events

        # 3) 关机倒计时阶段
        if self.state is GuardState.COUNTDOWN:
            # 3a) 又有 AI 活动 → 取消关机
            if busy:
                events.append(GuardEvent(
                    "cancel",
                    f"检测到 {busy_text}{busy_detail} 又开始工作了，取消关机，继续监控"))
                self._back_to_monitoring(now)
                self._last_busy = True
                return events
            # 3b) 用户回到电脑前（键鼠有动作）→ 取消
            if self.cfg.cancel_on_user_input:
                current_idle = self._read_user_idle()
                if current_idle is not None:
                    elapsed_since_arm = now - (self.armed_at or now)
                    expected_idle = self.input_idle_at_arm + elapsed_since_arm
                    # 容差 0.3 秒（GetLastInputInfo 精度约 15ms），避免把「刚动一下」漏掉
                    if current_idle < expected_idle - 0.3:
                        events.append(GuardEvent("cancel", "检测到你在使用电脑，已取消关机"))
                        self._back_to_monitoring(now)
                        if self.cfg.stop_on_user_cancel:
                            self.state = GuardState.DONE
                            events.append(GuardEvent(
                                "done", "监控已停止（重新运行「启动监控.bat」可以再次开启）"))
                        return events
            # 3c) 倒计时结束：关机/重启由 Windows 自己执行；睡眠/休眠/锁屏由主程序立即执行
            if now >= (self.deadline or now):
                self.state = GuardState.DONE
                action = _action_name(self.cfg.action)
                events.append(GuardEvent("fire", f"倒计时结束，正在{action}"))
            return events

        # 4) 监控中
        if busy:
            if not self._last_busy:
                events.append(GuardEvent("info", f"AI 正在工作：{busy_text}{busy_detail}"))
            self.last_activity = now
            self._last_busy = True
            self._last_busy_span = self._busy_span(sample)
            self._waiting_user_away = False
        else:
            if self._last_busy:
                worked = (f"（刚才持续工作约 {self._last_busy_span:.0f} 秒）"
                          if self._last_busy_span >= 1.0 else "")
                events.append(GuardEvent(
                    "info", f"AI 工具已安静下来{worked}，开始累计空闲时间"
                            f"（满 {self.cfg.idle_minutes:g} 分钟就关机）"))
                self._last_busy = False
                self._last_busy_span = 0.0
            idle = self.idle_seconds()
            if self.last_activity is None:
                self.last_activity = now
            elif idle >= self.cfg.idle_minutes * 60.0:
                # AI 已经安静够久，再确认一下用户不在电脑前，避免你在用电脑时被关机
                if self.cfg.wait_for_user_away:
                    user_idle = self._read_user_idle()
                    need = max(0.0, self.cfg.user_away_minutes) * 60.0
                    if user_idle is not None and user_idle < need:
                        if not self._waiting_user_away:
                            self._waiting_user_away = True
                            events.append(GuardEvent(
                                "info",
                                f"AI 已经安静 {self.cfg.idle_minutes:g} 分钟，但你还在用电脑，先不关机；"
                                f"等你离开（键鼠空闲 {self.cfg.user_away_minutes:g} 分钟）后自动关机"))
                        return events
                self._waiting_user_away = False
                self.state = GuardState.COUNTDOWN
                self.armed_at = now
                self.deadline = now + max(0, self.cfg.countdown_seconds)
                armed_input_idle = self._read_user_idle()
                self.input_idle_at_arm = armed_input_idle if armed_input_idle is not None else 0.0
                events.append(GuardEvent(
                    "arm",
                    f"所有 AI 工具已经连续 {self.cfg.idle_minutes:g} 分钟没有动静，"
                    f"判定任务全部结束。{self.cfg.countdown_seconds} 秒后{_action_name(self.cfg.action)}"
                    f"（期间有 AI 活动或你动键鼠都会自动取消）"))
        return events

    # ------------------------------------------------------------------ #
    def abort_countdown(self, reason: str = "关机指令执行失败") -> GuardEvent:
        """关机命令没能发出去时，退回监控状态（再等一轮空闲后重试）。"""
        self.state = GuardState.MONITORING
        self.last_activity = self._now()
        self.armed_at = None
        self.deadline = None
        self._last_busy = False
        self._waiting_user_away = False
        return GuardEvent("warn", f"{reason}，已退回监控状态，{self.cfg.idle_minutes:g} 分钟后再试")

    def _back_to_monitoring(self, now: float) -> None:
        self.state = GuardState.MONITORING
        self.last_activity = now
        self.armed_at = None
        self.deadline = None
        self._waiting_user_away = False

    def should_heartbeat(self) -> bool:
        now = self._now()
        if now - self.last_heartbeat >= self.cfg.heartbeat_seconds:
            self.last_heartbeat = now
            return True
        return False


def _action_name(action: str) -> str:
    return {
        "shutdown": "关机",
        "restart": "重启",
        "sleep": "睡眠",
        "hibernate": "休眠",
        "lock": "锁屏",
    }.get((action or "shutdown").lower(), "关机")
