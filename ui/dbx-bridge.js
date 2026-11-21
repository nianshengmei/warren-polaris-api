/* dbx-bridge.js — window.dbxPlugin 的唯一封装。所有宿主交互经此通道，
 * 使 UI 在无宿主（浏览器调试）时也能降级运行。
 *
 * 关键修复（v0.1.x 的坑）：localStorage 在 sandbox="allow-scripts" 无 same-origin
 * 的 DBX iframe 里访问会抛错，原版用 try/catch 静默吞掉导致持久化无声失效。
 * 本版降级改用内存 Map：宿主可用时走 dbxPlugin.storage（需声明 host.storage），
 * 否则退内存（重启丢失，但功能正常不报错）。
 *
 * 暴露：window.DBXBridge = { ready, locale, appearance, theme, context, storage, invoke, setTitle }
 */
(function () {
  const bridge = window.DBXBridge = {};
  const plugin = typeof window.dbxPlugin !== "undefined" ? window.dbxPlugin : null;
  bridge.plugin = plugin;

  let state = { locale: "zh-CN", appearance: "dark", context: {}, readyResolved: false, readyOk: false, backendInfo: null };

  /* 内存降级存储（沙箱 localStorage 不可靠时使用） */
  const memStore = new Map();

  bridge.ready = (async () => {
    if (!plugin) {
      state.readyOk = false;
      state.readyResolved = true;
      /* 无宿主：尝试 localStorage（独立调试模式可用则用，不可用则忽略） */
      return false;
    }
    try {
      await plugin.ready;
      state.locale = plugin.locale || "zh-CN";
      const theme = plugin.theme;
      state.appearance = typeof theme === "string" ? theme : (theme && theme.appearance) || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      state.context = plugin.context || {};
      if (plugin.onContext) plugin.onContext((next) => { state.context = next || {}; });
      state.readyOk = true;
      state.readyResolved = true;
      applyTheme(state.appearance);
      return true;
    } catch (error) {
      state.readyOk = false;
      state.readyResolved = true;
      state.error = error && error.message;
      return false;
    }
  })();

  function applyTheme(appearance) {
    const root = document.getElementById("root") || document.documentElement;
    root.setAttribute("data-dbx-theme", appearance);
    document.documentElement.setAttribute("data-dbx-theme", appearance);
  }
  bridge.applyTheme = applyTheme;

  /* 存储：优先 dbxPlugin.storage（声明 host.storage 后可用），否则内存降级。
   * 不再用 localStorage：sandbox="allow-scripts" 无 same-origin 时访问抛错，
   * 静默吞掉会导致持久化无声失效（v0.1.x 的坑）。 */
  bridge.storage = {
    async get(key) {
      if (plugin && plugin.storage && plugin.storage.get) {
        try { return await plugin.storage.get(key); } catch (e) { /* fallthrough 到内存 */ }
      }
      return memStore.has(key) ? memStore.get(key) : null;
    },
    async set(key, value) {
      if (plugin && plugin.storage && plugin.storage.set) {
        try { await plugin.storage.set(key, value); return; } catch (e) { /* fallthrough */ }
      }
      memStore.set(key, value);
    },
    async delete(key) {
      if (plugin && plugin.storage && plugin.storage.delete) {
        try { await plugin.storage.delete(key); return; } catch (e) { /* fallthrough */ }
      }
      memStore.delete(key);
    },
  };

  bridge.invoke = async (method, params, options) => {
    if (plugin && plugin.invoke) return plugin.invoke(method, params, options);
    throw new Error("dbxPlugin.invoke 不可用");
  };

  bridge.setTitle = async (title) => {
    if (plugin && plugin.setTitle) { try { await plugin.setTitle(title); } catch (e) { /* ignore */ } }
  };

  /* ---------- 宿主事件订阅（manifest 需声明 host.events） ----------
   * 后端（sidecar）用 JSON-RPC 通知发事件，宿主 `pluginHostBridge.forwardEvent`
   * 校验过 host.events 权限后，以 `postMessage({source:"dbx-host", version:1,
   * type:"event", method, params})` 投递给 iframe。
   *
   * 这就是「订阅式传输」的落点：SSE 的每一块都走这里，单条只有几 KB，
   * 总量不再受「单条 JSON 消息 8 MiB」的限制 —— 流多长都行。
   *
   * 收不到事件（老宿主 / 没授权）时不会报错，onEvent 返回的退订函数照常可用；
   * 后端探测不到消费者会自己退回一次性返回，所以这里静默降级即可。
   */
  const evtListeners = new Map();
  function onHostMessage(e) {
    const d = e && e.data;
    if (!d || d.source !== "dbx-host" || d.version !== 1 || d.type !== "event") return;
    const set = evtListeners.get(d.method);
    if (!set || !set.size) return;
    for (const fn of Array.from(set)) {
      try { fn(d.params || {}); } catch (err) { /* 一个订阅者抛错不影响其它订阅者 */ }
    }
  }
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("message", onHostMessage);
  }
  bridge.onEvent = function (method, fn) {
    if (typeof method !== "string" || typeof fn !== "function") return function () {};
    let set = evtListeners.get(method);
    if (!set) { set = new Set(); evtListeners.set(method, set); }
    set.add(fn);
    return function () { set.delete(fn); if (!set.size) evtListeners.delete(method); };
  };

  const getters = {
    get locale() { return state.locale; },
    get appearance() { return state.appearance; },
    get context() { return state.context; },
    get readyOk() { return state.readyOk; },
    get backendInfo() { return state.backendInfo; },
    set backendInfo(v) { state.backendInfo = v; },
  };
  /* 必须用 defineProperties：Object.assign 只搬「当前值」，访问器会在这一瞬间被求值成常量。
   * 之前写成 Object.assign(bridge, getters)，导致 readyOk 永远等于加载那一刻的 false，
   * 于是 http-workspace 的 hostAvailable() 恒为假 —— 结果保存（_results）与扫描整条链路静默失效。
   * 这不是 1.0.0 的改动，是 v0.6.x 起就躺着的老坑，S4.4 收口时按真实链路摸出来的。 */
  Object.defineProperties(bridge, Object.getOwnPropertyDescriptors(getters));
})();
