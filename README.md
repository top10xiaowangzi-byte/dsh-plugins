# dsh-plugins

Two plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), one repository.
Each plugin lives in its own subdirectory with its own `package.json`, `cordis.patch.yml` and host/client halves.

## Plugins

| Plugin | What it does | Platform | Install |
| --- | --- | --- | --- |
| [`dsh-approval-push`](plugins/dsh-approval-push) | Approval reminder: an in-page card with **Allow once / Reject** when a session waits for permission, optional desktop notification, sound and tab-title marker, and a phone push through PushPlus, ServerChan, ntfy, a WeCom group robot or a custom webhook. | Windows / macOS / Linux (`dsh` web UI) | see below |
| [`dsh-ai-idle-shutdown`](plugins/dsh-ai-idle-shutdown) | Windows-only sidebar panel that watches the CPU and IO of your AI desktop apps' process trees and shuts the machine down once all of them have been idle for a configurable time — cancellable countdown, dry-run mode, activity log. Requires Python 3.10+. | Windows 10/11 | see below |

## Install

From the plugin market once listed, or directly from this repository:

```sh
# approval reminder
dsh plugin --profile <profile> add github:top10xiaowangzi-byte/dsh-plugins#path:/plugins/dsh-approval-push

# AI idle auto-shutdown (Windows)
dsh plugin --profile <profile> add github:top10xiaowangzi-byte/dsh-plugins#path:/plugins/dsh-ai-idle-shutdown
```

`<profile>` is the profile you run, e.g. `desktop` or `web`. Restart the host afterwards so the host half
is loaded; the browser half is picked up on the next page load.

## Layout

```
plugins/
  dsh-approval-push/       # approval card + multi-channel phone push
  dsh-ai-idle-shutdown/    # Windows sidebar panel + bundled Python monitor
```

Both plugins ship without runtime npm dependencies and without build scripts, so installing from source
never triggers a build-approval step.

## Tests

```sh
# approval reminder: offline unit tests (no network)
cd plugins/dsh-approval-push && node test/push.test.mjs

# AI idle auto-shutdown: needs Windows + Python 3.10+
cd plugins/dsh-ai-idle-shutdown && node test/host.test.mjs
```

## 中文摘要

本仓库是 `top10xiaowangzi-byte` 的 DeepSeek Harness 插件集合，一个插件一个子目录：

- **`dsh-approval-push`**：审批提醒。会话卡在等权限时，在页面右下角弹卡，可直接「允许一次」/「拒绝」；
  可选发桌面通知、提示音、给标签页标题加标记，并能由宿主半把这条审批推到手机
  （PushPlus / Server酱 / ntfy / 企业微信群机器人 / 自定义 webhook）。
- **`dsh-ai-idle-shutdown`**：仅 Windows 的右侧栏面板。按整棵进程树的 CPU / IO 判断你常用的 AI 桌面工具
  是否还在干活，全部连续安静指定分钟数后关机（也可重启 / 睡眠 / 休眠 / 锁屏），带可取消倒计时、
  演练模式与活动记录；需要本机 Python 3.10+。

安装命令同上，替换 `<profile>` 即可。两个插件都没有运行时 npm 依赖、没有构建脚本。

## License

MIT — see [LICENSE](LICENSE).
