# -*- coding: utf-8 -*-
"""
ai_detector.py —— AI 工具「是否正在干活」的判定引擎

思路：这些 AI 工具全部是 Electron / Chromium 架构（ChatGPT、Cherry Studio、
WorkBuddy、DeepSeek、Qoder 等），它们和它们的子进程在工作时会同时出现两种特征：

    1. CPU 占用上升（渲染流式输出、跑 Agent、编译、执行命令）
    2. IO / 网络流量上升（接收模型返回的 token、读写文件、跑命令）

空闲时这两项都会回落到接近 0。于是按「进程树」聚合 CPU 与 IO 的增量。

但「单次采样超过阈值」并不等于「在干活」：Electron 客户端有大量后台心跳、
动画帧、遥测、更新检查、子进程拉起……在 2 秒粒度上会频繁冒出 1~2 秒的尖峰。
旧版只要一次采样超阈值就算 busy，于是 2 天刷出 1432 次「AI 正在工作」（很多在凌晨）。
现在改成**持续活动判定（去抖 / hysteresis）**：

    · 忙碌要「挣来」：最近 min_busy_seconds 秒的滑动窗口里，超过阈值的采样
      占比必须达到 busy_ratio（默认 0.8），且至少 min_busy_samples（2）个采样超阈值；
      单独一次尖峰、或者「热 1 秒冷 2 秒」的心跳都不会触发。
    · 空闲要「持续安静」：目标一旦 busy，要看最近 min_quiet_seconds 秒的滑动窗口，
      超阈值采样占比回落到 quiet_ratio（默认 0.25）以下才清除 busy。
      短暂掉落不会造成 busy 抖动（避免面板/日志反复「正在工作→安静下来」）。
    · 新子进程默认不再算活动（treat_spawn_as_activity=false）。如果用户显式打开，
      也只认 agent 型子进程（node/python/cmd/git/pwsh… 这些真正执行任务的），
      而且同样要走上面的持续判定，不是出现即忙碌。

只统计目标进程树，不会被浏览器看视频、下载文件等无关活动干扰。
"""
from __future__ import annotations

import fnmatch
import json
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from ai_winapi import list_processes, sample_process


# --------------------------------------------------------------------------- #
# 默认参数
# --------------------------------------------------------------------------- #
# 忙碌判定：最近 min_busy_seconds 秒内「超阈值采样占比」≥ busy_ratio 才算忙
DEFAULT_MIN_BUSY_SECONDS = 6.0
# 空闲判定：最近 min_quiet_seconds 秒内「超阈值采样占比」≤ quiet_ratio 才清除 busy
DEFAULT_MIN_QUIET_SECONDS = 12.0
DEFAULT_BUSY_RATIO = 0.8
DEFAULT_QUIET_RATIO = 0.25
# 窗口里至少要有这么多个「超阈值」采样（防止采样间隔比窗口还大时误判）
MIN_BUSY_SAMPLES = 2

# 只有这些「agent 型」子进程才算活动（仅在 treat_spawn_as_activity=true 时启用）
DEFAULT_AGENT_SPAWN_PATTERNS = [
    "node*", "python*", "cmd.exe", "powershell*", "pwsh*", "git*",
    "bash*", "sh.exe", "wsl*", "npx*", "npm*", "pnpm*", "yarn*",
    "deno*", "bun*", "cargo*", "rustc*", "dotnet*", "java*", "go.exe",
    "make*", "cl.exe", "msbuild*", "gcc*", "g++*", "clang*", "uv.exe", "uvx*",
]

# 允许从 config.json 里补读的新参数（旧主程序只把旧字段传给 DetectorConfig）
TUNING_KEYS = ("min_busy_seconds", "min_quiet_seconds", "busy_ratio", "quiet_ratio")


# --------------------------------------------------------------------------- #
# 配置对象
# --------------------------------------------------------------------------- #
@dataclass
class TargetDef:
    name: str
    patterns: list[str]
    enabled: bool = True
    # 可选：单目标阈值覆盖（None = 用全局阈值），例如某个客户端空闲基线偏高时可以单独调
    cpu_busy_percent: float | None = None
    io_busy_kbps: float | None = None


