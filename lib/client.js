window.__ModuleLoader__.load({
  id: "dsh-notification",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // dsh-notification — web client face
    //
    // 只消费 `ctx.sessions`：会话列表快照（`running` / `pendingInteraction`）是 host
    // own 的那份事实，侧栏的琥珀点也读它，所以通知永远不会和侧栏说的不一样。
    //
    // 判定规则（对齐侧栏语义）：
    // 1. 某会话的 `pendingInteraction` 从「无/别的」变成「有」→ 该会话开始等你，发通知。
    //    审批(approval) / 提问(question) / 计划审核(plan-review) 三种分别可开关。
    // 2. 某会话 running 由 true → false 且没有在等你 → 本轮跑完，发通知。
    // 3. 第一次见到某个会话只做「播种」，不发通知：刷新页面、断线重连会把整张列表
    //    重新灌进来，那些状态用户并没有看着它发生，不该炸一串通知。
    //
    // 正文（"动作"）尽量说具体做什么：审批时取该 approval 配对的那次 tool call，
    // 用 host 算好的 callView.title（终端卡片的 title 就是命令本身），拿不到再退回
    // 解析 argsRaw、再退回模型给的 reason、最后才退回工具名。

    var inject = ["sessions"];

    /** localStorage 里的配置键；改完刷新页面（或调 window.__dshNotification.set）即生效。 */
    var SETTINGS_KEY = "dsh-notification";

    var DEFAULTS = {
      /** 权限审批请求出现时通知。 */
      approval: true,
      /** AskUserQuestion 提问出现时通知。 */
      question: true,
      /** 计划审核（plan-review）出现时通知。 */
      planReview: true,
      /** 一轮跑完且没人在等你时通知。 */
      turnComplete: true,
      /** 目标就是当前会话、且页面可见又有焦点时不打扰——你正看着它。 */
      suppressWhenAttended: true,
      /** origin=subagent 的行也通知；默认关：一次委派会跑完很多你没打开过的子会话。 */
      includeSubagents: false,
      /** 短于这个毫秒数的一轮不报「完成」——你还没来得及走开它就结束了。 */
      minTurnMs: 0,
      /** 等你操作的通知常驻，直到你点它；「完成」类不常驻。 */
      requireInteraction: true,
      /** 正文最大长度，超出截断。 */
      bodyMax: 180,
    };

    /* ── 配置 ─────────────────────────────────────────────── */

    function readSettings() {
      var merged = {};
      for (var key in DEFAULTS) merged[key] = DEFAULTS[key];
      try {
        var raw = window.localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            for (var k in DEFAULTS) if (parsed[k] !== undefined) merged[k] = parsed[k];
          }
        }
      } catch (error) {
        // 隐私模式禁用 localStorage、或人手写坏了 JSON：用默认值，功能照跑。
      }
      return merged;
    }

    function writeSettings(patch) {
      var next = readSettings();
      for (var k in patch) if (DEFAULTS[k] !== undefined) next[k] = patch[k];
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch (error) {
        // 同上：存不下就只影响持久化，当前会话仍按新值跑不了，如实返回旧值。
      }
      return next;
    }

    /* ── 文案 ─────────────────────────────────────────────── */

    var FALLBACK_BODY = {
      approval: "智能体在等待你的授权",
      question: "智能体在等待你的回答",
      "plan-review": "智能体在等待你审核计划",
    };

    /** 折成一行并截断：系统通知只有一两行，换行和长参数都是噪音。 */
    function oneLine(text, max) {
      if (typeof text !== "string") return undefined;
      var flat = text.replace(/\s+/g, " ").trim();
      if (flat === "") return undefined;
      if (flat.length <= max) return flat;
      return flat.slice(0, Math.max(1, max - 1)) + "…";
    }

    /** 递归找这次 tool call（子调用也要找：subagent 里的审批同样会问到你头上）。 */
    function findCall(calls, callId) {
      if (!calls || !callId) return undefined;
      for (var i = 0; i < calls.length; i++) {
        var call = calls[i];
        if (!call) continue;
        if (call.callId === callId) return call;
        var nested = findCall(call.subCalls, callId);
        if (nested) return nested;
      }
      return undefined;
    }

    /** 从工具入参里挑最能说明「这次要干什么」的那一个字段。 */
    var SALIENT_ARGS = ["command", "file_path", "path", "url", "pattern", "query", "prompt"];

    function argsSummary(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw === "") return undefined;
      var args;
      try {
        args = JSON.parse(argsRaw);
      } catch (error) {
        // 模型的入参还没流完/不是合法 JSON：不猜，交给上层退回工具名。
        return undefined;
      }
      if (!args || typeof args !== "object") return undefined;
      for (var i = 0; i < SALIENT_ARGS.length; i++) {
        var value = args[SALIENT_ARGS[i]];
        if (typeof value === "string" && value.trim() !== "") return value;
      }
      for (var key in args) {
        if (typeof args[key] === "string" && args[key].trim() !== "") return args[key];
      }
      return undefined;
    }

    /**
     * 这次调用的一行说明。优先 host 算好的 callView.title——它就是会话里工具卡片
     * 顶上那行（终端卡片的 title 即命令本身），通知和卡片说同一句话。
     */
    function callDetail(call) {
      if (!call) return undefined;
      var view = call.callView;
      if (view && typeof view.title === "string" && view.title.trim() !== "") return view.title;
      return argsSummary(call.argsRaw);
    }

    /** 审批正文：工具名 + 这次调用的具体动作。 */
    function approvalBody(payload, call, max) {
      var tool = payload && typeof payload.toolName === "string" ? payload.toolName : "";
      var detail = oneLine(callDetail(call), max);
      if (tool !== "" && detail) return oneLine(tool + " · " + detail, max);
      if (detail) return detail;
      var reason = oneLine(payload && payload.reason, max);
      if (reason) return reason;
      if (tool !== "") return oneLine(tool + " 请求授权", max);
      return FALLBACK_BODY.approval;
    }

    /** 提问正文：第一个问题本身（拿不到就用它的短标签）。 */
    function questionBody(payload, max) {
      var items = payload && payload.questions;
      var first = items && items.length > 0 ? items[0] : undefined;
      if (!first) return FALLBACK_BODY.question;
      var text = oneLine(first.question, max) || oneLine(first.header, max);
      if (!text) return FALLBACK_BODY.question;
      return items.length > 1 ? oneLine(text + "（共 " + items.length + " 问）", max) : text;
    }

    /* ── 状态机 ───────────────────────────────────────────── */

    function askEnabled(settings, interaction) {
      if (interaction === "approval") return settings.approval === true;
      if (interaction === "question") return settings.question === true;
      if (interaction === "plan-review") return settings.planReview === true;
      return false;
    }

    /**
     * 把一张会话列表快照和上一次的记忆对照，折出该报的事。
     * @param previous 上次返回的 tracked（首次传 {}）。
     * @param state `ctx.sessions.list.getSnapshot()`。
     * @param now 当前毫秒。
     * @param settings 当前配置。
     * @returns {{alerts: Array, tracked: Object}}
     */
    function detectAlerts(previous, state, now, settings) {
      var alerts = [];
      var tracked = {};
      var ids = state && state.ids ? state.ids : [];
      var byId = (state && state.byId) || {};
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        var row = byId[id];
        // ids 和 byId 是一起发布的，但增量删除和排序帧交错时某一帧里可能查不到；
        // 跳过就等于把它踢出记忆，下次再出现按「第一次见到」重新播种。
        if (!row) continue;
        var before = previous[id];
        var running = row.running === true;
        var runStartedAt = running ? (before && before.running ? before.runStartedAt : now) : undefined;
        tracked[id] = { running: running, pending: row.pendingInteraction, runStartedAt: runStartedAt };
        if (!before) continue;
        if (settings.includeSubagents !== true && row.origin === "subagent") continue;
        if (row.pendingInteraction !== undefined && row.pendingInteraction !== before.pending) {
          // 同一帧里「停下来」和「开始等你」一起发生时，后者更能说明它为什么停，
          // 所以这一行的唯一一条通知归它。
          if (askEnabled(settings, row.pendingInteraction)) {
            alerts.push({
              kind: "ask",
              sessionId: id,
              interaction: row.pendingInteraction,
              title: row.displayTitle,
            });
          }
          continue;
        }
        if (settings.turnComplete !== true) continue;
        if (!before.running || running) continue;
        // 还卡在一个你早就看见的等待上，不算「跑完了」。
        if (row.pendingInteraction !== undefined) continue;
        if (before.runStartedAt !== undefined && now - before.runStartedAt < settings.minTurnMs) continue;
        alerts.push({ kind: "turn-complete", sessionId: id, title: row.displayTitle });
      }
      return { alerts: alerts, tracked: tracked };
    }

    /* ── 浏览器通知 ───────────────────────────────────────── */

    function createPresenter() {
      var api = window.Notification;
      // 同一个 tag 会被系统合并成一个槽位，留旧句柄也关不掉了，所以每个 tag 只记最新的。
      var live = {};
      var asking = null;
      var disposed = false;

      function permit() {
        if (!api) return Promise.resolve("denied");
        var current = api.permission;
        if (current !== "default") return Promise.resolve(current);
        if (!asking) {
          asking = Promise.resolve(api.requestPermission()).then(
            function (state) {
              asking = null;
              return state;
            },
            function (error) {
              asking = null;
              throw error;
            },
          );
        }
        return asking;
      }

      return {
        available: Boolean(api),
        permission: function () {
          return api ? api.permission : "denied";
        },
        request: permit,
        present: function (request) {
          if (!api || disposed) return;
          permit().then(
            function (state) {
              if (state !== "granted" || disposed) return;
              var previous = live[request.tag];
              if (previous) previous.close();
              var notification = new api(request.title, {
                body: request.body,
                tag: request.tag,
                icon: "/favicon.svg",
                requireInteraction: request.requireInteraction === true,
              });
              live[request.tag] = notification;
              notification.onclick = function () {
                delete live[request.tag];
                notification.close();
                if (request.onActivate) request.onActivate();
              };
              notification.onclose = function () {
                if (live[request.tag] === notification) delete live[request.tag];
              };
            },
            function () {
              // 浏览器直接拒绝弹授权框（权限策略，或这次没有用户手势），
              // 既没东西可展示也没坏掉；下一次转变再问一次。
            },
          );
        },
        dispose: function () {
          disposed = true;
          for (var tag in live) live[tag].close();
          live = {};
        },
      };
    }

    /** 页面是否正被人看着：可见 + 有焦点。 */
    function isAttended() {
      if (typeof document === "undefined") return false;
      if (document.visibilityState !== undefined && document.visibilityState !== "visible") return false;
      return typeof document.hasFocus === "function" ? document.hasFocus() : true;
    }

    /* ── 装配 ─────────────────────────────────────────────── */

    function apply(ctx) {
      var presenter = createPresenter();
      var tracked = {};

      ctx.effect(
        function () {
          return function () {
            presenter.dispose();
          };
        },
        "dsh-notification: presenter lifetime",
      );

      /** 取该会话最新的某类 pending wait（要拿到 payload 才知道"动作"是什么）。 */
      function latestPending(sessionId, kind) {
        var snapshot;
        try {
          var binding = ctx.sessions.binding(sessionId);
          snapshot = binding && binding.session ? binding.session.getSnapshot() : undefined;
        } catch (error) {
          // 会话已从列表移除等：拿不到就退回通用文案，绝不因为文案挂掉通知。
          return undefined;
        }
        if (!snapshot) return undefined;
        var list = snapshot.pending || [];
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i] && list[i].kind === kind) return { wait: list[i], snapshot: snapshot };
        }
        return undefined;
      }

      function bodyOf(alert, settings) {
        var max = settings.bodyMax;
        if (alert.kind === "turn-complete") return "本轮已完成";
        if (alert.interaction === "approval") {
          var found = latestPending(alert.sessionId, "approval");
          if (!found) return FALLBACK_BODY.approval;
          var payload = found.wait.payload || {};
          return approvalBody(payload, findCall(found.snapshot.runningCalls, payload.callId), max);
        }
        if (alert.interaction === "question" || alert.interaction === "plan-review") {
          var asked = latestPending(alert.sessionId, "question");
          if (!asked) return FALLBACK_BODY[alert.interaction];
          if (alert.interaction === "plan-review") return FALLBACK_BODY["plan-review"];
          return questionBody(asked.wait.payload || {}, max);
        }
        return FALLBACK_BODY.approval;
      }

      function activate(sessionId) {
        try {
          window.focus();
        } catch (error) {
          // 有的浏览器不让脚本抢焦点：点击仍然要把会话切过去。
        }
        try {
          var state = ctx.sessions.list.getSnapshot();
          // 从弹出到点击之间这行可能已经没了；open 对未知 id 是 fail-loud 的，先查再开。
          if (state.ids.indexOf(sessionId) !== -1) ctx.sessions.open(sessionId);
        } catch (error) {
          // 打不开就只是没跳转，不该把点击回调炸成未捕获异常。
        }
      }

      function sync() {
        var settings = readSettings();
        var state = ctx.sessions.list.getSnapshot();
        var result = detectAlerts(tracked, state, Date.now(), settings);
        tracked = result.tracked;
        for (var i = 0; i < result.alerts.length; i++) {
          var alert = result.alerts[i];
          if (settings.suppressWhenAttended === true && state.current === alert.sessionId && isAttended()) continue;
          presenter.present({
            title: alert.title || "DeepSeek Harness",
            body: bodyOf(alert, settings),
            tag: "dsh-notification:" + alert.sessionId,
            requireInteraction: alert.kind === "ask" && settings.requireInteraction === true,
            onActivate: (function (sessionId) {
              return function () {
                activate(sessionId);
              };
            })(alert.sessionId),
          });
        }
      }

      // 先播种再订阅：挂载时已经站在那儿的行是用户没看着它变的状态，不该报。
      sync();
      ctx.effect(
        function () {
          return ctx.sessions.list.subscribe(function () {
            sync();
          });
        },
        "dsh-notification: session list watch",
      );

      // 控制台入口：授权、改配置、发一条测试通知。
      window.__dshNotification = {
        settings: readSettings,
        set: function (patch) {
          return writeSettings(patch || {});
        },
        permission: presenter.permission,
        request: presenter.request,
        test: function (title, body) {
          presenter.present({
            title: title || "dsh-notification",
            body: body || "测试通知：Bash · echo hello",
            tag: "dsh-notification:test",
            requireInteraction: false,
            onActivate: function () {},
          });
        },
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    // 纯函数导出给测试用（apply 之外没有别的副作用面）。
    exports.detectAlerts = detectAlerts;
    exports.approvalBody = approvalBody;
    exports.questionBody = questionBody;
    exports.argsSummary = argsSummary;
    exports.findCall = findCall;
    exports.oneLine = oneLine;
    exports.DEFAULTS = DEFAULTS;
    return module.exports;
  },
});
