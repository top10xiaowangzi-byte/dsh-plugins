/**
 * dsh-approval-push —— Client 半（浏览器）。
 *
 * 在 frame-wide 的 `shell.overlay` 座位里放一个右下角提醒卡：
 * 只要有会话出现「等待审批」的待处理交互（kind === 'approval'），就弹出来，
 * 并附带系统通知 + 提示音（浏览器允许时），可直接点「允许一次 / 拒绝」回答，
 * 不用切回会话自己找。
 *
 * 只依赖 `react`（基座模块），不 import 任何 @deepseek-ai 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-push',
  factory: (require) => {
    const React = require('react');
    const { useEffect, useRef, useState } = React;
    const h = React.createElement;

    const inject = ['slots'];
    const name = 'dsh-approval-push';
    const version = '1.3.0';

    const TEXT = {
      waiting: '需要你的确认',
      reject: '拒绝',
      allowOnce: '允许一次',
      answering: '处理中…',
      dismiss: '先收起这张卡（审批仍在，可稍后再处理）',
      tool: (toolName) => `工具 ${toolName || '未知'} 请求特权操作`,
      notificationTitle: '有操作等你确认',
      notificationBody: (toolName) => `工具 ${toolName || '未知'} 请求特权操作，点这里回到 Harness 处理。`,
      enableDesktop: '开启系统通知',
      pushPending: '正在推送到手机…',
      pushOk: '已推送到手机',
      pushFail: '推送失败，见 %TEMP%\\dsh-approval-push.push.log',
      pushOff: '手机推送未开启',
    };

    const COLOR = {
      bg: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      sub: 'var(--dsw-alias-label-secondary, #646a73)',
      faint: 'var(--dsw-alias-label-tertiary, #8f959e)',
      border: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14))',
      warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
      warnSoft: 'var(--dsw-alias-state-warn-tertiary, rgba(217, 119, 6, 0.12))',
      primaryBg: 'var(--dsw-alias-brand-primary, #1f2329)',
      primaryText: 'var(--dsw-specific-input-major, #ffffff)',
      radius: 'var(--dsw-radius-xl, 14px)',
      shadow: 'var(--dsw-shadow-lv2, 0 12px 34px rgba(0, 0, 0, 0.24))',
    };

    const LAYER = {
      position: 'fixed',
      right: 24,
      bottom: 24,
      zIndex: 2147483000,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 10,
      maxHeight: 'calc(100vh - 48px)',
      overflowY: 'auto',
      pointerEvents: 'none',
      padding: 2,
      fontFamily: 'var(--dsh-font-family-text-default, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif)',
    };

    const CARD = {
      boxSizing: 'border-box',
      width: 360,
      maxWidth: 'calc(100vw - 48px)',
      pointerEvents: 'auto',
      background: COLOR.bg,
      color: COLOR.text,
      border: `1px solid ${COLOR.border}`,
      borderTop: `3px solid ${COLOR.warn}`,
      borderRadius: COLOR.radius,
      boxShadow: COLOR.shadow,
      padding: '12px 14px 12px',
      fontSize: 13,
      lineHeight: 1.5,
      textAlign: 'left',
    };

    const HEAD = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6,
    };

    const TITLE = {
      flex: '1 1 auto',
      minWidth: 0,
      fontSize: 14,
      fontWeight: 600,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };

    const CLOSE = {
      flex: '0 0 auto',
      border: 0,
      background: 'transparent',
      color: COLOR.faint,
      fontSize: 18,
      lineHeight: 1,
      cursor: 'pointer',
      padding: '0 2px',
      borderRadius: 6,
    };

    const TOOL = {
      color: COLOR.sub,
      fontSize: 12,
      marginBottom: 4,
      wordBreak: 'break-word',
    };

    const REASON = {
      maxHeight: 96,
      overflowY: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      background: COLOR.warnSoft,
      borderRadius: 8,
      padding: '6px 8px',
      fontSize: 12,
      margin: '6px 0 2px',
    };

    const HINT = {
      display: 'inline-block',
      border: `1px dashed ${COLOR.border}`,
      background: 'transparent',
      color: COLOR.sub,
      borderRadius: 999,
      padding: '2px 8px',
      fontSize: 11,
      cursor: 'pointer',
      marginTop: 8,
    };

    const ACTIONS = {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 10,
    };

    const PUSH_HINT = {
      marginTop: 6,
      fontSize: 11,
      color: COLOR.faint,
      textAlign: 'right',
    };

    const BTN = {
      border: `1px solid ${COLOR.border}`,
      background: 'transparent',
      color: COLOR.text,
      borderRadius: 8,
      padding: '5px 12px',
      fontSize: 12,
      cursor: 'pointer',
      fontFamily: 'inherit',
    };

    const PRIMARY = {
      ...BTN,
      border: '1px solid transparent',
      background: COLOR.primaryBg,
      color: COLOR.primaryText,
      fontWeight: 600,
    };

    const PRIMARY_BUSY = {
      ...PRIMARY,
      opacity: 0.6,
      cursor: 'default',
    };

    const SECONDARY_BUSY = {
      ...BTN,
      opacity: 0.6,
      cursor: 'default',
    };

    /** 系统通知/提示音：AudioContext 只在用户真正交互过之后才可用，其余情况静默跳过。 */
    let audioContext = null;

    function unlockAudio() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        if (!audioContext) audioContext = new Ctor();
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      } catch {
        /* 无音频权限时保持安静 */
      }
    }

    function beep() {
      try {
        if (!audioContext || audioContext.state !== 'running') return;
        const start = audioContext.currentTime;
        const notes = [
          [start, 880],
          [start + 0.16, 1180],
        ];
        for (const [at, frequency] of notes) {
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(at);
          oscillator.stop(at + 0.16);
        }
      } catch {
        /* 忽略音频失败 */
      }
    }

    function readPermission() {
      try {
        return typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported';
      } catch {
        return 'unsupported';
      }
    }

    /** 页面在后台或失焦时才发系统通知，避免和屏幕上的提醒卡重复打扰。 */
    function notifyDesktop(approval, text) {
      try {
        const Ctor = window.Notification;
        if (typeof Ctor !== 'function' || Ctor.permission !== 'granted') return;
        if (!document.hidden && document.hasFocus()) return;
        const notification = new Ctor(TEXT.notificationTitle, {
          body: text || TEXT.notificationBody(approval.toolName),
          tag: String(approval.key),
          requireInteraction: true,
          silent: false,
        });
        notification.onclick = () => {
          try {
            window.focus();
            notification.close();
          } catch {
            /* 忽略 */
          }
        };
      } catch {
        /* 系统通知不可用时只用页面内提醒 */
      }
    }

    function clamp(text, limit) {
      const value = String(text ?? '').replace(/\s+$/u, '');
      if (value.length <= limit) return value;
      return `${value.slice(0, limit - 1)}…`;
    }

    /**
     * 把这条审批交给宿主半，由它出站推到手机（微信 / 手表 / ntfy）。
     * 浏览器半只做「本机 POST」，不碰任何第三方密钥，也不受 CORS 影响。
     * 返回 'ok' | 'fail' | 'off'；宿主不可达时静默（页面提醒本身仍然有效）。
     */
    async function pushRemote(approval, text, sessionId) {
      try {
        const response = await fetch('/approval-push/push', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            key: String(approval.key),
            toolName: approval.toolName,
            reason: text,
            sessionId,
            focused: document.hasFocus(),
          }),
        });
        if (response.status === 404) return 'off'; // 宿主半还没重载：安静跳过，不误报失败
        if (!response.ok) return 'fail';
        const payload = await response.json();
        if (payload && payload.pushed === true) return 'ok';
        if (payload && ['disabled', 'not-configured'].includes(payload.reason)) return 'off';
        return payload && payload.reason === 'duplicate' ? 'ok' : 'off';
      } catch {
        return 'off';
      }
    }

    // ======== 临时诊断（已停用：UI_PROBE=false 时完全不执行，可整段删除） ========
    const UI_PROBE = false;

    function probeDescribe(el) {
      if (!el) return null;
      const chain = [];
      let node = el;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const attrs = {};
        for (const attr of Array.from(node.attributes ?? [])) {
          if (attr.name === 'class' || attr.name === 'style') continue;
          if (attr.name.startsWith('data-') || ['aria-label', 'title', 'role'].includes(attr.name)) {
            attrs[attr.name] = String(attr.value).slice(0, 120);
          }
        }
        const style = getComputedStyle(node);
        chain.push({
          tag: node.tagName.toLowerCase(),
          cls: String(node.className ?? '').slice(0, 140),
          attrs,
          css: {
            color: style.color,
            background: style.backgroundColor,
            fill: style.fill,
            stroke: style.stroke,
            opacity: style.opacity,
          },
        });
      }
      const rect = el.getBoundingClientRect();
      const svg = el.closest?.('svg') ?? el.querySelector?.('svg');
      return {
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        chain,
        svg: svg ? svg.outerHTML.slice(0, 1200) : null,
      };
    }

    function probeEnv() {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const vars = {};
      for (const name of [
        '--dsw-alias-label-primary',
        '--dsw-alias-label-secondary',
        '--dsw-alias-label-tertiary',
        '--dsw-alias-label-caption',
        '--dsw-alias-bg-base',
        '--dsw-alias-brand-primary',
        '--dsw-alias-border-l2',
      ]) {
        vars[name] = style.getPropertyValue(name).trim();
      }
      return {
        dataset: { ...root.dataset },
        className: String(root.className).slice(0, 200),
        prefersDark: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        vars,
      };
    }

    function probeRect(el) {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }

    function probeShort(el) {
      if (!el) return null;
      const style = getComputedStyle(el);
      const attrs = {};
      for (const attr of Array.from(el.attributes ?? [])) {
        if (attr.name === 'class' || attr.name === 'style' || attr.name === 'd') continue;
        attrs[attr.name] = String(attr.value).slice(0, 100);
      }
      return {
        tag: el.tagName.toLowerCase(),
        cls: String(el.className ?? '').slice(0, 160),
        attrs,
        rect: probeRect(el),
        css: {
          color: style.color,
          bg: style.backgroundColor,
          fill: style.fill,
          stroke: style.stroke,
          opacity: style.opacity,
          cursor: style.cursor,
          visibility: style.visibility,
        },
        html: el.tagName.toLowerCase() === 'svg' ? el.outerHTML.slice(0, 900) : undefined,
      };
    }

    function probeEnv() {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const vars = {};
      for (const name of [
        '--dsw-alias-label-primary',
        '--dsw-alias-label-secondary',
        '--dsw-alias-label-tertiary',
        '--dsw-alias-label-caption',
        '--dsw-alias-bg-base',
        '--dsw-alias-brand-primary',
        '--dsw-alias-border-l2',
      ]) {
        vars[name] = style.getPropertyValue(name).trim();
      }
      return {
        dataset: { ...root.dataset },
        className: String(root.className).slice(0, 200),
        prefersDark: window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? null,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        vars,
      };
    }

    function installUiProbe() {
      let sent = 0;
      let lastKey = '';
      const post = (kind, payload) => {
        sent += 1;
        try {
          fetch('/approval-push/push', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({
              key: `probe-${kind}-${Date.now()}-${sent}`,
              toolName: 'ui-probe',
              reason: JSON.stringify({ probe: kind, at: new Date().toISOString(), ...payload, env: probeEnv() }),
              focused: true,
            }),
          }).catch(() => {});
        } catch {
          /* 探针失败不影响提醒功能 */
        }
      };

      // 启动快照：先看这套界面里「分隔/分栏」到底用的是什么元素。
      const candidates = [];
      for (const el of document.querySelectorAll('*')) {
        const cls = String(el.className ?? '');
        if (!/divid|resiz|split|handle|grip|dock/i.test(cls)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        candidates.push({ ...probeShort(el), cls });
        if (candidates.length >= 24) break;
      }
      post('boot', {
        dockkit: {
          divider: document.querySelectorAll('[data-dockkit-divider]').length,
          splitButton: document.querySelectorAll('[data-dockkit-split-button]').length,
          pane: document.querySelectorAll('[data-dockkit-pane]').length,
        },
        candidates,
      });

      const onMove = (event) => {
        if (sent >= 6) return;
        const stack = document.elementsFromPoint(event.clientX, event.clientY);
        if (stack.length === 0) return;
        const top = stack[0];
        const interested = stack.some((el) => {
          const tag = el.tagName.toLowerCase();
          const cls = String(el.className ?? '');
          return tag === 'svg' || /divid|resiz|split|handle|grip|dock/i.test(cls);
        });
        const nearSeam = Array.from(
          document.querySelectorAll('[data-dockkit-divider], [data-width-handle], [class*="mP3x-q_handle"]'),
        ).some((divider) => {
          const rect = divider.getBoundingClientRect();
          const cx = rect.width > 0 ? rect.x + rect.width / 2 : rect.x;
          return Math.abs(event.clientX - cx) <= 16;
        });
        if (!interested && !nearSeam) return;
        const key = `${Math.round(event.clientX / 2)}:${Math.round(event.clientY / 2)}`;
        if (key === lastKey) return;
        lastKey = key;
        post('hover', {
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          topSelector: top ? `${top.tagName.toLowerCase()}.${String(top.className ?? '').slice(0, 60)}` : null,
          stack: stack.slice(0, 6).map(probeShort),
        });
      };
      window.addEventListener('pointermove', onMove, { capture: true, passive: true });
      return () => window.removeEventListener('pointermove', onMove, { capture: true });
    }

    /**
     * 缝隙高亮线的小修：基座把「拖动调整宽度」的指示线画成滚动条灰
     * （--dsw-alias-scrollbar-bg-l1，白底上几乎看不见）。这里只在两个手柄上
     * 把那个变量换成次级文字色，线本身仍是基座画的那根，其它界面不受影响。
     * 不想要就把它改成 false。
     */
    const SEAM_CONTRAST_FIX = true;

    function installSeamContrast() {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-approval-push';
      tag.dataset.approvalNotify = 'seam-contrast';
      tag.textContent = [
        '[data-width-handle], .an3WzG_widthHandle, .mP3x-q_handle {',
        '  --dsw-alias-scrollbar-bg-l1: var(--dsw-alias-label-secondary, #646a73);',
        '}',
      ].join('\n');
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /** 审批请求的展示文案：优先用请求方的本地化副本，其次用原始 reason。 */
    function reasonText(approval) {
      const display = approval.displayReason;
      if (typeof display === 'string' && display.trim()) return clamp(display, 240);
      const reason = approval.reason;
      if (typeof reason === 'string' && reason.trim()) return clamp(reason, 240);
      return TEXT.tool(approval.toolName);
    }

    function orderKey(approval) {
      const match = /(\d+)/.exec(String(approval && approval.key));
      return match ? Number(match[1]) : 0;
    }

    function WarningIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('path', {
          d: 'M12 3.4 21 19.4H3L12 3.4Z',
          stroke: COLOR.warn,
          strokeWidth: 1.7,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 9.4v4.3', stroke: COLOR.warn, strokeWidth: 1.9, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 16.6, r: 1.05, fill: COLOR.warn }),
      );
    }

    function ApprovalCard(props) {
      const approval = props.approval;
      const [busy, setBusy] = useState(false);
      const [permission, setPermission] = useState(readPermission);
      const text = reasonText(approval);
      const canAnswer = approval.answerable !== false && typeof approval.answer === 'function';

      const decide = (outcome) => {
        if (busy || !canAnswer) return;
        setBusy(true);
        let result;
        try {
          result = approval.answer(outcome);
        } catch {
          setBusy(false);
          return;
        }
        if (result && typeof result.then === 'function') result.catch(() => setBusy(false));
      };

      const askPermission = () => {
        try {
          const Ctor = window.Notification;
          if (!Ctor || typeof Ctor.requestPermission !== 'function') return;
          const pending = Ctor.requestPermission();
          if (pending && typeof pending.then === 'function') {
            pending.then(() => setPermission(readPermission())).catch(() => setPermission(readPermission()));
          } else {
            setPermission(readPermission());
          }
        } catch {
          setPermission(readPermission());
        }
      };

      return h(
        'div',
        { style: CARD, role: 'group', 'aria-label': TEXT.waiting, 'data-approval-key': String(approval.key) },
        h(
          'div',
          { style: HEAD },
          WarningIcon(),
          h('span', { style: TITLE }, TEXT.waiting),
          h('button', {
            type: 'button',
            title: TEXT.dismiss,
            'aria-label': TEXT.dismiss,
            onClick: props.onDismiss,
            style: CLOSE,
          }, '×'),
        ),
        h('div', { style: TOOL }, TEXT.tool(approval.toolName)),
        text === TEXT.tool(approval.toolName) ? null : h('div', { style: REASON }, text),
        permission === 'default' ? h('button', { type: 'button', onClick: askPermission, style: HINT }, TEXT.enableDesktop) : null,
        h(
          'div',
          { style: ACTIONS },
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => decide('rejected'),
            style: busy ? SECONDARY_BUSY : BTN,
          }, TEXT.reject),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => decide('allowed-once'),
            style: busy ? PRIMARY_BUSY : PRIMARY,
          }, busy ? TEXT.answering : TEXT.allowOnce),
        ),
        props.pushState && props.pushState !== 'off'
          ? h('div', { style: PUSH_HINT },
              props.pushState === 'ok' ? TEXT.pushOk
                : props.pushState === 'fail' ? TEXT.pushFail
                : TEXT.pushPending)
          : null,
      );
    }

    function ApprovalToast(props) {
      const statuses = props.useSessionStatus((snapshot) => snapshot);

      const pending = [];
      if (statuses && typeof statuses.forEach === 'function') {
        statuses.forEach((status, sessionId) => {
          const approval = status && status.pendingInteraction;
          if (approval && approval.kind === 'approval') pending.push({ approval, sessionId });
        });
      }
      pending.sort((left, right) => orderKey(left.approval) - orderKey(right.approval));

      const signature = pending.map((entry) => String(entry.approval.key)).join('|');
      const [dismissed, setDismissed] = useState(() => new Set());
      const [pushState, setPushState] = useState(() => ({}));
      const notified = useRef(new Set());
      const pushed = useRef(new Set());
      const visible = pending.filter((entry) => !dismissed.has(String(entry.approval.key)));

      // 新出现的审批：提示音 + 系统通知 + 手机推送（每条只提醒一次）。
      useEffect(() => {
        const live = new Set();
        for (const entry of pending) {
          const key = String(entry.approval.key);
          live.add(key);
          if (notified.current.has(key)) continue;
          notified.current.add(key);
          const text = reasonText(entry.approval);
          beep();
          notifyDesktop(entry.approval, text);
          if (!pushed.current.has(key)) {
            pushed.current.add(key);
            setPushState((previous) => ({ ...previous, [key]: 'pending' }));
            pushRemote(entry.approval, text, entry.sessionId).then((state) => {
              setPushState((previous) => ({ ...previous, [key]: state }));
            });
          }
        }
        for (const key of Array.from(notified.current)) {
          if (!live.has(key)) notified.current.delete(key);
        }
      }, [signature]);

      // 已处理掉的审批不必再记着它被收起过。
      useEffect(() => {
        if (dismissed.size === 0) return;
        const live = new Set(pending.map((entry) => String(entry.approval.key)));
        const next = new Set();
        let stale = false;
        for (const key of dismissed) {
          if (live.has(key)) next.add(key);
          else stale = true;
        }
        if (stale) setDismissed(next);
      }, [signature, dismissed]);

      // 标签标题加标记：任务栏/标签页里也能看出「有待确认」。
      useEffect(() => {
        if (visible.length === 0) return undefined;
        const marker = '⚠ 待确认 · ';
        if (!document.title.startsWith(marker)) document.title = marker + document.title;
        return () => {
          if (document.title.startsWith(marker)) document.title = document.title.slice(marker.length);
        };
      }, [visible.length > 0]);

      if (visible.length === 0) return null;

      return h(
        'div',
        { style: LAYER, 'data-approval-push': version },
        visible.map((entry) => h(ApprovalCard, {
          key: String(entry.approval.key),
          approval: entry.approval,
          pushState: pushState[String(entry.approval.key)],
          onDismiss: () => setDismissed((previous) => new Set(previous).add(String(entry.approval.key))),
        })),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'approval-push.toast',
        order: 1000,
        label: '审批提醒',
      }, ApprovalToast));

      // 用户第一次交互后解锁音频（浏览器要求手势），之后的审批才能响提示音。
      ctx.effect(() => {
        const unlock = () => unlockAudio();
        window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
        window.addEventListener('keydown', unlock, { capture: true, passive: true });
        return () => {
          window.removeEventListener('pointerdown', unlock, { capture: true });
          window.removeEventListener('keydown', unlock, { capture: true });
        };
      }, 'approval-push: audio unlock');

      // 装载自检：宿主半据此确认浏览器模块确实执行并注册了座位（安装后排错用）。
      ctx.effect(() => {
        const timer = window.setTimeout(() => {
          try {
            fetch(`/approval-push/health?client=${encodeURIComponent(version)}`, { cache: 'no-store' }).catch(() => {});
          } catch {
            /* 宿主未挂载时不打扰 */
          }
        }, 800);
        return () => window.clearTimeout(timer);
      }, 'approval-push: health ping');

      // 临时诊断（UI_PROBE 关掉即失效）
      if (UI_PROBE) ctx.effect(() => installUiProbe(), 'approval-push: ui probe');

      // 缝隙高亮线的对比色小修（SEAM_CONTRAST_FIX 关掉即失效）
      if (SEAM_CONTRAST_FIX) ctx.effect(() => installSeamContrast(), 'approval-push: seam contrast');
    }

    return { name, inject, apply };
  },
});