@dataclass
class DetectorConfig:
    targets: list[TargetDef] = field(default_factory=list)
    # 目标进程树 CPU 合计达到多少（单核百分比）算「这一次采样在干活」
    cpu_busy_percent: float = 5.0
    # 目标进程树 IO 速度达到多少 KB/s 算「这一次采样在干活」
    io_busy_kbps: float = 300.0
    # 是否把子进程（Agent 起的 node/python/命令行等）一起算进来
    include_children: bool = True
    # 新出现子进程是否算活动；默认 false（Electron 后台会不断拉子进程，噪声极大）。
    # 打开时也只认 agent 型子进程，并且同样要满足持续判定。
    treat_spawn_as_activity: bool = False
    # 排除自己这个进程的 PID（防止把监控程序自己算进去）
    exclude_pids: list[int] = field(default_factory=list)
    # ── 去抖参数。None = 从主程序的配置里补读（见 resolve_tuning），显式给值则以显式值优先。
    min_busy_seconds: float | None = None
    min_quiet_seconds: float | None = None
    busy_ratio: float | None = None
    quiet_ratio: float | None = None
    # agent 型子进程的进程名匹配规则；None = 内置默认列表
    agent_spawn_patterns: list[str] | None = None
    # 显式指定去抖参数所在的配置文件；None = 自动找主程序的 --config / 同目录 config.json
    tuning_file: str | None = None


# --------------------------------------------------------------------------- #
# 从 config.json 补读「持续判定」参数
# --------------------------------------------------------------------------- #
def _find_tuning_file(explicit: str | None) -> Path | None:
    """定位主程序正在使用的 config.json。

    ai_auto_shutdown.py 不在本次改动范围内：它构造 DetectorConfig 时只会传旧字段，
    新增的 min_busy_seconds / min_quiet_seconds / busy_ratio 不会自动传进来。
    因此检测器在这里补读同一份配置文件：
        1. 命令行 --config 指定的文件（主程序自己也用它）；
        2. 本文件同目录的 config.json（默认启动方式）。
    """
    if explicit:
        try:
            path = Path(explicit)
            return path if path.is_file() else None
        except OSError:
            return None
    candidates: list[Path] = []
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--config" and i + 1 < len(argv):
            candidates.append(Path(argv[i + 1]))
        elif arg.startswith("--config="):
            candidates.append(Path(arg.split("=", 1)[1]))
    candidates.append(Path(__file__).resolve().with_name("config.json"))
    for path in candidates:
        try:
            if path.is_file():
                return path
        except OSError:
            continue
    return None


