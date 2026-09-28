import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createTranslator } from '../src/i18n.ts'
import { createPalette, markdownTheme } from '../src/theme.ts'
import {
  PendingInputPanel,
  mergePendingInput,
  recallablePendingInput,
  retainedPendingInputContent,
  shouldProjectImmediateUserInput,
  shouldProjectPendingInput,
} from '../src/components/pending-input.ts'

const palette = createPalette(false, 'dark', true)
const mdTheme = markdownTheme(palette)
const t = createTranslator('zh-CN')

describe('composer steer projection', () => {
  it('projects only messages added while the agent is already running', () => {
    assert.equal(shouldProjectPendingInput('idle'), false)
    assert.equal(shouldProjectPendingInput('running'), true)
    assert.equal(shouldProjectImmediateUserInput('idle'), true)
    assert.equal(shouldProjectImmediateUserInput('running'), false)
  })

  it('shows submitted user content until its durable message is rendered', () => {
    const panel = new PendingInputPanel(palette, mdTheme, t)
    const message = createUserMessage({
      content: [{ type: 'text', text: '补充这个约束' }],
      source: { kind: 'user' },
    })

    assert.equal(panel.insert(message), true)
    assert.equal(panel.count, 1)
    assert.match(panel.render(48).join('\n'), /Steering: 补充这个约束/)
    assert.match(panel.render(48).join('\n'), /Alt\+Up 编辑队列/)
    assert.equal(panel.render(48).at(0), ' '.repeat(48))
    assert.equal(panel.render(48).at(-1), ' '.repeat(48))
    assert.ok(panel.render(48).every(row => visibleWidth(row) === 48))

    assert.equal(panel.remove(message.id), true)
    assert.equal(panel.count, 0)
    assert.deepEqual(panel.render(48), [])
  })

  it('merges all queued text with the current editor draft', () => {
    const first = createUserMessage({
      content: [{ type: 'text', text: '第一条约束' }],
      source: { kind: 'user' },
    })
    const second = createUserMessage({
      content: [{ type: 'text', text: '第二条约束' }],
      source: { kind: 'user' },
    })
    assert.equal(mergePendingInput([first, second], '当前草稿'), '第一条约束\n第二条约束\n当前草稿')
  })

  it('recalls text from every steer while preserving image attachments', () => {
    const textOnly = createUserMessage({
      content: [{ type: 'text', text: '可编辑文本' }],
      source: { kind: 'user' },
    })
    const withImage = createUserMessage({
      content: [
        { type: 'text', text: '图片说明' },
        { type: 'image', attachment: {} as never },
      ],
      source: { kind: 'user' },
    })

    const recalled = recallablePendingInput([textOnly, withImage])
    assert.deepEqual(recalled.map(message => message.id), [textOnly.id, withImage.id])
    assert.equal(mergePendingInput(recalled), '可编辑文本\n图片说明')
    assert.deepEqual(retainedPendingInputContent(textOnly), [])
    assert.deepEqual(retainedPendingInputContent(withImage), [{ type: 'image', attachment: {} }])
  })

  it('renders every queued steer in insertion order', () => {
    const panel = new PendingInputPanel(palette, mdTheme, t)
    panel.insert(createUserMessage({
      content: [{ type: 'text', text: '第一条约束' }],
      source: { kind: 'user' },
    }))
    panel.insert(createUserMessage({
      content: [{ type: 'text', text: '第二条约束' }],
      source: { kind: 'user' },
    }))

    assert.match(panel.render(48).join('\n'), /第一条约束[\s\S]*第二条约束/)
    assert.equal(panel.render(48).at(0), ' '.repeat(48))
    assert.equal(panel.render(48).at(-1), ' '.repeat(48))
  })

  it('bounds rendering to the newest messages and reports omitted steers', () => {
    const panel = new PendingInputPanel(palette, mdTheme, t)
    for (let index = 0; index < 10; index++) {
      panel.insert(createUserMessage({
        content: [{ type: 'text', text: `消息-${index}` }],
        source: { kind: 'user' },
      }))
    }

    const rendered = panel.render(48).join('\n')
    assert.match(rendered, /省略较早的 8 条/)
    assert.doesNotMatch(rendered, /消息-0/)
    assert.match(rendered, /消息-8[\s\S]*消息-9/)
  })

  it('projects only direct user messages when synchronizing an inbox', () => {
    const panel = new PendingInputPanel(palette, mdTheme, t)
    const direct = createUserMessage({
      content: [{ type: 'text', text: '直接输入' }],
      source: { kind: 'user' },
    })
    const plugin = createUserMessage({
      content: [{ type: 'text', text: '插件上下文' }],
      source: { kind: 'system-prompt' },
    })

    panel.sync([plugin, direct])

    const rendered = panel.render(48).join('\n')
    assert.equal(panel.count, 1)
    assert.match(rendered, /直接输入/)
    assert.doesNotMatch(rendered, /插件上下文/)

    panel.sync([])
    assert.equal(panel.count, 0)
    assert.deepEqual(panel.render(48), [])
  })

  it('bounds long pending input so the editor remains visible', () => {
    const panel = new PendingInputPanel(palette, mdTheme, t)
    panel.insert(createUserMessage({
      content: [{ type: 'text', text: '很长的待处理输入。'.repeat(100) }],
      source: { kind: 'user' },
    }))

    const rows = panel.render(24)
    assert.match(rows.join('\n'), /…/)
    assert.equal(rows.at(0), ' '.repeat(24))
    assert.equal(rows.at(-1), ' '.repeat(24))
  })
})
