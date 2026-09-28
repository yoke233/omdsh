import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { visibleWidth } from '@earendil-works/pi-tui'
import { buildContextUsageSnapshot, ContextUsageScreen } from '../src/components/context-usage-screen.ts'
import { createTranslator } from '../src/i18n.ts'
import { createPalette } from '../src/theme.ts'

const palette = createPalette(false, 'dark', true)
const t = createTranslator('en')
const event = (seq: number, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}): SessionEvent => ({
  seq, type, data, time: seq, ...extra,
} as unknown as SessionEvent)

describe('context usage snapshot', () => {
  it('categorizes active message nodes and reconciles them to measured pressure', () => {
    const events = [
      event(0, 'request/header', { header: { system: 'system rules', tools: [{ name: 'edit', description: 'Edit a file' }] }, reason: 'initial' }),
      event(1, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, { surfaceOp: 'append' }),
      event(2, 'assistant/message', { message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }, { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{}' }] } }, { surfaceOp: 'append' }),
      event(3, 'tool/call', { callId: 'c1', name: 'edit', arguments: '{}' }),
      event(4, 'tool/result', { message: { id: 'm1', role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }, { surfaceOp: 'append' }),
    ]
    const snapshot = buildContextUsageSnapshot(events, [{ seq: 1, tokens: 100 }, { seq: 2, tokens: 300 }, { seq: 4, tokens: 200 }], 1_000, 8_000, 'deepseek-chat')
    assert.equal(snapshot.categories.reduce((sum, category) => sum + category.tokens, 0), 1_000)
    assert.ok(snapshot.categories.find(category => category.id === 'system-prompt')!.tokens > 0)
    assert.ok(snapshot.categories.find(category => category.id === 'custom-tools')!.tokens > 0)
    assert.ok(snapshot.categories.find(category => category.id === 'agent-thinking')!.tokens > 0)
    assert.equal(snapshot.categories.find(category => category.id === 'tool-output')!.children?.[0]?.label, 'edit')
  })
})

describe('ContextUsageScreen', () => {
  const snapshot = buildContextUsageSnapshot([], [], 2_000, 20_000, 'deepseek-chat')

  it('renders as a full-height root screen with map, categories, and footer controls', () => {
    const screen = new ContextUsageScreen(snapshot, palette, t, 32)
    const rows = screen.render(100)
    const text = rows.join('\n')
    assert.equal(rows.length, 32)
    assert.match(text, /Context Usage/)
    assert.match(text, /deepseek-chat/)
    assert.match(text, /Category:/)
    assert.match(text, /Map:/)
    assert.match(text, /Esc Close/)
    assert.ok(rows.every(row => visibleWidth(row) <= 98))
  })

  it('supports navigation, preview, zoom, and Escape close', () => {
    const screen = new ContextUsageScreen(snapshot, palette, t, 40)
    const before = screen.render(100).join('\n')
    screen.handleInput('j')
    screen.handleInput('\r')
    screen.handleInput('z')
    const after = screen.render(100).join('\n')
    assert.notEqual(after, before)
    assert.match(after, /System Tools is estimated/)
    let closed = false
    screen.onClose = () => { closed = true }
    screen.handleInput('\x1b')
    assert.equal(closed, true)
  })
})