def _read_json(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _number(raw: dict, key: str) -> float | None:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def resolve_tuning(config: DetectorConfig) -> dict:
    """把显式参数、config.json 里的参数、内置默认值合成最终的去抖参数。"""
    raw: dict = {}
    source = "explicit"
    need_file = (config.tuning_file is not None
                 or any(getattr(config, key) is None for key in TUNING_KEYS))
    if need_file:
        path = _find_tuning_file(config.tuning_file)
        if path is not None:
            raw = _read_json(path)
            source = str(path)

    def pick(key: str, default: float) -> float:
        explicit = getattr(config, key)
        if explicit is not None:
            return float(explicit)
        from_file = _number(raw, key)
        return default if from_file is None else from_file

    min_busy = pick("min_busy_seconds", DEFAULT_MIN_BUSY_SECONDS)
    min_quiet = pick("min_quiet_seconds", DEFAULT_MIN_QUIET_SECONDS)
    ratio = pick("busy_ratio", DEFAULT_BUSY_RATIO)
    quiet_ratio = pick("quiet_ratio", DEFAULT_QUIET_RATIO)
    patterns = config.agent_spawn_patterns
    if patterns is None:
        patterns = raw.get("agent_spawn_patterns")
    if not patterns:
        patterns = DEFAULT_AGENT_SPAWN_PATTERNS
    # 可选的单目标阈值覆盖：config.json 的 targets 项里写
    # {"name": "ChatGPT", "cpu_busy_percent": 7.0} 即可只调这个目标
    target_overrides: dict[str, dict] = {}
    raw_targets = raw.get("targets")
    if isinstance(raw_targets, list):
        for item in raw_targets:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            cpu = _number(item, "cpu_busy_percent")
            io = _number(item, "io_busy_kbps")
            if cpu is not None or io is not None:
                target_overrides[str(item["name"])] = {
                    "cpu_busy_percent": cpu, "io_busy_kbps": io,
                }
    return {
        "min_busy_seconds": max(0.0, min_busy),
        "min_quiet_seconds": max(0.0, min_quiet),
        "busy_ratio": min(1.0, max(0.0, ratio)),
        "quiet_ratio": min(1.0, max(0.0, quiet_ratio)),
        "agent_spawn_patterns": [str(p) for p in patterns],
        "target_overrides": target_overrides,
        "source": source,
    }


# --------------------------------------------------------------------------- #
# 单个目标的「持续忙碌」判定器（纯逻辑，可用假时钟单独测试）
# --------------------------------------------------------------------------- #
class BusyDebouncer:
    """对单个目标的「这一次采样是否超阈值(hot)」做去抖，输出稳定的 busy。

    规则：
        · busy 从 False → True：最近 min_busy_seconds 秒的滑动窗口里，
          hot 采样占比 ≥ busy_ratio，且 hot 采样数 ≥ MIN_BUSY_SAMPLES，
          并且已经观察了至少 min_busy_seconds 秒（启动后第一次采样算起点）。
          单独一次尖峰永远达不到；「热一下冷一下」的心跳也达不到。
        · busy 从 True → False：最近 min_quiet_seconds 秒的滑动窗口里，
          hot 采样占比 ≤ quiet_ratio 才算「持续安静」。只看「距离上次 hot 多久」
          是不行的：Electron 空闲时也有 10%~50% 的采样偶发超阈值（后台心跳/动画），
          那种情况会让 busy 永远清不掉（永真忙）；用窗口安静占比才能既压噪声
          又不会因为一两次偶发尖峰而卡死。
        · min_busy_seconds / min_quiet_seconds = 0 时退化为「单次采样决定」，
          方便测试或用户想要旧行为时用。
    """

    def __init__(self, min_busy_seconds: float, min_quiet_seconds: float,
                 busy_ratio: float = DEFAULT_BUSY_RATIO,
                 quiet_ratio: float = DEFAULT_QUIET_RATIO,
                 min_busy_samples: int = MIN_BUSY_SAMPLES):
        self.min_busy = max(0.0, float(min_busy_seconds))
        self.min_quiet = max(0.0, float(min_quiet_seconds))
        self.busy_ratio = min(1.0, max(0.0, float(busy_ratio)))
        self.quiet_ratio = min(1.0, max(0.0, float(quiet_ratio)))
        self.min_busy_samples = max(1, int(min_busy_samples))
        self._history: deque[tuple[float, bool]] = deque()
        self._first_at: float | None = None
        self._busy = False
        self._busy_since: float | None = None
        self._evidence = ""

    # ------------------------------------------------------------------ #
    @property
    def busy(self) -> bool:
        return self._busy

    def busy_seconds(self, now: float) -> float:
        if not self._busy or self._busy_since is None:
            return 0.0
        return max(0.0, now - self._busy_since)

    def evidence(self) -> str:
        """判定为忙碌时的证据（写日志用），例如「最近 6 秒有 5/7 次采样超阈值」。"""
        return self._evidence if self._busy else ""

    # ------------------------------------------------------------------ #
    def update(self, now: float, hot: bool) -> bool:
        hot = bool(hot)
        if self._first_at is None:
            self._first_at = now
        self._history.append((now, hot))
        self._prune(now)

        if not self._busy:
            if self._should_go_busy(now, hot):
                self._busy = True
                self._busy_since = now
                if self.min_busy <= 0:
                    self._evidence = "本次采样超阈值"
                else:
                    values = self._window(now, self.min_busy)
                    hot_n = sum(1 for h in values if h)
                    self._evidence = (f"最近 {self.min_busy:g} 秒有 "
                                      f"{hot_n}/{len(values)} 次采样超阈值")
        elif self.min_quiet <= 0:
            # 无滞回：一次「冷」采样就恢复空闲
            self._busy = hot
            if not self._busy:
                self._busy_since = None
                self._evidence = ""
        else:
            window = self._window(now, self.min_quiet)
            if window and sum(1 for h in window if h) / len(window) <= self.quiet_ratio:
                self._busy = False
                self._busy_since = None
                self._evidence = ""
        return self._busy

    # ------------------------------------------------------------------ #
    def _prune(self, now: float) -> None:
        keep_seconds = max(self.min_busy, self.min_quiet, 0.0)
        if keep_seconds <= 0:
            # 无「持续」要求时不需要历史窗口，只保留最近两个采样
            while len(self._history) > 2:
                self._history.popleft()
            return
        window_start = now - keep_seconds
        # 至少保留最近两个采样，避免采样间隔比窗口还大时永远凑不满计数
        while len(self._history) > 2 and self._history[0][0] < window_start:
            self._history.popleft()

    def _window(self, now: float, width: float) -> list[bool]:
        """最近 width 秒内的 hot 序列（至少取最近 2 个采样）。"""
        if width <= 0:
            return [self._history[-1][1]] if self._history else []
        values = [h for t, h in self._history if t >= now - width]
        if len(values) < 2:
            values = [h for _, h in list(self._history)[-2:]]
        return values

    def _should_go_busy(self, now: float, hot: bool) -> bool:
        if self.min_busy <= 0:
            return hot
        if self._first_at is None or now - self._first_at < self.min_busy:
            return False
        values = self._window(now, self.min_busy)
        hot_count = sum(1 for h in values if h)
        if hot_count < self.min_busy_samples:
            return False
        return hot_count / len(values) >= self.busy_ratio


# --------------------------------------------------------------------------- #
# 采样结果
# --------------------------------------------------------------------------- #
@dataclass
class TargetState:
    name: str
    running: int = 0
    cpu_pct: float = 0.0        # 相对单核的百分比，可能 >100
    io_kbps: float = 0.0
    hot: bool = False           # 本次采样是否超阈值（去抖前的原始信号，仅供诊断/测试）
    busy: bool = False          # 去抖后：持续在干活
    busy_seconds: float = 0.0   # 本轮 busy 已经持续了多少秒
    busy_evidence: str = ""     # 判定忙碌的证据（写日志用，如「最近 6 秒有 5/7 次采样超阈值」）
    spawned: bool = False       # 本采样是否出现新进程
    spawned_agent: bool = False  # 新出现的进程里是否有 agent 型（node/python/…）
    error: str = ""


@dataclass
class SampleResult:
    timestamp: float
    elapsed: float
    targets: list[TargetState]
    any_busy: bool = False
    # 采样不可靠（读不到进程信息）时为 True：调用方必须把「看不见」当成未知，
    # 绝不能当成「空闲」，否则可能在任务还在跑时误关机。
    degraded: bool = False
    degraded_reason: str = ""

    def busy_names(self) -> list[str]:
        return [t.name for t in self.targets if t.busy]

    def hot_names(self) -> list[str]:
        return [t.name for t in self.targets if t.hot]

    def spike_names(self) -> list[str]:
        """本次采样超阈值、但还没达到「持续忙碌」标准的目标（短暂尖峰）。"""
        return [t.name for t in self.targets if t.hot and not t.busy]

    def running_names(self) -> list[str]:
        return [t.name for t in self.targets if t.running > 0]


def _matches_name(exe_name: str, patterns: list[str]) -> bool:
    name = exe_name.lower()
    stem = name[:-4] if name.endswith(".exe") else name
    for raw in patterns:
        pat = raw.strip().lower()
        if not pat:
            continue
        if fnmatch.fnmatchcase(name, pat):
            return True
        if fnmatch.fnmatchcase(stem, pat):
            return True
    return False


class ActivityDetector:
    """按进程树增量判断每个 AI 工具是否正在持续工作。"""

    def __init__(self, config: DetectorConfig | None = None):
        self.cfg = config or DetectorConfig()
        self.tuning = resolve_tuning(self.cfg)
        self._prev: dict[tuple[int, int], tuple[float, int]] = {}
        self._prev_time: float | None = None
        self._first_sample_done = False
        self._start_time: float | None = None
        self._exclude = {int(p) for p in self.cfg.exclude_pids}
        self._debouncers: dict[str, BusyDebouncer] = {}
        self._agent_patterns = self.tuning["agent_spawn_patterns"]

    # ------------------------------------------------------------------ #
    def _debouncer(self, name: str) -> BusyDebouncer:
        deb = self._debouncers.get(name)
        if deb is None:
            deb = BusyDebouncer(
                min_busy_seconds=self.tuning["min_busy_seconds"],
                min_quiet_seconds=self.tuning["min_quiet_seconds"],
                busy_ratio=self.tuning["busy_ratio"],
                quiet_ratio=self.tuning["quiet_ratio"],
            )
            self._debouncers[name] = deb
        return deb

    def _target_thresholds(self, tdef: TargetDef) -> tuple[float, float]:
        overrides = self.tuning.get("target_overrides", {}).get(tdef.name, {})
        cpu = tdef.cpu_busy_percent
        io = tdef.io_busy_kbps
        if cpu is None:
            cpu = overrides.get("cpu_busy_percent")
        if io is None:
            io = overrides.get("io_busy_kbps")
        return (self.cfg.cpu_busy_percent if cpu is None else float(cpu),
                self.cfg.io_busy_kbps if io is None else float(io))

    # ------------------------------------------------------------------ #
    def sample(self, now: float | None = None) -> SampleResult:
        now = time.monotonic() if now is None else now
        if self._start_time is None:
            self._start_time = now
        elapsed = 1.0 if self._prev_time is None else max(1e-6, now - self._prev_time)
        self._prev_time = now

        try:
            procs = [p for p in list_processes() if p.pid not in self._exclude]
        except OSError as exc:
            return SampleResult(
                timestamp=now, elapsed=elapsed,
                targets=[TargetState(name=t.name, error=str(exc)) for t in self.cfg.targets],
                degraded=True, degraded_reason=f"无法枚举进程：{exc}",
            )

        name_by_pid: dict[int, str] = {p.pid: p.name for p in procs}
        children: dict[int, list[int]] = {}
        for p in procs:
            children.setdefault(p.ppid, []).append(p.pid)

        # 1) 找出每个目标的根进程
        root_pids: list[set[int]] = []
        target_pids: list[set[int]] = []
        for tdef in self.cfg.targets:
            roots: set[int] = set()
            if tdef.enabled:
                for p in procs:
                    if _matches_name(p.name, tdef.patterns):
                        roots.add(p.pid)
            root_pids.append(set(roots))
            target_pids.append(roots)

        # 2) 展开子进程树
        if self.cfg.include_children:
            for roots in target_pids:
                stack = list(roots)
                seen = set(roots)
                while stack:
                    pid = stack.pop()
                    for child in children.get(pid, ()):
                        if child not in seen:
                            seen.add(child)
                            stack.append(child)
                roots.update(seen)

        # 3) 采样（同一个 PID 只采一次）
        samples: dict[int, object] = {}
        for pids in target_pids:
            for pid in pids:
                if pid not in samples:
                    samples[pid] = sample_process(pid)

        # 3b) 目标根进程「存在但读不到」= 采样不可靠，必须显式标记为 degraded。
        #     （子进程读不到很常见——刚退出就会这样，不算异常。）
        unreadable_roots: list[int] = []
        for roots in root_pids:
            for pid in roots:
                if samples.get(pid) is None:
                    unreadable_roots.append(pid)
        degraded = False
        degraded_reason = ""
        if unreadable_roots:
            try:
                alive = {p.pid for p in list_processes()}
            except OSError:
                alive = set(unreadable_roots)     # 连复核都失败，保守地认为读不到
            unreadable_roots = [pid for pid in unreadable_roots if pid in alive]
            if unreadable_roots:
                degraded = True
                degraded_reason = f"无法读取进程 {unreadable_roots[:5]} 的状态（可能权限不足）"

        # 4) 计算增量 + 持续判定
        states: list[TargetState] = []
        new_prev: dict[tuple[int, int], tuple[float, int]] = {}
        for tdef, pids in zip(self.cfg.targets, target_pids):
            st = TargetState(name=tdef.name, running=len(pids))
            deb = self._debouncer(tdef.name)
            if not tdef.enabled:
                st.error = "已禁用"
                deb.update(now, False)
                states.append(st)
                continue
            cpu_thr, io_thr = self._target_thresholds(tdef)
            cpu_delta = 0.0
            io_delta = 0
            cpu_total = 0.0
            for pid in pids:
                s = samples.get(pid)
                if s is None:
                    continue
                key = (s.pid, s.creation)
                prev = self._prev.get(key)
                if prev is not None:
                    cpu_delta += max(0.0, s.cpu_seconds - prev[0])
                    io_delta += max(0, s.io_bytes - prev[1])
                else:
                    if self._first_sample_done:
                        st.spawned = True
                        if _matches_name(name_by_pid.get(pid, ""), self._agent_patterns):
                            st.spawned_agent = True
                new_prev[key] = (s.cpu_seconds, s.io_bytes)
                cpu_total += s.cpu_seconds
            st.cpu_pct = cpu_delta / elapsed * 100.0
            st.io_kbps = io_delta / elapsed / 1024.0

            # 原始「热」信号：本次采样超阈值（或显式允许时出现 agent 型子进程）
            st.hot = (
                st.cpu_pct >= cpu_thr
                or st.io_kbps >= io_thr
                or (self.cfg.treat_spawn_as_activity and st.spawned_agent)
            )
            deb.update(now, st.hot)
            st.busy = deb.busy
            st.busy_seconds = deb.busy_seconds(now)
            st.busy_evidence = deb.evidence()
            states.append(st)

        # 只保留本轮出现过的进程，避免字典无限增长
        self._prev = new_prev
        self._first_sample_done = True
        return SampleResult(
            timestamp=now, elapsed=elapsed, targets=states,
            any_busy=any(s.busy for s in states),
            degraded=degraded, degraded_reason=degraded_reason,
        )

    # ------------------------------------------------------------------ #
    def describe_running(self) -> dict[str, int]:
        """只做一次轻量进程枚举，返回每个目标当前匹配到的进程数。"""
        procs = list_processes()
        result: dict[str, int] = {}
        for tdef in self.cfg.targets:
            result[tdef.name] = sum(
                1 for p in procs if tdef.enabled and _matches_name(p.name, tdef.patterns)
            )
        return result
