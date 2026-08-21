// dsh-notification — host face
//
// 本插件的全部能力在 web client（监听会话列表 + 调浏览器 Notification API），
// host 侧无服务、无事件、无工具，仅作为 cordis.patch.yml 插入行的挂载点存在。
// 保持空实现：将来若要做「桌面端转发」「静默时段由 host 判定」之类的能力再从这里进。

const inject = [];

function apply() {}

export { apply, inject };
