// 把 client.js 当普通脚本跑起来，取出它导出的纯函数来测。
// client.js 是 __ModuleLoader__ 注册体，不是 ESM，所以这里自己搭一个最小的 loader。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let registration
const sandbox = { window: { __ModuleLoader__: { load: (r) => { registration = r } } } }
sandbox.globalThis = sandbox
runInNewContext(source, sandbox)
const mod = registration.factory(() => { throw new Error('no externals expected') })

const { detectAlerts, approvalBody, questionBody, argsSummary, findCall, oneLine, DEFAULTS } = mod

const settings = { ...DEFAULTS }

/** vm 里造的对象跨 realm，原型不同——strict deepEqual 会因此判不等，先拍平成普通值。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

function listState(rows, current) {
  return { ids: rows.map(r => r.id), byId: Object.fromEntries(rows.map(r => [r.id, r])), current }
}

test('第一次见到某个会话只播种，不发通知', () => {
  const state = listState([{ id: 's1', displayTitle: '重构解析器', running: true, pendingInteraction: 'approval' }])
  const { alerts, tracked } = detectAlerts({}, state, 1000, settings)
  assert.equal(alerts.length, 0)
  assert.equal(tracked.s1.pending, 'approval')
})

test('pendingInteraction 从无到有时报一条 ask', () => {
  const before = listState([{ id: 's1', displayTitle: '重构解析器', running: true }])
  const seeded = detectAlerts({}, before, 1000, settings).tracked
  const after = listState([{ id: 's1', displayTitle: '重构解析器', running: true, pendingInteraction: 'approval' }])
  const { alerts } = detectAlerts(seeded, after, 2000, settings)
  assert.deepEqual(plain(alerts), [{ kind: 'ask', sessionId: 's1', interaction: 'approval', title: '重构解析器' }])
})

test('同一个 pending 持续存在不会重复报', () => {
  const row = { id: 's1', displayTitle: 'x', running: true, pendingInteraction: 'approval' }
  const seeded = detectAlerts({}, listState([row]), 1000, settings).tracked
  const { alerts } = detectAlerts(seeded, listState([row]), 2000, settings)
  assert.equal(alerts.length, 0)
})

test('审批开关关掉后不报审批，但提问照报', () => {
  const off = { ...settings, approval: false }
  const seeded = detectAlerts({}, listState([{ id: 's1', displayTitle: 'x', running: true }]), 0, off).tracked
  const approval = listState([{ id: 's1', displayTitle: 'x', running: true, pendingInteraction: 'approval' }])
  assert.equal(detectAlerts(seeded, approval, 1, off).alerts.length, 0)
  const question = listState([{ id: 's1', displayTitle: 'x', running: true, pendingInteraction: 'question' }])
  assert.equal(detectAlerts(seeded, question, 1, off).alerts.length, 1)
})

test('running 由 true 变 false 报本轮完成', () => {
  const seeded = detectAlerts({}, listState([{ id: 's1', displayTitle: 'x', running: true }]), 1000, settings).tracked
  const { alerts } = detectAlerts(seeded, listState([{ id: 's1', displayTitle: 'x', running: false }]), 2000, settings)
  assert.deepEqual(plain(alerts), [{ kind: 'turn-complete', sessionId: 's1', title: 'x' }])
})

test('停下来但还在等你时算 ask，不算完成', () => {
  const seeded = detectAlerts({}, listState([{ id: 's1', displayTitle: 'x', running: true }]), 1000, settings).tracked
  const { alerts } = detectAlerts(
    seeded,
    listState([{ id: 's1', displayTitle: 'x', running: false, pendingInteraction: 'approval' }]),
    2000,
    settings,
  )
  assert.deepEqual(plain(alerts.map(a => a.kind)), ['ask'])
})

test('minTurnMs 过滤掉太短的一轮', () => {
  const slow = { ...settings, minTurnMs: 5000 }
  const seeded = detectAlerts({}, listState([{ id: 's1', displayTitle: 'x', running: true }]), 1000, slow).tracked
  assert.equal(detectAlerts(seeded, listState([{ id: 's1', displayTitle: 'x', running: false }]), 3000, slow).alerts.length, 0)
  assert.equal(detectAlerts(seeded, listState([{ id: 's1', displayTitle: 'x', running: false }]), 9000, slow).alerts.length, 1)
})

test('subagent 行默认不通知，打开开关后通知', () => {
  const rows = (pending) => listState([{ id: 's1', displayTitle: 'x', running: true, origin: 'subagent', ...pending }])
  const seeded = detectAlerts({}, rows({}), 0, settings).tracked
  assert.equal(detectAlerts(seeded, rows({ pendingInteraction: 'approval' }), 1, settings).alerts.length, 0)
  const on = { ...settings, includeSubagents: true }
  assert.equal(detectAlerts(seeded, rows({ pendingInteraction: 'approval' }), 1, on).alerts.length, 1)
})

test('审批正文优先用 callView.title（终端卡片的标题就是命令）', () => {
  const call = { callId: 'c1', name: 'Bash', argsRaw: '{"command":"rm -rf /tmp/x"}', callView: { card: 'terminal', title: 'rm -rf /tmp/x' } }
  assert.equal(approvalBody({ toolName: 'Bash', callId: 'c1' }, call, 180), 'Bash · rm -rf /tmp/x')
})

test('没有 callView 时退回解析 argsRaw', () => {
  const call = { callId: 'c1', name: 'Write', argsRaw: '{"file_path":"/a/b.ts","content":"..."}', callView: null }
  assert.equal(approvalBody({ toolName: 'Write', callId: 'c1' }, call, 180), 'Write · /a/b.ts')
})

test('拿不到配对调用时退回 reason，再退回工具名', () => {
  assert.equal(approvalBody({ toolName: 'Bash', reason: '要删除仓库外的文件' }, undefined, 180), '要删除仓库外的文件')
  assert.equal(approvalBody({ toolName: 'Bash' }, undefined, 180), 'Bash 请求授权')
})

test('正文折成一行并截断', () => {
  assert.equal(oneLine('a\n  b\tc', 180), 'a b c')
  assert.equal(oneLine('x'.repeat(50), 10), 'x'.repeat(9) + '…')
  assert.equal(oneLine('   ', 10), undefined)
})

test('argsRaw 不是合法 JSON 时不猜', () => {
  assert.equal(argsSummary('{"command":"echo'), undefined)
  assert.equal(argsSummary(''), undefined)
})

test('findCall 递归找子调用', () => {
  const calls = [{ callId: 'a', subCalls: [{ callId: 'b', subCalls: [] }] }]
  assert.equal(findCall(calls, 'b').callId, 'b')
  assert.equal(findCall(calls, 'zz'), undefined)
})

test('提问正文用第一个问题，多问时标出总数', () => {
  assert.equal(questionBody({ questions: [{ header: '方案', question: '用哪个库？' }] }, 180), '用哪个库？')
  assert.equal(
    questionBody({ questions: [{ question: '用哪个库？' }, { question: '要不要测试？' }] }, 180),
    '用哪个库？（共 2 问）',
  )
  assert.equal(questionBody({}, 180), '智能体在等待你的回答')
})
