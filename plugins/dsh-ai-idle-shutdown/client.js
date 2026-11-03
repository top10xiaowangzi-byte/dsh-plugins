window.__ModuleLoader__.load({
	id: "dsh-ai-idle-shutdown",
	factory: (require) => {
		const React = require("react");
		const { useEffect, useRef, useState } = React;
		const h = React.createElement;

		const namespace = "aiIdleShutdown";
		const TAB_KIND = "ai-idle-shutdown";
		const TAB_ID = "dsh-ai-idle-shutdown";

		// ------------------------------------------------------------------ //
		// 主题 token（只使用 --dsw-alias-*，缺失时退回深色可读值）
		// ------------------------------------------------------------------ //
		const color = {
			text: "var(--dsw-alias-label-primary,#f4f4f5)",
			secondary: "var(--dsw-alias-label-secondary,#bdbdbd)",
			dimmed: "var(--dsw-alias-label-dimmed,#909090)",
			border: "var(--dsw-alias-border-l2,#4a4a4a)",
			layer: "var(--dsw-alias-bg-layer-1,#252525)",
			layer2: "var(--dsw-alias-bg-layer-2,#2f2f2f)",
			success: "var(--dsw-alias-state-success-primary,#22c55e)",
			warn: "var(--dsw-alias-state-warn-primary,#eab308)",
			error: "var(--dsw-alias-state-error-primary,#ef4444)",
		};

		// ------------------------------------------------------------------ //
		// 文案（ctx.locale 内联 zh/en 字典）
		// ------------------------------------------------------------------ //
		const zh = {
			"type.label": "AI 自动关机",
			"guide.title": "AI 自动关机",
			"guide.description": "一键启动/停止：全部 AI 工具安静 15 分钟后自动关机",
			"app.title": "AI 自动关机",
			"header.title": "AI 自动关机（右侧栏）",
			"status.connecting": "正在连接…",
			"status.stopped": "未启用",
			"status.starting": "正在启动监控…",
			"status.waiting": "等待 AI 开始工作",
			"status.monitoring": "监控中",
			"status.busy": "监控中 · AI 正在工作",
			"status.countdown": "关机倒计时！",
			"badge.dry": "演练模式",
			"badge.real": "正式模式",
			"notice.plugin": "本页面由 DSH 插件提供，默认关闭。",
			"hint.connecting": "正在读取插件后台状态…",
			"hint.stopped.prefix": "点击「启用」开始监控；全部 AI 工具安静满 ",
			"hint.stopped.suffix": " 后自动关机。",
			"hint.waiting": "等待 AI 工具开始工作；首次检测到活动后开始倒计时。",
			"hint.starting": "监控进程已启动，等待第一次状态上报…",
			"hint.monitoring": "全部 AI 工具安静，倒计时结束将自动关机。",
			"hint.busy.suffix": "」正在工作 → 倒计时已重置",
			"hint.countdown": "倒计时结束后将执行关机；有 AI 工具开始工作或移动键鼠会自动取消。",
			"hint.done": "监控已结束。",
			"progress.countdown": "关机倒计时",
			"progress.remaining": "剩余",
			"button.start": "✅ 启用",
			"button.starting": "正在启动…",
			"button.running": "已在监控",
			"button.stop": "⏹ 停止 / 取消关机",
			"button.stopping": "正在停止…",
			"checkbox.dry": "演练模式（不会真的关机）",
			"checkbox.locked": "运行中不可切换，请先停止",
			"events.title": "最近活动",
			"events.count": "{n} 条",
			"events.empty": "暂无活动记录。启动监控后，这里会显示是哪个 AI 工具激活 / 重置了倒计时。",
			"action.started": "监控已启动",
			"action.stopped": "已停止监控并撤销关机倒计时",
			"action.startFailed": "启动失败",
			"action.stopFailed": "停止失败",
			"action.requestFailed": "操作失败",
			"error.status": "状态查询失败",
			"error.network": "无法连接插件后台",
			"meta.now": "实时",
			"meta.pid": "PID ",
			"meta.updated": "更新于 ",
			"meta.ago": " 秒前",
			"meta.notRunning": "监控未运行",
		};

		const en = {
			"type.label": "AI Auto Shutdown",
			"guide.title": "AI Auto Shutdown",
			"guide.description": "Start/stop: shut down after all AI tools sit idle for 15 minutes",
			"app.title": "AI Auto Shutdown",
			"header.title": "AI Auto Shutdown (right sidebar)",
			"status.connecting": "Connecting…",
			"status.stopped": "Disabled",
			"status.starting": "Starting monitor…",
			"status.waiting": "Waiting for AI activity",
			"status.monitoring": "Monitoring",
			"status.busy": "Monitoring · AI tools working",
			"status.countdown": "Shutdown countdown!",
			"badge.dry": "Dry run",
			"badge.real": "Live",
			"notice.plugin": "This page is provided by a DSH plugin and is off by default.",
			"hint.connecting": "Reading the plugin host…",
			"hint.stopped.prefix": "Click Start to monitor; the machine shuts down after all AI tools stay quiet for ",
			"hint.stopped.suffix": ".",
			"hint.waiting": "Waiting for the first AI activity; the countdown starts after that.",
			"hint.starting": "Monitor process started; waiting for the first status report…",
			"hint.monitoring": "All AI tools are quiet; shutdown is armed when the countdown ends.",
			"hint.busy.suffix": "\" is working → countdown reset",
			"hint.countdown": "Shutdown follows the countdown; new AI activity or keyboard/mouse input cancels it.",
			"hint.done": "Monitoring finished.",
			"progress.countdown": "Shutdown countdown",
			"progress.remaining": "remaining",
			"button.start": "✅ Start",
			"button.starting": "Starting…",
			"button.running": "Monitoring",
			"button.stop": "⏹ Stop / cancel shutdown",
			"button.stopping": "Stopping…",
			"checkbox.dry": "Dry run (never shuts down)",
			"checkbox.locked": "Stop the monitor to change this",
			"events.title": "Recent activity",
			"events.count": "{n}",
			"events.empty": "No activity yet. Once monitoring starts, this log names the AI tool that activated or reset the countdown.",
			"action.started": "Monitor started",
			"action.stopped": "Monitor stopped and shutdown cancelled",
			"action.startFailed": "Failed to start",
			"action.stopFailed": "Failed to stop",
			"action.requestFailed": "Request failed",
			"error.status": "Status request failed",
			"error.network": "Cannot reach the plugin host",
			"meta.now": "live",
			"meta.pid": "PID ",
			"meta.updated": "updated ",
			"meta.ago": "s ago",
			"meta.notRunning": "Monitor is not running",
		};

		// ------------------------------------------------------------------ //
		// 小工具
		// ------------------------------------------------------------------ //
		const pad2 = (value) => String(value).padStart(2, "0");

		const formatClock = (totalSeconds) => {
			const safe = Math.max(0, Math.round(Number(totalSeconds) || 0));
			if (safe >= 3600) {
				const hours = Math.floor(safe / 3600);
				return hours + ":" + pad2(Math.floor((safe % 3600) / 60)) + ":" + pad2(safe % 60);
			}
			return pad2(Math.floor(safe / 60)) + ":" + pad2(safe % 60);
		};

		const formatTime = (ms) => {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
			const d = new Date(ms);
			return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
		};

		const mergeEvents = (previous, incoming) => {
			const bySeq = new Map();
			for (const event of previous) bySeq.set(event.seq, event);
			for (const event of incoming || []) {
				if (event && typeof event.seq === "number") bySeq.set(event.seq, event);
			}
			return Array.from(bySeq.values()).sort((left, right) => left.seq - right.seq).slice(-60);
		};

		const eventColor = (text) => {
			if (!text) return color.secondary;
			if (text.indexOf("重置") >= 0 || text.indexOf("正在工作") >= 0) return color.success;
			if (text.indexOf("倒计时") >= 0) return color.warn;
			if (text.indexOf("停止") >= 0 || text.indexOf("退出") >= 0 || text.indexOf("结束") >= 0) return color.dimmed;
			return color.secondary;
		};

		const statusTone = (data) => {
			if (!data || !data.running) return "stopped";
			if (data.stateCode === "countdown") return "countdown";
			if (data.stateCode === "monitoring") return (data.busy && data.busy.length > 0) ? "busy" : "quiet";
			if (data.stateCode === "starting") return "starting";
			return "waiting";
		};

		const toneColor = (tone) => {
			if (tone === "countdown") return color.error;
			if (tone === "busy") return color.success;
			if (tone === "quiet") return color.warn;
			if (tone === "starting" || tone === "waiting") return color.warn;
			return color.dimmed;
		};

		// ------------------------------------------------------------------ //
		// 右侧栏正文
		// ------------------------------------------------------------------ //
		const createPanel = (t) => function AutoShutdownPanel() {
			const [snap, setSnap] = useState(null);
			const [events, setEvents] = useState([]);
			const [tick, setTick] = useState(() => Date.now());
			const [dryRun, setDryRun] = useState(false);
			const [acting, setActing] = useState(null);
			const [notice, setNotice] = useState(null);
			const [error, setError] = useState(null);
			const initialized = useRef(false);

			// 每 500ms 拉一次 Host 状态
			useEffect(() => {
				let disposed = false;
				let timer = null;
				const poll = async () => {
					try {
						const response = await fetch("/ai-idle-shutdown/status", {
							method: "GET",
							cache: "no-store",
							signal: AbortSignal.timeout(8000),
						});
						if (!response.ok) throw new Error("HTTP " + response.status);
						const data = await response.json();
						if (disposed) return;
						setSnap(data);
						setError(null);
						setEvents((previous) => mergeEvents(previous, data.events));
						if (!initialized.current) {
							initialized.current = true;
							setDryRun(Boolean(data.dryRun));
						}
					} catch (fetchError) {
						if (disposed) return;
						setError(t("error.status") + "：" + (fetchError && fetchError.message ? fetchError.message : t("error.network")));
					} finally {
						if (!disposed) timer = window.setTimeout(poll, 500);
					}
				};
				poll();
				return () => {
					disposed = true;
					if (timer) window.clearTimeout(timer);
				};
			}, []);

			// 250ms 刷新一次显示，让 mm:ss 平滑逐秒递减（不依赖网络往返）
			useEffect(() => {
				const id = window.setInterval(() => setTick(Date.now()), 250);
				return () => window.clearInterval(id);
			}, []);

			// notice 自动消失
			useEffect(() => {
				if (!notice) return;
				const id = window.setTimeout(() => setNotice(null), 8000);
				return () => window.clearTimeout(id);
			}, [notice]);

			const post = async (path, payload) => {
				const response = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload || {}),
					signal: AbortSignal.timeout(40000),
				});
				let data = null;
				try {
					data = await response.json();
				} catch {
					data = null;
				}
				if (!response.ok) {
					throw new Error((data && data.message) || "HTTP " + response.status);
				}
				return data || {};
			};

			const start = async () => {
				if (acting) return;
				setActing("start");
				setNotice(null);
				setError(null);
				try {
					const result = await post("/ai-idle-shutdown/start", { dryRun });
					if (result.ok) {
						setNotice(result.message || t("action.started"));
						if (typeof result.dryRun === "boolean") setDryRun(result.dryRun);
					} else {
						setError((result.message || t("action.startFailed")));
					}
				} catch (actionError) {
					setError(t("action.requestFailed") + "：" + (actionError && actionError.message ? actionError.message : t("error.network")));
				} finally {
					setActing(null);
				}
			};

			const stop = async () => {
				if (acting) return;
				setActing("stop");
				setNotice(null);
				setError(null);
				try {
					const result = await post("/ai-idle-shutdown/stop", {});
					if (result.ok) {
						setNotice(result.message || t("action.stopped"));
					} else {
						setError(result.message || t("action.stopFailed"));
					}
				} catch (actionError) {
					setError(t("action.requestFailed") + "：" + (actionError && actionError.message ? actionError.message : t("error.network")));
				} finally {
					setActing(null);
				}
			};

			// ---------------- 计算展示值 ----------------
			const running = Boolean(snap && snap.running);
			const tone = statusTone(snap);
			const totalSeconds = Math.max(1, Number(snap && snap.countdownSeconds) || 900);
			const shutdownTotal = Math.max(1, Number(snap && snap.shutdownCountdownTotal) || 60);
			const drift = snap && typeof snap.serverTime === "number" ? Math.max(0, (tick - snap.serverTime) / 1000) : 0;

			let idleRemaining = totalSeconds;
			let countdownRemaining = null;
			if (snap && snap.running) {
				if (snap.stateCode === "countdown" && typeof snap.countdownRemaining === "number") {
					countdownRemaining = Math.max(0, snap.countdownRemaining - drift);
					idleRemaining = 0;
				} else if (snap.stateCode === "monitoring") {
					idleRemaining = Math.max(0, (Number(snap.idleRemaining) || 0) - drift);
				} else {
					idleRemaining = totalSeconds;
				}
			} else if (snap) {
				idleRemaining = totalSeconds;
			}

			const countdownPhase = Boolean(snap && snap.running && snap.stateCode === "countdown");
			const bigSeconds = countdownPhase ? (countdownRemaining || 0) : idleRemaining;
			const progressTotal = countdownPhase ? shutdownTotal : totalSeconds;
			const progressRatio = Math.max(0, Math.min(1, bigSeconds / progressTotal));
			const bigColor = countdownPhase ? color.error : toneColor(tone);

			let stateLabel = t("status.connecting");
			if (error && !snap) stateLabel = t("status.connecting");
			else if (snap && !running) stateLabel = t("status.stopped");
			else if (snap) {
				if (snap.stateCode === "starting") stateLabel = t("status.starting");
				else if (snap.stateCode === "waiting") stateLabel = t("status.waiting");
				else if (snap.stateCode === "countdown") stateLabel = t("status.countdown");
				else if (snap.stateCode === "monitoring") stateLabel = (snap.busy && snap.busy.length > 0) ? t("status.busy") : t("status.monitoring");
				else stateLabel = snap.stateLabel || t("status.monitoring");
			}

			let hint = t("hint.connecting");
			if (snap && !running) {
				hint = t("hint.stopped.prefix") + formatClock(totalSeconds) + t("hint.stopped.suffix");
			} else if (snap) {
				if (snap.stateCode === "waiting") hint = t("hint.waiting");
				else if (snap.stateCode === "starting") hint = t("hint.starting");
				else if (snap.stateCode === "countdown") hint = t("hint.countdown");
				else if (snap.stateCode === "monitoring" && snap.busy && snap.busy.length > 0) {
					hint = "「" + snap.busy.join("、") + t("hint.busy.suffix");
				} else if (snap.stateCode === "monitoring") hint = t("hint.monitoring");
				else if (snap.stateCode === "done") hint = t("hint.done");
			}

			const dryRunShown = running ? Boolean(snap && snap.dryRun) : dryRun;
			const dryEnabled = !running && !acting;
			const busyText = snap && snap.busy && snap.busy.length > 0 ? snap.busy.join("、") : "";

			// ---------------- 样式 ----------------
			const buttonBase = {
				appearance: "none",
				border: "1px solid " + color.border,
				borderRadius: 8,
				padding: "7px 10px",
				fontSize: 12.5,
				fontWeight: 600,
				cursor: "pointer",
				background: "transparent",
				color: color.text,
				flex: "1 1 auto",
				minWidth: 0,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			};
			const startButtonStyle = Object.assign({}, buttonBase, {
				background: color.success,
				borderColor: color.success,
				color: "#08210f",
				opacity: running || acting ? 0.55 : 1,
				cursor: running || acting ? "default" : "pointer",
			});
			const stopButtonStyle = Object.assign({}, buttonBase, {
				color: running ? color.text : color.dimmed,
				opacity: running && !acting ? 1 : 0.55,
				cursor: running && !acting ? "pointer" : "default",
			});

			const styles = {
				root: {
					height: "100%",
					width: "100%",
					boxSizing: "border-box",
					overflowY: "auto",
					overflowX: "hidden",
					padding: "14px 14px 20px",
					display: "flex",
					flexDirection: "column",
					gap: 12,
					color: color.text,
					fontSize: 13,
					lineHeight: 1.45,
				},
				noticeLine: {
					fontSize: 11,
					lineHeight: 1.5,
					color: color.dimmed,
					border: "1px solid " + color.border,
					borderRadius: 6,
					padding: "5px 8px",
					textAlign: "center",
					background: "transparent",
				},
				headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 },
				titleWrap: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
				title: { fontSize: 15, fontWeight: 650, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
				dot: { width: 8, height: 8, borderRadius: "50%", background: toneColor(tone), flex: "0 0 auto" },
				statusText: { fontSize: 12, color: color.secondary, whiteSpace: "nowrap" },
				badge: {
					fontSize: 11,
					padding: "2px 7px",
					borderRadius: 999,
					border: "1px solid " + color.border,
					color: dryRunShown ? color.warn : color.secondary,
					background: "transparent",
					flex: "0 0 auto",
				},
				countdownBox: { display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 0 0" },
				countdown: {
					fontSize: 42,
					fontWeight: 700,
					lineHeight: 1.05,
					letterSpacing: "0.02em",
					fontVariantNumeric: "tabular-nums",
					color: bigColor,
				},
				countdownCaption: { fontSize: 11, color: color.dimmed, fontVariantNumeric: "tabular-nums" },
				hint: { textAlign: "center", fontSize: 12, color: color.secondary, wordBreak: "break-word" },
				progress: {
					width: "100%",
					height: 6,
					borderRadius: 999,
					background: color.layer2,
					border: "1px solid " + color.border,
					overflow: "hidden",
					marginTop: 6,
				},
				progressFill: {
					height: "100%",
					width: Math.round(progressRatio * 100) + "%",
					background: countdownPhase ? color.error : toneColor(tone),
					borderRadius: 999,
					transition: "width 240ms linear",
				},
				buttons: { display: "flex", gap: 8, flexWrap: "wrap" },
				checkRow: { display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: color.secondary, cursor: dryEnabled ? "pointer" : "default" },
				message: { fontSize: 12, padding: "6px 9px", borderRadius: 7, border: "1px solid " + color.border, wordBreak: "break-word" },
				eventsHeader: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
				eventsTitle: { fontSize: 12.5, fontWeight: 600 },
				eventsMeta: { fontSize: 11, color: color.dimmed, whiteSpace: "nowrap" },
				eventsEmpty: { fontSize: 12, color: color.dimmed, lineHeight: 1.55 },
				eventsList: { display: "flex", flexDirection: "column", gap: 0, marginTop: 2 },
				eventRow: {
					display: "flex",
					gap: 8,
					padding: "5px 0",
					borderTop: "1px solid " + color.border,
					alignItems: "baseline",
					minWidth: 0,
				},
				eventTime: { fontSize: 11, color: color.dimmed, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" },
				eventText: { fontSize: 12, color: color.secondary, wordBreak: "break-word", minWidth: 0 },
				metaLine: { fontSize: 11, color: color.dimmed, display: "flex", gap: 6, flexWrap: "wrap" },
				busyLine: { fontSize: 11.5, color: color.success, wordBreak: "break-word" },
			};

			const sortedEvents = events.slice().reverse();
			const eventCountText = String(events.length) + " " + t("events.count").replace("{n}", "").trim();
			const metaParts = [];
			if (snap && snap.running) {
				if (snap.pid) metaParts.push(t("meta.pid") + snap.pid);
				metaParts.push(dryRunShown ? t("badge.dry") : t("badge.real"));
				if (typeof snap.updatedAgoSeconds === "number") {
					metaParts.push(t("meta.updated") + Math.round(snap.updatedAgoSeconds) + t("meta.ago"));
				}
			} else {
				metaParts.push(t("meta.notRunning"));
				if (snap && snap.configPath) metaParts.push(snap.configPath);
			}

			return h(
				"div",
				{ style: styles.root, "data-ai-idle-shutdown-panel": TAB_ID },
				h("div", { style: styles.noticeLine }, t("notice.plugin")),
				h(
					"div",
					{ style: styles.headerRow },
					h(
						"div",
						{ style: styles.titleWrap },
						h("span", { style: styles.dot, "aria-hidden": true }),
						h("span", { style: styles.title }, t("app.title")),
						h("span", { style: styles.statusText }, stateLabel),
					),
					h("span", { style: styles.badge }, dryRunShown ? t("badge.dry") : t("badge.real")),
				),

				h(
					"div",
					{ style: styles.countdownBox },
					h("div", { style: styles.countdown, "data-ai-idle-shutdown-countdown": "1" }, formatClock(bigSeconds)),
					h(
						"div",
						{ style: styles.countdownCaption },
						countdownPhase
							? t("progress.countdown")
							: t("progress.remaining") + " / " + formatClock(totalSeconds),
					),
					h("div", { style: styles.progress }, h("div", { style: styles.progressFill })),
				),

				h("div", { style: styles.hint }, hint),
				busyText
					? h("div", { style: styles.busyLine }, "● " + busyText)
					: null,

				h(
					"div",
					{ style: styles.buttons },
					h(
						"button",
						{
							type: "button",
							style: startButtonStyle,
							disabled: running || acting === "start",
							"aria-busy": acting === "start",
							title: running ? t("button.running") : t("button.start"),
							onClick: () => {
								void start();
							},
						},
						acting === "start"
							? t("button.starting")
							: running
								? t("button.running")
								: t("button.start"),
					),
					h(
						"button",
						{
							type: "button",
							style: stopButtonStyle,
							disabled: !running || acting === "stop",
							"aria-busy": acting === "stop",
							onClick: () => {
								void stop();
							},
						},
						acting === "stop" ? t("button.stopping") : t("button.stop"),
					),
				),

				h(
					"label",
					{ style: styles.checkRow },
					h("input", {
						type: "checkbox",
						checked: dryRunShown,
						disabled: !dryEnabled,
						onChange: (event) => setDryRun(Boolean(event.target.checked)),
					}),
					h("span", null, t("checkbox.dry")),
					running ? h("span", { style: { color: color.dimmed } }, "· " + t("checkbox.locked")) : null,
				),

				notice
					? h("div", { role: "status", style: Object.assign({}, styles.message, { borderColor: color.success, color: color.success }) }, notice)
					: null,
				error
					? h("div", { role: "alert", style: Object.assign({}, styles.message, { borderColor: color.error, color: color.error }) }, error)
					: null,

				h(
					"div",
					{ style: { borderTop: "1px solid " + color.border, paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 } },
					h(
						"div",
						{ style: styles.eventsHeader },
						h("span", { style: styles.eventsTitle }, t("events.title")),
						h("span", { style: styles.eventsMeta }, eventCountText),
					),
					sortedEvents.length === 0
						? h("div", { style: styles.eventsEmpty }, t("events.empty"))
						: h(
							"div",
							{ style: styles.eventsList },
							sortedEvents.map((event) => h(
								"div",
								{ key: event.seq, style: styles.eventRow },
								h("span", { style: styles.eventTime }, formatTime(event.at)),
								h("span", { style: Object.assign({}, styles.eventText, { color: eventColor(event.text) }) }, event.text),
							)),
						),
				),

				h("div", { style: styles.metaLine }, metaParts.map((part, index) => h("span", { key: index }, part))),
			);
		};

		// ------------------------------------------------------------------ //
		// 会话标题栏快捷入口：点一下在右侧栏打开本页签
		// ------------------------------------------------------------------ //
		const createHeaderAction = (ctx, t) => function AutoShutdownHeaderAction() {
			const open = () => {
				try {
					ctx.sidebarRight.openTab(TAB_KIND);
				} catch (error) {
					console.warn("[ai-idle-shutdown] open right sidebar tab failed:", error);
				}
			};
			return h(
				"button",
				{
					type: "button",
					title: t("header.title"),
					"aria-label": t("header.title"),
					onClick: open,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						border: 0,
						background: "transparent",
						color: "inherit",
						fontSize: 12,
						cursor: "pointer",
						padding: "2px 4px",
						borderRadius: 6,
					},
				},
				h(
					"svg",
					{ width: 15, height: 15, viewBox: "0 0 24 24", "aria-hidden": true },
					h("path", {
						d: "M12 3v8",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 2,
						strokeLinecap: "round",
					}),
					h("path", {
						d: "M6.3 6.6a8 8 0 1 0 11.4 0",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 2,
						strokeLinecap: "round",
					}),
				),
				h("span", null, t("type.label")),
			);
		};

		// ------------------------------------------------------------------ //
		// 插件入口
		// ------------------------------------------------------------------ //
		const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs"];

		function apply(ctx) {
			const t = ctx.locale.bind(namespace);
			const Panel = createPanel(t);
			const HeaderAction = createHeaderAction(ctx, t);

			ctx.effect(() => ctx.locale.register(namespace, { zh, en }), "dsh-ai-idle-shutdown: copy");

			// 两阶段注册：先 tab 类型（含引导页入口），再正文
			ctx.effect(
				() => ctx.sidebarRightTabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					priority: "extension",
					title: () => t("type.label"),
					guide: [
						{
							id: "open",
							order: 42,
							title: () => t("guide.title"),
							description: () => t("guide.description"),
						},
					],
				}),
				"dsh-ai-idle-shutdown: tab type",
			);

			ctx.effect(
				() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID,
					locale: namespace,
				}, Panel)),
				"dsh-ai-idle-shutdown: tab body",
			);

			ctx.effect(
				() => ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "ai-idle-shutdown-header",
					order: 24,
				}, HeaderAction)),
				"dsh-ai-idle-shutdown: header action",
			);
		}

		return { name: "dsh-ai-idle-shutdown-client", inject, apply };
	},
});
