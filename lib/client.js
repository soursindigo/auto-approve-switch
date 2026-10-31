window.__ModuleLoader__.load({
  id: "auto-approve-switch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // Bundled from src/client.ts — regenerate with `npm run build:client`.
    "use strict";
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name2 in all)
        __defProp(target, name2, { get: all[name2], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    // src/client.ts
    var client_exports = {};
    __export(client_exports, {
      apply: () => apply,
      inject: () => inject,
      name: () => name
    });
    module.exports = __toCommonJS(client_exports);
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var ReactDOM = require("react-dom/client");
    var COMMAND_ID = "auto-approve-switch.toggle";
    var ROUTE_PREFIX = "/auto-approve-switch";
    var LABEL_ON = "已开启自动放行";
    var LABEL_OFF = "已恢复手动审批";
    var TOAST_HOLD_MS = 2200;
    var HIDDEN_POLL_MS = 8e3;
    async function fetchStatus() {
      const response = await fetch(`${ROUTE_PREFIX}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status ${String(response.status)}`);
      const body = await response.json();
      if (body?.ok !== true || typeof body.enabled !== "boolean") {
        throw new Error("unexpected status payload");
      }
      return body;
    }
    var ToggleError = class extends Error {
      constructor(message, status) {
        super(message);
        this.status = status;
      }
    };
    async function putState(enabled) {
      let response;
      try {
        response = await fetch(`${ROUTE_PREFIX}/state`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled }),
          cache: "no-store"
        });
      } catch (error) {
        throw new ToggleError(String(error?.message ?? error), null);
      }
      if (!response.ok) throw new ToggleError(`Host 返回 ${String(response.status)}`, response.status);
      const body = await response.json().catch(() => null);
      if (body?.ok !== true || typeof body.enabled !== "boolean") {
        return await fetchStatus();
      }
      return body;
    }
    function showToast(text, tone) {
      const Toast = primitives?.Toast;
      const createRoot = ReactDOM?.createRoot;
      if (typeof Toast !== "function" || typeof createRoot !== "function") {
        console.info(`[auto-approve-switch] ${text}`);
        return;
      }
      const host = document.createElement("div");
      host.dataset.autoApproveSwitchToast = "";
      document.body.appendChild(host);
      const root = createRoot(host);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.setTimeout(() => {
          root.unmount();
          host.remove();
        }, 0);
      };
      const icon = tone === "info" && typeof primitives.IconWarningOutlineRegular === "function" ? React.createElement(primitives.IconWarningOutlineRegular, { size: 18 }) : void 0;
      root.render(
        React.createElement(Toast, {
          text,
          ...tone === "success" ? { tone: "success" } : {},
          ...icon === void 0 ? {} : { icon },
          holdMs: TOAST_HOLD_MS,
          onDone: finish
        })
      );
    }
    var INTENT_KEY = "auto-approve-switch.intent";
    var POLL_MS = 1500;
    var CONFIRM_POLL_MS = 300;
    var RETRY_POLL_MS = 4e3;
    var REPLAY_WINDOW_MS = 6e4;
    function readIntent() {
      try {
        const raw = window.localStorage.getItem(INTENT_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        if (typeof parsed?.enabled === "boolean" && typeof parsed?.at === "number") {
          return { enabled: parsed.enabled, at: parsed.at };
        }
      } catch {
      }
      return null;
    }
    function writeIntent(intent) {
      try {
        if (intent === null) window.localStorage.removeItem(INTENT_KEY);
        else window.localStorage.setItem(INTENT_KEY, JSON.stringify(intent));
      } catch {
      }
    }
    var SwitchStore = class {
      state = { enabled: null, revision: -1, pending: false, error: null, connected: false, unconfirmed: false };
      listeners = /* @__PURE__ */ new Set();
      disposed = false;
      /** The intent currently outstanding, or `null` when the page is in sync. */
      intent = null;
      /** Coalesces concurrent submissions of the same intent. */
      inFlight = null;
      constructor() {
        const restored = readIntent();
        if (restored !== null) {
          this.intent = restored;
          this.state = { ...this.state, enabled: restored.enabled, pending: true, unconfirmed: true };
        }
      }
      /** Whether the Host still has to confirm something this page asked for. */
      get hasUnconfirmedIntent() {
        return this.intent !== null;
      }
      /** How often the sync loop should poll right now (ms). */
      get pollDelay() {
        if (this.intent === null) return POLL_MS;
        return Date.now() - this.intent.at < REPLAY_WINDOW_MS ? CONFIRM_POLL_MS : RETRY_POLL_MS;
      }
      /** When set, toggles are applied in-process instead of over HTTP. */
      bridgeToggle = null;
      bridgeSet = null;
      /**
       * Install (or remove) the in-process bridge used by `toggle()`/`setEnabled()`.
       *
       * Both verbs are wired because the sidebar renders a `Switch`: it reports the
       * value the user chose, so applying it must be idempotent ("set"), while the
       * shortcut still sends "the other one" ("toggle").
       *
       * @param toggle - flips the value in-process, or `null` for the HTTP path.
       * @param set    - applies an explicit value in-process, or `null`.
       */
      useBridge(toggle, set = null) {
        this.bridgeToggle = toggle;
        this.bridgeSet = set;
      }
      /**
       * Adopt a status pushed by the Host module itself (same realm).
       *
       * Unlike `reconcile` this never sends anything: a direct push is by
       * definition the Host's own newest truth, so it clears any local intent and
       * never toasts — the user already saw their own toggle.
       *
       * @param status - the Host's current status.
       */
      adoptSnapshot(status) {
        if (this.disposed) return;
        if (this.intent !== null && status.enabled === this.intent.enabled) {
          this.intent = null;
          writeIntent(null);
        }
        this.set({
          enabled: status.enabled,
          revision: status.revision,
          pending: false,
          unconfirmed: false,
          connected: true,
          error: null
        });
      }
      getSnapshot = () => this.state;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      };
      /** Replace state and notify; a no-op once the plugin is disposed. */
      set(patch) {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch (error) {
            console.error("[auto-approve-switch] store listener failed", error);
          }
        }
      }
      /**
       * Read the Host status once.
       * @param announce - show a toast when the value changed *elsewhere*.
       */
      async refresh(announce = true) {
        try {
          const status = await fetchStatus();
          this.set({ connected: true, error: null });
          await this.reconcile(status, announce);
        } catch (error) {
          const message = String(error?.message ?? error);
          this.set({ connected: false, error: message });
          diag(`status read failed: ${message}`);
        }
      }
      /**
       * Compare a Host status against the current state and the outstanding intent.
       *
       * Three outcomes:
       *  - no intent           → adopt the Host value; toast only if it changed
       *                          elsewhere (another window, a restart restore).
       *  - intent confirmed    → adopt it, clear the intent, keep quiet (the user
       *                          already saw the toast when they pressed the key).
       *  - intent outstanding  → keep showing the requested value; try to replay it.
       *
       * @param status   - fresh Host status.
       * @param announce - whether a change made elsewhere should toast.
       */
      async reconcile(status, announce) {
        const intent = this.intent;
        if (status.revision !== 0 && status.revision < this.state.revision) return;
        if (intent === null) {
          const previous = this.state;
          const changedElsewhere = previous.enabled !== null && previous.enabled !== status.enabled && status.revision !== previous.revision;
          this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false });
          if (announce && changedElsewhere) {
            showToast(`${status.enabled ? LABEL_ON : LABEL_OFF}（已同步 Host 状态）`, status.enabled ? "success" : "info");
          }
          return;
        }
        if (status.enabled === intent.enabled) {
          this.intent = null;
          writeIntent(null);
          this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false });
          return;
        }
        this.set({ enabled: intent.enabled, revision: status.revision, pending: true, unconfirmed: true });
        if (Date.now() - intent.at < REPLAY_WINDOW_MS) {
          await this.submit(intent).catch(() => {
          });
        }
      }
      /**
       * Apply the outstanding intent on the Host (one request at a time).
       *
       * @param intent - the requested value and its timestamp.
       */
      submit(intent) {
        if (this.inFlight !== null) return this.inFlight;
        this.inFlight = (async () => {
          try {
            const status = await putState(intent.enabled);
            if (this.intent?.at !== intent.at) return;
            if (status.enabled === intent.enabled) {
              this.intent = null;
              writeIntent(null);
              this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false, connected: true, error: null });
            } else {
              this.set({ revision: status.revision, error: `Host 仍为 ${status.enabled ? "开" : "关"}，正在后台重试` });
            }
          } finally {
            this.inFlight = null;
          }
        })();
        return this.inFlight;
      }
      /**
       * Flip the switch.
       *
       * The toggle is **optimistic**: the requested value is shown and persisted
       * before the request goes out, so a request the page cannot observe (a proxy
       * that rewrites the response, a transient network error) never looks like a
       * failure of a toggle that in fact happened. The Host is then asked to apply
       * it, idempotently, and keeps being retried until a status read confirms it.
       *
       * Only a definitive refusal (`4xx`) from the Host rolls the value back.
       */
      async toggle() {
        if (this.state.pending && this.inFlight !== null) return;
        if (this.bridgeToggle !== null) {
          try {
            const status = this.bridgeToggle();
            diag(`toggle via bridge -> enabled=${String(status.enabled)} revision=${String(status.revision)}`);
            this.intent = null;
            writeIntent(null);
            this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false, connected: true, error: null });
            showToast(status.enabled ? LABEL_ON : LABEL_OFF, status.enabled ? "success" : "info");
          } catch (error) {
            const message = String(error?.message ?? error);
            this.set({ pending: false, error: message });
            showToast(`⚠️ 切换失败：${message}`, "info");
          }
          return;
        }
        const target = this.state.enabled === null ? false : !this.state.enabled;
        const intent = { enabled: target, at: Date.now() };
        this.intent = intent;
        writeIntent(intent);
        this.set({ enabled: target, pending: true, unconfirmed: true, error: null });
        showToast(target ? LABEL_ON : LABEL_OFF, target ? "success" : "info");
        try {
          await this.submit(intent);
        } catch (error) {
          const status = error instanceof ToggleError ? error.status : null;
          const definitive = status !== null && status >= 400 && status < 500 && status !== 404;
          diag(`toggle failed: ${String(error?.message ?? error)} (definitive=${String(definitive)})`);
          if (!definitive) {
            this.set({ pending: true, unconfirmed: true, connected: false, error: String(error?.message ?? error) });
            return;
          }
          this.intent = null;
          writeIntent(null);
          const message = String(error?.message ?? error);
          this.set({ enabled: !target, pending: false, unconfirmed: false, error: message });
          showToast(`⚠️ 切换失败：Host 拒绝（${message}）`, "info");
        }
      }
      /**
       * Apply an explicit value (what the `Switch` reports).
       *
       * A toggle dialog is not involved: the requested value goes to the Host
       * verbatim, so switching on an already-on switch cannot turn it off.
       *
       * @param enabled - the value the user selected.
       */
      async setEnabled(enabled) {
        if (this.bridgeSet !== null) {
          try {
            const status = this.bridgeSet(enabled);
            this.intent = null;
            writeIntent(null);
            this.set({ enabled: status.enabled, revision: status.revision, pending: false, unconfirmed: false, connected: true, error: null });
            showToast(status.enabled ? LABEL_ON : LABEL_OFF, status.enabled ? "success" : "info");
          } catch (error) {
            const message = String(error?.message ?? error);
            this.set({ pending: false, error: message });
            showToast(`切换失败：${message}`, "info");
          }
          return;
        }
        if (this.state.enabled === enabled) return;
        const intent = { enabled, at: Date.now() };
        this.intent = intent;
        writeIntent(intent);
        this.set({ enabled, pending: true, unconfirmed: true, error: null });
        showToast(enabled ? LABEL_ON : LABEL_OFF, enabled ? "success" : "info");
        try {
          await this.submit(intent);
        } catch (error) {
          const status = error instanceof ToggleError ? error.status : null;
          const definitive = status !== null && status >= 400 && status < 500 && status !== 404;
          if (!definitive) {
            this.set({ pending: true, unconfirmed: true, connected: false, error: String(error?.message ?? error) });
            return;
          }
          this.intent = null;
          writeIntent(null);
          const message = String(error?.message ?? error);
          this.set({ pending: false, unconfirmed: false, error: message });
          showToast(`切换失败：${message}`, "info");
        }
      }
      /** Stop notifying and ignore late responses. */
      dispose() {
        this.disposed = true;
        this.listeners.clear();
      }
    };
    var SLOT_KEY = "sidebar.footer.action";
    function AutoApproveSwitchControl(props) {
      const { store, shortcutHint: shortcutHint2 } = props;
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      const on = state.enabled === true;
      const title = state.enabled === null ? `自动放行：正在读取状态${state.error === null ? "" : `（${state.error}）`}` : state.unconfirmed ? `${state.enabled ? LABEL_ON : LABEL_OFF}（等待确认，后台重试中） · ${shortcutHint2}` : `${state.enabled ? LABEL_ON : LABEL_OFF} · 快捷键 ${shortcutHint2}`;
      const Switch = primitives?.Switch;
      const apply2 = (next) => {
        void store.setEnabled(next);
      };
      if (typeof Switch === "function") {
        return React.createElement(Switch, {
          checked: on,
          disabled: state.pending,
          // `Switch` takes the visible label as a string; it supplies its own
          // spacing, track, knob and focus ring from the shell's design tokens.
          label: "自动放行",
          title,
          className: "auto-approve-switch",
          onChange: apply2
        });
      }
      return React.createElement(
        "button",
        {
          type: "button",
          className: "auto-approve-switch",
          "data-auto-approve-switch": on ? "on" : "off",
          "aria-pressed": on,
          "aria-label": title,
          title,
          disabled: state.pending,
          onClick: () => apply2(!on),
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 10px",
            borderRadius: "999px",
            border: "1px solid color-mix(in oklab, currentColor 20%, transparent)",
            background: on ? "color-mix(in oklab, #22c55e 20%, transparent)" : "transparent",
            color: "inherit",
            font: "inherit",
            fontSize: "12px",
            lineHeight: "18px",
            cursor: state.pending ? "progress" : "pointer",
            opacity: state.enabled === null ? 0.6 : 1
          }
        },
        React.createElement("span", {
          "aria-hidden": true,
          style: {
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            flex: "none",
            background: state.enabled === null ? "#9ca3af" : on ? "#22c55e" : "#ef4444"
          }
        }),
        React.createElement("span", null, "自动放行"),
        React.createElement("span", { "aria-hidden": true, style: { opacity: 0.6 } }, on ? "开" : state.enabled === null ? "—" : "关")
      );
    }
    var SHORTCUT_DEFAULTS = {
      "desktop:macos": { code: "KeyA", modifiers: ["primary", "alt"] },
      "desktop:windows": { code: "KeyA", modifiers: ["primary", "alt"] },
      "desktop:linux": { code: "KeyA", modifiers: ["primary", "alt"] },
      "web:macos": { code: "KeyA", modifiers: ["primary", "alt"] },
      "web:windows": { code: "KeyA", modifiers: ["primary", "alt"] },
      "web:linux": { code: "KeyA", modifiers: ["primary", "alt"] }
    };
    function shortcutHint() {
      let mac = true;
      try {
        mac = /Mac|iPhone|iPad/i.test(String(navigator.platform || navigator.userAgent));
      } catch {
      }
      return mac ? "⌘⌥A" : "Ctrl+Alt+A";
    }
    function registerShortcut(ctx, store) {
      let shortcuts;
      try {
        shortcuts = ctx.shortcuts;
      } catch {
        return false;
      }
      if (shortcuts === void 0 || typeof shortcuts.register !== "function") return false;
      try {
        const dispose = shortcuts.register({
          id: COMMAND_ID,
          label: () => "切换自动放行",
          aliases: ["auto approve", "auto approve switch", "自动放行", "审批"],
          defaults: SHORTCUT_DEFAULTS,
          // Active everywhere a keystroke can land, including the composer and the
          // terminal, because the switch is global rather than per-panel.
          regions: ["page", "editable", "terminal"],
          // Allowed while the approval UI itself is open: that is exactly when a
          // user may want to stop the next prompt.
          modals: ["approval", "settings", "dialog", "other"],
          resolve: () => {
            if (store.getSnapshot().pending) {
              return { status: "blocked", reason: "正在切换自动放行，请稍候" };
            }
            return {
              status: "handled",
              run: () => {
                void store.toggle();
              }
            };
          }
        });
        ctx.effect(() => dispose, "auto-approve-switch: shortcut");
        return true;
      } catch (error) {
        console.error("[auto-approve-switch] could not register the shortcut command", error);
        return false;
      }
    }
    function installKeyboardFallback(store) {
      const handler = (event) => {
        if (event.repeat || event.isComposing) return;
        if (event.code !== "KeyA" || event.shiftKey) return;
        const primary = /Mac|iPhone|iPad/i.test(String(navigator.platform || navigator.userAgent)) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (!primary || !event.altKey) return;
        event.preventDefault();
        void store.toggle();
      };
      window.addEventListener("keydown", handler, true);
      return () => window.removeEventListener("keydown", handler, true);
    }
    var name = "auto-approve-switch";
    var inject = [];
    var DIRECT_BRIDGE_GLOBAL = "__DSH_AUTO_APPROVE_SWITCH__";
    function directBridge() {
      try {
        const candidate = globalThis[DIRECT_BRIDGE_GLOBAL];
        if (candidate !== null && typeof candidate === "object" && typeof candidate.get === "function" && typeof candidate.set === "function" && typeof candidate.subscribe === "function") {
          return candidate;
        }
      } catch {
      }
      return null;
    }
    var diagTarget = null;
    function diag(line) {
      try {
        if (diagTarget !== null) diagTarget(line);
        else console.info(`[auto-approve-switch] ${line}`);
      } catch {
      }
    }
    function apply(ctx) {
      const store = new SwitchStore();
      const bridge = directBridge();
      diagTarget = bridge !== null && typeof bridge.log === "function" ? (line) => bridge.log?.(line) : (line) => console.info(`[auto-approve-switch] ${line}`);
      diag(`client apply(): bridge=${bridge === null ? "ABSENT (HTTP fallback)" : "FOUND (in-process)"}; location=${typeof location === "object" ? String(location.origin) : "n/a"}`);
      if (bridge !== null) {
        try {
          store.adoptSnapshot(bridge.get());
          ctx.effect(
            () => bridge.subscribe(() => store.adoptSnapshot(bridge.get())),
            "auto-approve-switch: direct bridge"
          );
          console.info("[auto-approve-switch] 使用进程内直连（不经过 HTTP）");
        } catch (error) {
          console.warn("[auto-approve-switch] 直连桥不可用，回退到 HTTP", error);
        }
      }
      store.useBridge(
        bridge === null ? null : () => bridge.toggle(),
        bridge === null ? null : (enabled) => bridge.set(enabled)
      );
      let removeFallback = null;
      let shortcutRegistered = false;
      const stopFallback = (reason) => {
        if (removeFallback === null) return;
        removeFallback();
        removeFallback = null;
        diag(`keyboard fallback removed (${reason})`);
      };
      const startFallback = (reason) => {
        if (shortcutRegistered || removeFallback !== null) return;
        removeFallback = installKeyboardFallback(store);
        diag(`keyboard fallback installed (${reason})`);
      };
      try {
        ctx.inject(["shortcuts"], (scope) => {
          shortcutRegistered = registerShortcut(scope, store);
          diag(`shortcut service: ${shortcutRegistered ? "registered" : "register() refused"}`);
          if (shortcutRegistered) stopFallback("shortcut service became available");
          else startFallback("shortcut service refused the command");
        });
      } catch (error) {
        diag(`shortcut service wait failed: ${String(error?.message ?? error)}`);
        startFallback("shortcut service unavailable");
      }
      try {
        ctx.inject(["slots"], (scope) => {
          try {
            scope.slots.inject(SLOT_KEY, () => scope.slots.register({
              name: SLOT_KEY,
              id: "auto-approve-switch",
              order: 60,
              inject: () => ({ store, shortcutHint: shortcutHint() })
            }, AutoApproveSwitchControl));
            diag(`sidebar control: registered into "${SLOT_KEY}"`);
          } catch (error) {
            diag(`sidebar control failed: ${String(error?.message ?? error)}`);
          }
        });
      } catch (error) {
        diag(`slots service wait failed: ${String(error?.message ?? error)}`);
      }
      ctx.effect(() => {
        const timer = window.setTimeout(() => startFallback("shortcut service did not mount within 1.5s"), 1500);
        return () => {
          window.clearTimeout(timer);
          stopFallback("plugin disposed");
        };
      }, "auto-approve-switch: keyboard fallback");
      const bridgeLive = bridge !== null && store.getSnapshot().connected;
      ctx.effect(() => {
        if (bridgeLive) return () => store.dispose();
        let timer;
        let stopped = false;
        const schedule = () => {
          if (stopped) return;
          const delay = store.hasUnconfirmedIntent ? store.pollDelay : document.visibilityState === "hidden" ? HIDDEN_POLL_MS : POLL_MS;
          timer = window.setTimeout(() => void tick(), delay);
        };
        const tick = async () => {
          if (stopped) return;
          await store.refresh(true);
          schedule();
        };
        const onFocus = () => {
          void store.refresh(false);
        };
        void tick();
        window.addEventListener("focus", onFocus);
        return () => {
          stopped = true;
          window.removeEventListener("focus", onFocus);
          if (timer !== void 0) window.clearTimeout(timer);
          store.dispose();
        };
      }, "auto-approve-switch: host sync");
      diag(`client ready: shortcut=${shortcutRegistered ? "service" : "keyboard fallback"}; ui=${typeof primitives?.Switch === "function" ? "Switch" : "fallback button"}`);
    }
    return module.exports;
  }
});
