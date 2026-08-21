# Changelog

## 0.1.0 — 2026-08-21

- 首个版本：会话开始等你时弹浏览器系统通知，标题为对话标题，正文为具体动作。
- 三个触发节点，默认全开：权限审批请求（正文取工具名 + host 算好的 `callView.title`，
  例如 `Bash · rm -rf /tmp/x`）、AskUserQuestion 提问（正文取第一个问题）、
  本轮跑完（正文「本轮已完成」）。
- 判定建立在会话列表快照的 `running` / `pendingInteraction` 上，与侧栏琥珀点同源；
  首次见到某会话只播种不通知，刷新页面与断线重连不会炸一串。
- 你正看着的当前会话默认不打扰；等你操作的通知常驻直到点击；同一会话只占一个通知槽。
- 配置放在 localStorage 的 `dsh-notification` 键，`__dshNotification.set({...})` 可改，
  `__dshNotification.test()` 可发测试通知并触发授权。
