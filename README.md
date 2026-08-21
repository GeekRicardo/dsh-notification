# dsh-notification

DeepSeek Harness web 插件：**会话开始等你的时候，弹一条浏览器系统通知**。

- **标题** = 对话标题（侧栏那行显示的 `displayTitle`）
- **正文** = 这次的动作，例如 `Bash · pnpm install --frozen-lockfile`
- **点通知** = 聚焦窗口并切到那条会话

## 什么时候会响

判定完全建立在会话列表快照上——`running` 和 `pendingInteraction` 是 host 自己那份事实，
侧栏的琥珀点读的也是它，所以通知不会和侧栏说的不一样。

| 节点 | 默认 | 正文 |
| --- | --- | --- |
| 权限审批请求出现（`approval`） | 开 | `工具名 · 具体动作`，例如 `Bash · rm -rf /tmp/x`；取不到就退回模型给的 `reason`，再退回工具名 |
| AskUserQuestion 提问出现（`question`） | 开 | 第一个问题本身；多问时补 `（共 N 问）` |
| 计划审核出现（`plan-review`） | 开 | `智能体在等待你审核计划` |
| 一轮跑完且没人在等你（`turn-complete`） | 开 | `本轮已完成` |

审批正文优先用 host 算好的 `callView.title`——终端卡片的标题就是命令本身，所以通知里
那行字和会话里工具卡片顶上那行字是同一句。

几条刻意的规则：

- **第一次见到某个会话只播种，不发通知。** 刷新页面、断线重连会把整张列表重新灌进来，
  那些状态你并没有看着它发生，不该炸一串通知。
- **你正看着的会话不打扰**（当前会话 + 页面可见 + 有焦点），可关。
- **等你操作的通知常驻**（`requireInteraction`），直到你点掉；「本轮完成」不常驻。
- **同一会话只占一个通知槽**（tag 收敛），忙碌的会话不会刷屏。
- **subagent 行默认不通知**：一次委派会跑完很多你根本没打开过的子会话。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/GeekRicardo/dsh-notification/main/install.sh | bash
```

或下载后本地运行：

```bash
bash install.sh [--dry-run] [--local] [--restart]
```

安装脚本做两件事：往 profile 的 `package.json` 里加 `dependencies` 与
`dsh.profile.bundles` 两处条目，然后 `pnpm install`。host 半边是进程启动时加载的，
所以装完要重启 dsh web 才生效（client 半边改动只要硬刷新页面）。

首次触发时浏览器会问一次通知权限；如果当时没有用户手势导致浏览器不肯弹框，
下一次转变会再问一次，也可以在 devtools 里直接 `__dshNotification.request()`。

## 配置

配置放在 localStorage 的 `dsh-notification` 键里，改完刷新页面即生效：

```js
__dshNotification.settings()              // 当前值
__dshNotification.set({ turnComplete: false, minTurnMs: 30000 })
__dshNotification.test()                  // 发一条测试通知（同时可用来触发授权）
__dshNotification.permission()            // 'default' | 'granted' | 'denied'
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `approval` | `true` | 权限审批请求出现时通知 |
| `question` | `true` | 提问出现时通知 |
| `planReview` | `true` | 计划审核出现时通知 |
| `turnComplete` | `true` | 一轮跑完时通知 |
| `suppressWhenAttended` | `true` | 你正看着的当前会话不打扰 |
| `includeSubagents` | `false` | subagent 行也通知 |
| `minTurnMs` | `0` | 短于这个毫秒数的一轮不报「完成」 |
| `requireInteraction` | `true` | 等你操作的通知常驻直到点击 |
| `bodyMax` | `180` | 正文最大长度 |

## 已知边界

- **通知权限被浏览器拒绝就什么都不会有**，插件不会重复骚扰，只在下一次转变时再试一次。
- 非当前会话的审批正文依赖该会话的 pending 明细；极少数情况下（会话刚从列表移除等）
  取不到明细，会退回通用文案「智能体在等待你的授权」，而不是漏掉通知。
- 上游 DeepSeek Harness 在未发布的版本里内置了一个 `ui-notifications` 插件，
  做的事情和这里第 1/2/4 行重叠（正文是固定文案，不带具体动作）。等它进到你装的
  版本里，这个插件要么关掉上游那个、要么只保留自己需要的差异部分。

## 开发

```bash
node --test test/*.test.mjs
```

测试把 `lib/client.js` 放进 `node:vm` 跑起来，取它导出的纯函数（转变检测、正文推导）来测，
不需要浏览器。

## License

MIT
