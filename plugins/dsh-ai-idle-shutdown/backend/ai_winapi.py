# -*- coding: utf-8 -*-
"""
ai_winapi.py —— 纯 ctypes 实现的 Windows 进程采样层（不依赖任何第三方库）

对外提供：
    list_processes()          -> 当前系统所有进程（pid / 父pid / 进程名）
    sample_process(pid)       -> 单个进程的 CPU 时间、IO 字节数（累积值）
    last_input_idle_seconds() -> 距离用户最后一次键鼠输入的秒数
    get_tick_count64()        -> 系统启动至今的毫秒数

为什么不用 psutil：目标机器没装第三方包，而 Windows 自带的这些 API 足够快、足够准。
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
from dataclasses import dataclass

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MAX_PATH = 260
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


# --------------------------------------------------------------------------- #
# 结构体
# --------------------------------------------------------------------------- #
class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD),
                ("dwHighDateTime", wintypes.DWORD)]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * MAX_PATH),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


# --------------------------------------------------------------------------- #
# 函数签名（64 位下必须显式声明，否则句柄会被截断）
# --------------------------------------------------------------------------- #
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32FirstW.restype = wintypes.BOOL
kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.restype = wintypes.BOOL

kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE

kernel32.GetProcessTimes.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME),
    ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME),
]
kernel32.GetProcessTimes.restype = wintypes.BOOL

kernel32.GetProcessIoCounters.argtypes = [wintypes.HANDLE, ctypes.POINTER(IO_COUNTERS)]
kernel32.GetProcessIoCounters.restype = wintypes.BOOL

kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL

kernel32.GetTickCount64.argtypes = []
kernel32.GetTickCount64.restype = ctypes.c_uint64

kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
kernel32.CreateMutexW.restype = wintypes.HANDLE

kernel32.SetThreadExecutionState.argtypes = [ctypes.c_uint]
kernel32.SetThreadExecutionState.restype = ctypes.c_uint

user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
user32.GetLastInputInfo.restype = wintypes.BOOL

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ERROR_ALREADY_EXISTS = 183


# --------------------------------------------------------------------------- #
# 数据结构
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ProcessEntry:
    """一次进程快照里的单个进程。"""
    pid: int
    ppid: int
    name: str


@dataclass(frozen=True)
class ProcessSample:
    """单个进程的累积计数（不是瞬时值）。"""
    pid: int
    creation: int          # 进程创建时间（FILETIME，用来识别 PID 复用）
    cpu_seconds: float     # 用户态 + 内核态 CPU 累计秒数
    io_bytes: int          # 读写总字节数（含网络 socket 收发）


def _filetime_to_int(ft: FILETIME) -> int:
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def list_processes() -> list[ProcessEntry]:
    """枚举系统所有进程。失败时抛 OSError。"""
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE or not snap:
        raise OSError(ctypes.get_last_error(), "CreateToolhelp32Snapshot 失败")
    entries: list[ProcessEntry] = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            entries.append(ProcessEntry(
                pid=int(entry.th32ProcessID),
                ppid=int(entry.th32ParentProcessID),
                name=str(entry.szExeFile),
            ))
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return entries


def sample_process(pid: int) -> ProcessSample | None:
    """读取单个进程的累积 CPU / IO。没有权限或进程已退出时返回 None。"""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        creation = FILETIME()
        exit_time = FILETIME()
        kernel_time = FILETIME()
        user_time = FILETIME()
        ok = kernel32.GetProcessTimes(
            handle, ctypes.byref(creation), ctypes.byref(exit_time),
            ctypes.byref(kernel_time), ctypes.byref(user_time),
        )
        if not ok:
            return None
        cpu_100ns = _filetime_to_int(kernel_time) + _filetime_to_int(user_time)
        io = IO_COUNTERS()
        io_ok = kernel32.GetProcessIoCounters(handle, ctypes.byref(io))
        io_bytes = int(io.ReadTransferCount + io.WriteTransferCount) if io_ok else 0
        return ProcessSample(
            pid=pid,
            creation=_filetime_to_int(creation),
            cpu_seconds=cpu_100ns / 10_000_000.0,
            io_bytes=io_bytes,
        )
    finally:
        kernel32.CloseHandle(handle)


def get_tick_count64() -> int:
    return int(kernel32.GetTickCount64())


def last_input_idle_seconds() -> float | None:
    """
    距离用户最后一次键盘/鼠标输入的秒数。
    读取失败时返回 None（由调用方决定降级策略，不要静默当成 0）。
    """
    info = LASTINPUTINFO()
    info.cbSize = ctypes.sizeof(LASTINPUTINFO)
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return None
    now = get_tick_count64()
    # dwTime 是 32 位毫秒计数（约 49.7 天回绕），用 2^32 取模求差
    elapsed_ms = (now - int(info.dwTime)) % (1 << 32)
    return elapsed_ms / 1000.0


def is_process_elevated() -> bool:
    """当前进程是否以管理员身份运行（仅供参考，本程序不要求管理员）。"""
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def create_single_instance_mutex(name: str = r"Local\AI_TASK_AUTO_SHUTDOWN_GUARD"):
    """
    创建单实例互斥体。返回 (handle, is_first_instance)。
    handle 需要保持到进程结束（进程退出时系统自动释放）。
    """
    handle = kernel32.CreateMutexW(None, False, name)
    if not handle:
        raise OSError(ctypes.get_last_error(), "CreateMutexW 失败")
    already_exists = (ctypes.get_last_error() == ERROR_ALREADY_EXISTS)
    return handle, not already_exists


def keep_system_awake(enabled: bool = True) -> bool:
    """
    监控期间阻止系统自动睡眠（否则 AI 任务会被挂起）。
    enabled=False 时恢复系统默认电源策略。
    """
    flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if enabled else 0)
    return bool(kernel32.SetThreadExecutionState(flags))
