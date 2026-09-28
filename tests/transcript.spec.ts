import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { CombinedAutocompleteProvider, Container, visibleWidth } from '@earendil-works/pi-tui'
import { PromptEditor } from '../src/components/prompt-editor.ts'
import { createPalette, markdownTheme } from '../src/theme.ts'
import { createTranslator } from '../src/i18n.ts'
import {
  AssistantStreamController,
  BackgroundJobViewComponent,
  ContextCardComponent,
  applyCardVisibility,
  registerVisibilityCard,
  ErrorMessageComponent,
  HeaderComponent,
  StaticCardComponent,
  SubagentPanelComponent,
  TodoPanelComponent,
  ToolCardComponent,
  nextToolCardVisibility,
  recentTranscriptStart,
  TranscriptViewport,
  ThinkingBlock,
  UserMessageComponent,
} from '../src/components/transcript.ts'
import {
  CommandHintComponent,
  ComposerFooterComponent,
  InputBorderComponent,
  StatusLineComponent,
  WorkingIndicatorComponent,
  chooseReasoningEffort,
  formatContextTokens,
  resolveSessionModelSelection,
} from '../src/components/status.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const palette = createPalette(false, 'dark', true)
const mdTheme = markdownTheme(palette)
const t = createTranslator('zh-CN')

/** Collect a component's rows by rendering it inside a container. */
function render(component: { render(width: number): string[] }, width: number): string[] {
  const container = new Container()
  container.addChild(component as never)
  return container.render(width)
}

describe('transcript components respect the render width', () => {
  const widths = [5, 10, 40, 80, 120]
  const longText = '中文字符串很长很长很长很长很长很长很长很长很长很长很长很长，'.repeat(4) + 'plain english padding padding padding padding padding padding padding padding'

  it('renders user messages as unlabelled full-width surfaces', () => {
    for (const width of widths) {
      const rows = render(new UserMessageComponent(longText, palette, mdTheme), width)
      for (const row of rows) assert.equal(visibleWidth(row), width, `width=${width}`)
      assert.ok(rows.every(row => !/[╭╮╰╯]/.test(row)))
      assert.ok(rows.every(row => !row.includes('User')))
    }
  })

  it('renders turn failures as borderless full-width surfaces', () => {
    const rows = render(new ErrorMessageComponent(['回合失败（AI_ERROR）：overloaded'], palette), 64)
    assert.ok(rows.some(row => row.includes('回合失败')))
    assert.ok(rows.every(row => visibleWidth(row) === 64))
    assert.ok(rows.every(row => !/[╭╮╰╯│]/.test(row)))
  })

  it('pads user messages horizontally and vertically', () => {
    const rows = render(new UserMessageComponent('hello', palette, mdTheme), 20)
    assert.equal(rows.length, 3)
    assert.ok(rows[1]?.includes('  hello'))
    for (const row of rows) assert.equal(visibleWidth(row), 20)
  })

  it('tool cards stay within width in every status', () => {
    for (const width of widths) {
      const pending = new ToolCardComponent('bash', JSON.stringify({ command: longText }), 6, palette)
      const rows = render(pending, width)
      for (const row of rows) assert.ok(visibleWidth(row) <= width, `pending width=${width}`)
    }
    const settled = new ToolCardComponent('read', '{}', 6, palette)
    settled.updateResult({
      turn: 1,
      step: 1,
      message: {
        id: 'm1' as never,
        role: 'tool',
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: longText }],
        source: { kind: 'tool', callId: 'c1' as never },
      },
    } as never)
    for (const width of widths) {
      const rows = render(settled, width)
      for (const row of rows) assert.ok(visibleWidth(row) <= width, `settled width=${width}`)
    }
  })

  it('keeps pending and completed cards compact until explicitly expanded', () => {
    const pending = new ToolCardComponent('read', '{"i":"Reading entrypoint","path":"src/index.ts"}', 6, palette)
    assert.deepEqual(render(pending, 48), ['', ' Read · src/index.ts · (Ctrl+O to expand)'])

    const repl = new ToolCardComponent('repl', JSON.stringify({
      code: 'const result = await tools.read({ path: "src/index.ts" })',
    }), 6, palette)
    const pendingReplRows = render(repl, 32)
    assert.equal(pendingReplRows.length, 2)
    repl.setVisibility('expanded')
    const expandedReplRows = render(repl, 32)
    assert.ok(expandedReplRows.slice(2).every(row => visibleWidth(row) <= 30))
    pending.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'line one\nline two' }],
        isError: false,
      },
    } as never)
    const collapsed = render(pending, 48)
    assert.equal(collapsed.length, 2)
    assert.match(collapsed[1]!, /✓ Read .*src\/index\.ts.*Ctrl\+O to expand/)
    pending.setVisibility('expanded')
    const settled = render(pending, 48)
    assert.match(settled[1]!, /^✓ Read .*Ctrl\+O to collapse/)
    assert.equal(settled[2], '')
    assert.match(settled[3]!, /^  line one/)
    assert.equal(settled.some(row => row.includes('› src/index.ts')), false)
    assert.ok(settled.every(row => !/[╭╮╰╯├┤│]/.test(row)))
  })

  it('uses accessible, color-coded glyphs for every tool lifecycle state', () => {
    const themed = createPalette(true, 'dark', true)
    const pending = new ToolCardComponent('read', '{"path":"src/index.ts"}', 6, themed)
    assert.ok(render(pending, 64).some(row => row.includes(themed.warning(''))))

    const completed = new ToolCardComponent('read', '{}', 6, themed)
    completed.updateDispatch([{ type: 'text', text: 'done' }], false)
    assert.ok(render(completed, 64).some(row => row.includes(themed.success('✓'))))

    const failed = new ToolCardComponent('read', '{}', 6, themed)
    failed.updateDispatch([{ type: 'text', text: 'failed' }], true)
    assert.ok(render(failed, 64).some(row => row.includes(themed.error(''))))

    const interrupted = new ToolCardComponent('read', '{}', 6, themed)
    interrupted.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'aborted' }],
        isError: true,
      },
      error: { name: 'HarnessError', code: 'ABORTED' },
    } as never)
    assert.ok(render(interrupted, 64).some(row => row.includes(themed.warning('■'))))
  })

  it('keeps collapsed large diff and output rendering bounded, then expands exact content', () => {
    const lineCount = 30_000
    const patchLines = Array.from({ length: lineCount }, (_, index) => `+const value${index} = ${index}`)
    const outputLines = Array.from({ length: lineCount }, (_, index) => `output ${index}`)
    const card = new ToolCardComponent('apply_patch', JSON.stringify({
      patch: ['*** Begin Patch', '*** Update File: src/large.ts', '@@', ...patchLines, '*** End Patch'].join('\n'),
    }), 6, palette)
    card.updateDispatch([{ type: 'text', text: outputLines.join('\n') }], false)

    const collapsedStart = performance.now()
    const collapsed = render(card, 100)
    const collapsedMs = performance.now() - collapsedStart
    assert.equal(collapsed.length, 2)
    assert.equal(collapsed.some(row => row.includes('value29999') || row.includes('output 29999')), false)

    card.setVisibility('expanded')
    const expandedStart = performance.now()
    const expanded = render(card, 100)
    const expandedMs = performance.now() - expandedStart
    assert.ok(expanded.some(row => row.includes('const value0 = 0')))
    assert.ok(expanded.some(row => row.includes('const value29999 = 29999')))
    assert.ok(expanded.some(row => row.includes('output 0')))
    assert.ok(expanded.some(row => row.includes('output 29999')))
    assert.ok(
      collapsedMs * 8 < expandedMs,
      `collapsed ${collapsedMs.toFixed(1)}ms should be at least 8x cheaper than expanded ${expandedMs.toFixed(1)}ms`,
    )
  })

  it('reads only a bounded prefix of structured diff metadata while collapsed', () => {
    const diffs = new Proxy(Array.from({ length: 100 }, (_, index) => ({
      path: `src/${index}.ts`,
      oldText: 'before',
      newText: 'after',
    })), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) >= 3) {
          throw new Error(`collapsed render eagerly read diff ${property}`)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const card = new ToolCardComponent('edit', '{}', 6, palette, {
      card: 'diff',
      title: 'Large edit',
      diffs,
    })
    card.updateDispatch([{ type: 'text', text: 'done' }], false)

    const collapsed = render(card, 100).join('\n')
    assert.ok(collapsed.includes('src/0.ts, src/1.ts, src/2.ts, … +97 more'))
  })

  it('does not parse or expose a large code argument until expansion', () => {
    const finalMarker = 'const finalMarker = true'
    const code = `${'const repeated = 1\n'.repeat(1_000)}${finalMarker}`
    const argumentsJson = JSON.stringify({ code })
    const card = new ToolCardComponent('run_code', argumentsJson, 6, palette)
    card.updateDispatch([{ type: 'text', text: 'done' }], false)

    const collapsed = render(card, 80).join('\n')
    assert.ok(collapsed.includes(`${argumentsJson.length.toLocaleString('en-US')} chars input`))
    assert.equal(collapsed.includes(finalMarker), false)

    card.setVisibility('expanded')
    const expanded = render(card, 80).join('\n')
    assert.ok(expanded.includes(finalMarker))
  })

  it('toggles tool cards only between collapsed and expanded', () => {
    assert.equal(nextToolCardVisibility('collapsed'), 'expanded')
    assert.equal(nextToolCardVisibility('expanded'), 'collapsed')
  })
  it('shows the command or query in the compact tool summary', () => {
    const pwsh = new ToolCardComponent('pwsh', JSON.stringify({ command: 'Get-Process -Name node' }), 6, palette)
    assert.match(render(pwsh, 80)[1]!, / Pwsh · Get-Process -Name node/)
    const bash = new ToolCardComponent('bash', JSON.stringify({ description: 'list files', command: 'ls -la' }), 6, palette)
    assert.match(render(bash, 80)[1]!, / Bash · ls -la/)
    const search = new ToolCardComponent('web_search', JSON.stringify({ query: 'dsh performance' }), 6, palette)
    assert.match(render(search, 80)[1]!, / Web Search · dsh performance/)
  })

  it('does not repeat a short single-line argument below the expanded summary', () => {
    const card = new ToolCardComponent('grep', JSON.stringify({ pattern: "'TODO'|pattern: '|key: 'value'" }), 6, palette)
    card.updateDispatch([{ type: 'text', text: 'Found 1 match' }], false)
    card.setVisibility('expanded')

    const rows = render(card, 100)
    assert.equal(rows.filter(row => row.includes("'TODO'|pattern: '|key: 'value'")).length, 1)
    assert.ok(rows.some(row => row.includes('Found 1 match')))
  })

  it('falls back to Unknown for an empty tool name', () => {
    const empty = new ToolCardComponent('', '{}', 6, palette)
    assert.match(render(empty, 48)[1]!, / Unknown · \{\}/)
  })

  it('shows path or description for read/write/edit/run_code tools', () => {
    const read = new ToolCardComponent('read', JSON.stringify({ file_path: 'src/a.ts' }), 6, palette)
    assert.match(render(read, 48)[1]!, / Read · src\/a\.ts/)
    const write = new ToolCardComponent('write', JSON.stringify({ path: 'src/b.ts' }), 6, palette)
    assert.match(render(write, 48)[1]!, / Write · src\/b\.ts/)
    const edit = new ToolCardComponent('edit', JSON.stringify({ file_path: 'src/c.ts' }), 6, palette)
    assert.match(render(edit, 48)[1]!, / Edit · src\/c\.ts/)
    const code = new ToolCardComponent('run_code', JSON.stringify({ description: 'test snippet' }), 6, palette)
    assert.match(render(code, 48)[1]!, / Run Code · test snippet/)
  })

  it('wraps long commands in the input section instead of truncating', () => {
    const longCommand = `echo ${'a'.repeat(60)}`
    const card = new ToolCardComponent('pwsh', JSON.stringify({ command: longCommand }), 6, palette)
    card.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      },
    } as never)
    card.setVisibility('expanded')
    const rows = render(card, 40)
    for (const row of rows) assert.ok(visibleWidth(row) <= 40, `width=${visibleWidth(row)} row=${JSON.stringify(row)}`)
    const inputRows = rows.filter(row => row.includes('aaa'))
    assert.ok(inputRows.length >= 2, `expected wrapped input rows, got ${JSON.stringify(rows)}`)
    assert.ok(inputRows.some(row => /^  › echo a+/.test(row)))
    assert.ok(inputRows.some(row => /^    a+/.test(row)))
  })

  it('shows str_replace_editor edit content in the input section', () => {
    const card = new ToolCardComponent('str_replace_editor', JSON.stringify({
      command: 'str_replace',
      path: 'D:/src/a.ts',
      old_str: 'old line',
      new_str: 'new line',
    }), 6, palette)
    assert.equal(render(card, 60).length, 2)
    card.setVisibility('expanded')
    const rows = render(card, 60)
    assert.match(rows[1]!, /^ Str Replace Editor .*Ctrl\+O to collapse/)
    assert.ok(rows.includes('  path: D:/src/a.ts'))
    assert.ok(rows.includes('  old_str:'))
    assert.ok(rows.includes('  old line'))
    assert.ok(rows.includes('  new_str:'))
    assert.ok(rows.includes('  new line'))
  })

  it('renders str_replace_editor edits as a diff section', () => {
    const card = new ToolCardComponent('str_replace_editor', JSON.stringify({
      command: 'str_replace',
      path: 'D:/src/a.ts',
      old_str: 'old line',
      new_str: 'new line',
    }), 6, palette)
    card.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      },
    } as never)
    card.setVisibility('expanded')
    const rows = render(card, 60)
    assert.match(rows[1]!, /^✓ Str Replace Editor /)
    assert.match(rows[2]!, /^  › path: D:\/src\/a\.ts/)
    assert.equal(rows[3], '')
    assert.match(rows[4]!, /^  - old line/)
    assert.match(rows[5]!, /^  \+ new line/)
    assert.equal(rows[6], '')
    assert.match(rows[7]!, /^  done/)
  })

  it('renders raw apply_patch arguments as a themed file-grouped patch', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      ' const keep = true',
      '-const value = 1',
      '+const value = 2',
      '*** Add File: src/b.ts',
      '+export const added = true',
      '*** End Patch',
    ].join('\n')
    const themedPalette = createPalette(true, 'dark', true)
    const card = new ToolCardComponent('apply_patch', JSON.stringify({ patch }), 8, themedPalette)
    const pending = render(card, 72).join('\n')
    assert.match(pending, /Apply Patch/)
    assert.ok(pending.includes('2 files (+2 -1)'))
    assert.equal(pending.includes('*** Begin Patch'), false)

    card.updateDispatch([{ type: 'text', text: 'Applied patch to 2 files.' }], false)
    card.setVisibility('expanded')
    const rows = render(card, 72)
    const output = rows.join('\n')
    assert.ok(rows.some(row => row.includes('Patch')))
    assert.ok(rows.some(row => row.includes('Update src/a.ts')))
    assert.ok(rows.some(row => row.includes('Add src/b.ts')))
    assert.ok(rows.some(row => row.includes(themedPalette.error('- const value = 1'))))
    assert.ok(rows.some(row => row.includes(themedPalette.success('+ const value = 2'))))
    assert.ok(rows.some(row => row.includes(themedPalette.success('+ export const added = true'))))
    assert.equal(output.includes('*** Begin Patch'), false)
    assert.equal(output.includes('*** Update File'), false)
  })

  it('keeps the REPL tree height stable when running calls complete', () => {
    const root = new ToolCardComponent('repl', JSON.stringify({
      code: 'await tools.read({ path: "src/a.ts" })',
    }), 8, palette)
    const child = new ToolCardComponent('read', '{"path":"src/a.ts"}', 8, palette)
    root.addSubCall(child)

    const runningRows = render(root, 72)
    assert.ok(runningRows.some(row => /Repl/.test(row)))
    assert.ok(runningRows.some(row => /Read/.test(row)))

    root.updateDispatch([{ type: 'text', text: 'done' }], false)
    child.updateDispatch([{ type: 'text', text: 'file contents' }], false)
    const completedRows = render(root, 72)
    assert.equal(completedRows.length, runningRows.length)
  })

  it('keeps a successful REPL wrapper above its dispatched child', () => {
    const root = new ToolCardComponent('repl', JSON.stringify({
      code: 'await tools.apply_patch({ patch })',
    }), 8, palette)
    const child = new ToolCardComponent(
      'apply_patch',
      JSON.stringify({ patch: '*** Begin Patch\n...\n*** End Patch' }),
      8,
      palette,
      {
        card: 'diff',
        title: 'Apply patch',
        diffs: [{ path: 'src/a.ts', oldText: 'const oldValue = 1', newText: 'const newValue = 2' }],
        locations: [{ path: 'src/a.ts' }],
      },
    )
    root.addSubCall(child)
    child.updateDispatch([{ type: 'text', text: 'Applied patch to 1 file.' }], false, {
      card: 'diff',
      title: 'Apply patch',
      diffs: [{ path: 'src/a.ts', oldText: 'const oldValue = 1', newText: 'const newValue = 2' }],
    })
    root.updateDispatch([{ type: 'text', text: 'Applied patch to 1 file.' }], false)
    root.setVisibility('expanded')

    const rows = render(root, 72)
    assert.ok(rows.some(row => /✓ Repl/.test(row)))
    assert.ok(rows.some(row => /✓ Apply patch/.test(row)))
    assert.ok(rows.some(row => /src\/a\.ts/.test(row)))
    assert.ok(rows.some(row => /- const oldValue = 1/.test(row)))
    assert.ok(rows.some(row => /\+ const newValue = 2/.test(row)))
    assert.equal(rows.some(row => row.includes('*** Begin Patch')), false)
  })

  it('keeps a failed REPL wrapper above its dispatched child', () => {
    const root = new ToolCardComponent('repl', '{"code":"await tools.read(...)"}', 8, palette)
    const child = new ToolCardComponent('read', '{"file_path":"src/a.ts"}', 8, palette)
    root.addSubCall(child)
    child.updateDispatch([{ type: 'text', text: 'file contents' }], false)
    root.updateDispatch([{ type: 'text', text: 'dispatch failed' }], true)
    root.setVisibility('expanded')

    const rows = render(root, 72)
    assert.ok(rows.some(row => /Repl/.test(row)))
    assert.ok(rows.some(row => /Read/.test(row)))
    assert.ok(rows.some(row => /dispatch failed/.test(row)))
  })

  it('keeps a nested edit call distinct while reusing the standard diff view', () => {
    const root = new ToolCardComponent('repl', '{"code":"await tools.edit(...)"}', 8, palette)
    const edit = new ToolCardComponent('edit', '{"file_path":"src/a.ts"}', 8, palette, {
      card: 'diff',
      title: 'Edit src/a.ts',
      diffs: [{ path: 'src/a.ts', oldText: 'before', newText: 'after' }],
      locations: [{ path: 'src/a.ts' }],
    })
    root.addSubCall(edit)
    edit.updateDispatch([{ type: 'text', text: 'Edited src/a.ts.' }], false)
    root.updateDispatch([{ type: 'text', text: 'Edited src/a.ts.' }], false)
    root.setVisibility('expanded')

    const rows = render(root, 72)
    assert.ok(rows.some(row => /✓ Edit/.test(row)))
    assert.ok(rows.some(row => /- before/.test(row)))
    assert.ok(rows.some(row => /\+ after/.test(row)))
    assert.equal(rows.some(row => /✓ Apply patch/.test(row)), false)
  })

  it('sanitizes tabs and controls in str_replace_editor call arguments', () => {
    const card = new ToolCardComponent('str_replace_editor', JSON.stringify({
      command: 'str_replace',
      path: 'D:/src/a.ts',
      old_str: 'line1\r\n\tindented old',
      new_str: 'line1\r\n\tindented new',
    }), 6, palette)
    const pending = render(card, 60)
    assert.ok(pending.every(row => !row.includes('\t') && !row.includes('\r') && !row.includes('\x1b')))

    card.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      },
    } as never)
    card.setVisibility('expanded')
    const settled = render(card, 60)
    assert.ok(settled.every(row => !row.includes('\t') && !row.includes('\r') && !row.includes('\x1b')))
    assert.ok(settled.some(row => row.includes('indented old')))
    assert.ok(settled.some(row => row.includes('indented new')))
  })

  it('strips carriage returns from multiline tool output', () => {
    const powershell = new ToolCardComponent('powershell', '{}', 6, palette)
    powershell.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{ type: 'text', text: 'first\r\nsecond\rthird' }],
        isError: false,
      },
    } as never)
    powershell.setVisibility('expanded')
    const rows = render(powershell, 48)
    assert.ok(rows.every(row => !row.includes('\r')))
    assert.ok(rows.some(row => row.includes('first')))
    assert.ok(rows.some(row => row.includes('second')))
    assert.ok(rows.some(row => row.includes('third')))
  })

  it('neutralizes terminal controls and tabs from tool output', () => {
    const unsafe = new ToolCardComponent('grep', '{"path":"lib"}', 10, palette)
    unsafe.updateResult({
      message: {
        toolCallId: 'c1' as never,
        content: [{
          type: 'text',
          text: 'Line 1839:\tbefore\x1b[48;5;240m highlighted \x1b[0mafter\nmove\x1b[2J\x1b[Hhome\nmarker\x1b_pi:c\x07cursor\ncharset\x1b(0A\nutf8-csi\u009b31mred\u009b0m',
        }],
        isError: false,
      },
    } as never)
    unsafe.setVisibility('expanded')

    const output = render(unsafe, 64).join('\n')
    assert.equal(output.includes('\x1b'), false)
    assert.equal(output.includes('\t'), false)
    assert.equal(output.includes('\u009b'), false)
    assert.ok(output.includes('highlighted'))
    assert.ok(output.includes('home'))
    assert.ok(output.includes('cursor'))
    assert.ok(output.includes('charsetA'))
    assert.ok(output.includes('utf8-csired'))
  })

  it('frames injected context separately from unframed model reasoning', () => {
    const context = render(new ContextCardComponent(
      '@deepseek-ai/dsh-system-prompt',
      'Current runtime context.\n\nApproval policy: ask.',
      6,
      palette,
    ), 64)
    assert.match(context[0]!, /^╭─── Injected context · @deepseek-ai\/dsh-system-prompt/)
    assert.match(context.at(-1)!, /^╰─+╯$/)
    assert.ok(context.every(row => visibleWidth(row) === 64))

    const reasoning = render(new ThinkingBlock('private model reasoning', palette, mdTheme), 64)
    assert.ok(reasoning.some(row => row.includes('private model reasoning')))
    assert.ok(reasoning.every(row => !/[╭╮╰╯│]/.test(row)))
  })

  it('registers injected context for the global Ctrl+O visibility toggle', () => {
    const cards = new Set<{ setVisibility(visibility: 'collapsed' | 'expanded'): void }>()
    const context = registerVisibilityCard(cards, new ContextCardComponent(
      '@deepseek-ai/dsh-system-prompt',
      Array.from({ length: 12 }, (_, index) => `context line ${index + 1}`).join('\n'),
      3,
      palette,
    ), 'collapsed')
    assert.match(render(context, 80).join('\n'), /Ctrl\+O to expand/)

    applyCardVisibility(cards, 'expanded')

    assert.match(render(context, 80).join('\n'), /context line 12/)
    assert.doesNotMatch(render(context, 80).join('\n'), /Ctrl\+O to expand/)
  })
  it('subagent panel opens a tree-like list from a compact down-arrow hint', () => {
    const panel = new SubagentPanelComponent(palette)
    assert.deepEqual(render(panel, 40), [])
    panel.add({ id: 'a', provider: 'in-process', label: 'child-a', mode: 'one-shot', status: 'running' })
    panel.add({ id: 'b', provider: 'in-process', label: 'child-b', mode: 'continuable', status: 'idle' })
    panel.setJobs([{ id: 'pwsh-1', label: 'Run checks', status: 'running' }])
    assert.deepEqual(render(panel, 100), ['  agents ● 1 running ○ 1 idle · jobs ● 1 running ◐ 0 stopping ✓ 0 settled · ↓ select'])
    assert.equal(panel.hasEntries(), true)
    panel.setExpanded(true)
    const rows = render(panel, 80)
    assert.ok(rows.some(row => row.includes('Background tasks')))
    assert.ok(rows.some(row => row.includes('Subagents')))
    assert.ok(rows.some(row => row.includes('↑↓ select · Enter open · Esc/← Main')))
    assert.ok(rows.some(row => row.includes('├─ child-a · one-shot · running')))
    assert.ok(rows.some(row => row.includes('└─ child-b · continuable · idle')))
    assert.ok(rows.some(row => row.includes('Jobs')))
    assert.ok(rows.some(row => row.includes('└─ pwsh-1 · running · Run checks')))
    assert.equal(panel.selected()?.kind, 'subagent')
    assert.equal(panel.isFirstSelected(), true)
    panel.moveSelection(1)
    assert.equal(panel.isFirstSelected(), false)
    assert.equal(panel.selected()?.kind, 'subagent')
    assert.ok(render(panel, 80).some(row => row.includes('└─ child-b') && visibleWidth(row) === 80))
    panel.moveSelection(1)
    assert.equal(panel.selected()?.kind, 'job')
    assert.ok(render(panel, 80).some(row => row.includes('└─ pwsh-1') && visibleWidth(row) === 80))
    panel.setExpanded(false)
    panel.setViewing({ kind: 'subagent', label: 'child-b' })
    assert.ok(render(panel, 80).some(row => row.includes('SUBAGENT · child-b · Esc/← Main · ↓ Switch')))
    panel.setExpanded(true)
    assert.ok(render(panel, 80).some(row => row.includes('SUBAGENT · child-b')))
    panel.setViewing(undefined)
    for (const row of rows) assert.ok(visibleWidth(row) <= 80)
    panel.setExpanded(false)
    assert.equal(panel.isExpanded(), false)
    panel.clear()
    assert.deepEqual(render(panel, 40), [])
  })

  it('renders a whole-view job projection without consuming job output', () => {
    const view = new BackgroundJobViewComponent(palette)
    view.set({ id: 'bash-1', kind: 'bash', label: 'pnpm run check', status: 'running', detail: 'still running' })

    const rows = render(view, 50)

    assert.ok(rows.some(row => row.includes('Background job')))
    assert.ok(rows.some(row => row.includes('pnpm run check')))
    assert.ok(rows.some(row => row.includes('bash-1 · bash · running')))
    assert.ok(rows.some(row => row.includes('reserved for the job reader')))
    assert.ok(rows.every(row => visibleWidth(row) <= 50))
  })

  it('renders working activity as a separate compact line', () => {
    const indicator = new WorkingIndicatorComponent()
    assert.deepEqual(indicator.render(20), [''])
    indicator.setText('working')
    assert.deepEqual(indicator.render(20), ['', '  working', ''])
    assert.equal(visibleWidth(indicator.render(4)[1] ?? ''), 4)
    indicator.setText(undefined)
    assert.deepEqual(indicator.render(20), [''])
  })

  it('static cards and todo panels stay within width', () => {
    for (const width of widths) {
      const card = new StaticCardComponent([longText, 'short'], palette)
      for (const row of render(card, width)) assert.ok(visibleWidth(row) <= width)
      const todo = new TodoPanelComponent(palette)
      todo.setTodos([
        { content: longText, status: 'in_progress' },
        { content: 'done', status: 'completed' },
      ])
      for (const row of render(todo, width)) assert.ok(visibleWidth(row) <= width)
    }
  })

  it('renders todo panels as compact progress rails', () => {
    const todo = new TodoPanelComponent(palette)
    todo.setTodos([
      { content: 'active task', status: 'in_progress' },
      { content: 'pending task', status: 'pending' },
      { content: 'done task', status: 'completed' },
    ])
    const rows = todo.render(80)
    assert.equal(rows.length, 5)
    assert.ok(rows[0]?.includes('Plan') && rows[0].includes('1/3'))
    assert.ok(rows.some(row => row.includes('│') && row.includes('active task')))
    assert.ok(rows.every(row => row.startsWith('  ')))
    assert.ok(rows.every(row => !row.startsWith('   ')))
  })

  it('the banner stays within width', () => {
    const agent = {
      options: { model: 'deepseek-v4-pro', provider: 'deepseek-official' },
      session: { id: 'session-1', header: { cwd: 'C:/work' } },
    } as unknown as Agent
    for (const width of widths) {
      const header = new HeaderComponent(agent, () => longText, palette, false, t)
      for (const row of render(header, width)) assert.ok(visibleWidth(row) <= width)
    }
  })

  it('shows the active session selection instead of Agent creation defaults', () => {
    const agent = {
      options: { model: 'deepseek-v4-flash', provider: 'deepseek-official' },
      session: { id: 'session-1', header: { cwd: 'C:/work' } },
    } as unknown as Agent
    const header = new HeaderComponent(agent, () => undefined, palette, false, t, () => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: ReasoningEffortId('max'),
    }))
    const output = render(header, 80).join('\n')
    assert.ok(output.includes('deepseek-v4-pro'))
    assert.ok(!output.includes('deepseek-v4-flash'))
  })
})

describe('transcript chronology', () => {
  it('keeps each user message before the assistant step started ahead of it', () => {
    const transcript = new Container()
    const assistant = new AssistantStreamController(transcript, palette, mdTheme)
    const addTurn = (user: string, model: string): void => {
      // DSH publishes step/start before it appends the entered user/message.
      assistant.start(false)
      transcript.addChild(new UserMessageComponent(user, palette, mdTheme))
      assistant.settle([{ type: 'text', text: model }])
      assistant.end()
    }

    addTurn('first user', 'first model')
    addTurn('second user', 'second model')

    const output = transcript.render(80).join('\n')
    const firstUser = output.indexOf('first user')
    const firstModel = output.indexOf('first model')
    const secondUser = output.indexOf('second user')
    const secondModel = output.indexOf('second model')
    assert.ok(firstUser >= 0)
    assert.ok(firstUser < firstModel)
    assert.ok(firstModel < secondUser)
    assert.ok(secondUser < secondModel)
  })

  it('separates assistant prose from the preceding transcript card', () => {
    const transcript = new Container()
    const assistant = new AssistantStreamController(transcript, palette, mdTheme)
    assistant.start(false)
    transcript.addChild(new ContextCardComponent(
      '@deepseek-ai/dsh-system-prompt',
      'Current runtime context.',
      6,
      palette,
    ))
    assistant.settle([{ type: 'text', text: 'model response' }])

    const rows = transcript.render(80)
    const modelRow = rows.findIndex(row => row.includes('model response'))
    assert.ok(modelRow > 0)
    assert.equal(rows[modelRow - 1], '')
  })

})

describe('resume transcript window', () => {
  it('keeps two thousand recent raw events instead of only two hundred', () => {
    assert.equal(recentTranscriptStart(24_548), 22_548)
    assert.equal(recentTranscriptStart(1_500), 0)
  })
})

describe('transcript viewport', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`)
  const staticComponent = (rows: string[]) => ({
    invalidate() {},
    render: () => rows,
  })

  it('follows the latest line by default', () => {
    const viewport = new TranscriptViewport(() => 6)
    viewport.addChild(staticComponent(lines) as never)
    const rows = render(viewport, 80)
    assert.deepEqual(rows, lines.slice(14, 20))
  })

  it('keeps a frozen top offset when not following the latest', () => {
    const viewport = new TranscriptViewport(() => 6)
    viewport.addChild(staticComponent(lines) as never)
    viewport.followLatest = false
    viewport.lineOffset = 3
    const rows = render(viewport, 80)
    assert.deepEqual(rows, lines.slice(3, 9))
  })

  it('clamps the offset and returns all lines when the transcript fits', () => {
    const viewport = new TranscriptViewport(() => 60)
    viewport.addChild(staticComponent(lines) as never)
    viewport.followLatest = false
    viewport.lineOffset = 10
    const rows = render(viewport, 80)
    assert.deepEqual(rows, lines)
  })
})

describe('composer chrome', () => {
  it('keeps mode and Git visible while collapsing an overlong directory', () => {
    const values: Record<string, string> = {
      mode: '标准  ',
      cwd: ' D:/Projects/a/very/long/workspace/path',
      'git/worktree': '  main',
    }
    const status = new StatusLineComponent(
      [{ type: 'value', name: 'mode' }, { type: 'value', name: 'cwd' }, { type: 'value', name: 'git/worktree' }],
      name => values[name],
      palette,
    )
    const [row] = status.render(32)
    assert.equal(visibleWidth(row!), 32)
    assert.ok(row!.includes('标准  '))
    assert.ok(row!.includes('…'))
    assert.ok(row!.includes(''))
    assert.ok(row!.includes(' main'))
    assert.ok(row!.endsWith(' '))
  })
  it('uses compact built-in segments before truncating a narrow sidebar', () => {
    const values: Record<string, string> = {
      mode: 'Anchored Standard (experimental)  ',
      cwd: ' D:/Projects/dsh',
      'git/worktree': '   main',
      'mode/compact': 'anchored-standard',
      'cwd/compact': ' dsh',
      'git/worktree/compact': ' main',
    }
    const status = new StatusLineComponent(
      [{ type: 'value', name: 'mode' }, { type: 'value', name: 'cwd' }, { type: 'value', name: 'git/worktree' }],
      name => values[name],
      palette,
    )
    const [row] = status.render(42)
    assert.equal(visibleWidth(row!), 42)
    assert.ok(row!.includes('anchore'))
    assert.ok(row!.includes('…'))
    assert.ok(!row!.includes('anchored-standard'))
    assert.ok(row!.includes(' dsh'))
    assert.ok(row!.includes(' main'))
    assert.ok(!row!.includes('Anchored Standard (experimental)'))

    const [narrowRow] = status.render(30)
    assert.equal(visibleWidth(narrowRow!), 30)
    assert.ok(narrowRow!.includes('main'))
    assert.ok(!narrowRow!.includes(' dsh'))
  })


  it('renders the footer as model · effort · used/limit below the rail', () => {
    const values: Record<string, string> = {
      model: 'deepseek-v4-flash',
      effort: ' · max',
      context: ' · ctx 100k/1m',
    }
    const footer = new ComposerFooterComponent(
      [{ type: 'value', name: 'model' }, { type: 'value', name: 'effort' }, { type: 'value', name: 'context' }],
      name => values[name],
      palette,
    )
    const [row] = footer.render(48)
    assert.equal(row, '  ◆ deepseek-v4-flash · max · ctx 100k/1m')
    assert.ok(visibleWidth(row!) <= 48)
  })
  it('renders permission state immediately after context usage', () => {
    const values: Record<string, string> = {
      model: 'deepseek-v4-flash',
      effort: ' · max',
      context: ' · ctx 0/1m',
      permission: ' · workspace-write',
      'model/compact': 'deepseek-v4-flash',
      'effort/compact': 'max',
      'context/compact': 'ctx 0/1m',
      'permission/compact': 'workspace-write',
    }
    const footer = new ComposerFooterComponent(
      [
        { type: 'value', name: 'model' },
        { type: 'value', name: 'effort' },
        { type: 'value', name: 'context' },
        { type: 'value', name: 'permission' },
      ],
      name => values[name],
      palette,
    )
    assert.equal(
      footer.render(64)[0],
      '  ◆ deepseek-v4-flash · max · ctx 0/1m · workspace-write',
    )
    assert.equal(
      footer.render(42)[0],
      '  ◆ d…h · max · ctx 0/1m · workspace-write',
    )
    assert.equal(
      footer.render(34)[0],
      '  ◆ max · 0/1m · workspace-write',
    )
    assert.equal(
      footer.render(30)[0],
      '  ◆ 0/1m · workspace-write',
    )
  })


  it('shows active jobs inline and drops them before configured footer content', () => {
    const values: Record<string, string> = {
      model: 'deepseek-v4-flash',
      effort: ' · max',
      context: ' · ctx 0/1m',
      permission: ' · workspace-write',
    }
    const footer = new ComposerFooterComponent(
      [
        { type: 'value', name: 'model' },
        { type: 'value', name: 'effort' },
        { type: 'value', name: 'context' },
        { type: 'value', name: 'permission' },
      ],
      name => values[name],
      palette,
      () => 'jobs 2',
    )
    assert.equal(
      footer.render(80)[0],
      '  ◆ deepseek-v4-flash · max · ctx 0/1m · workspace-write · jobs 2',
    )
    const narrow = footer.render(56)[0]!
    assert.equal(narrow, '  ◆ deepseek-v4-flash · max · ctx 0/1m · workspace-write')
    assert.ok(!narrow.includes('jobs'))
    assert.ok(visibleWidth(narrow) <= 56)

    const hidden = new ComposerFooterComponent([], () => undefined, palette, () => undefined)
    assert.deepEqual(hidden.render(40), ['  '])
  })

  it('uses Flash/max for a new session and the last request route for history', () => {
    const fallback = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    assert.deepEqual(resolveSessionModelSelection(undefined, fallback, 'max'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    })
    assert.deepEqual(resolveSessionModelSelection({
      config: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: ReasoningEffortId('xhigh'),
      },
    }, fallback, 'max'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'xhigh',
    })
    assert.deepEqual(resolveSessionModelSelection(undefined, {
      ...fallback,
      reasoningEffort: ReasoningEffortId('high'),
    }, 'max'), {
      ...fallback,
      reasoningEffort: 'high',
    })
  })

  it('selects or cycles only through efforts advertised by the active model', () => {
    const off = { id: ReasoningEffortId('off'), name: 'Off' }
    const high = { id: ReasoningEffortId('high'), name: 'High' }
    const max = { id: ReasoningEffortId('max'), name: 'Max' }
    const efforts = [off, high, max]

    assert.deepEqual(chooseReasoningEffort(efforts, max.id, ''), { kind: 'selected', effort: off })
    assert.deepEqual(chooseReasoningEffort(efforts, off.id, 'high'), { kind: 'selected', effort: high })
    assert.deepEqual(chooseReasoningEffort(efforts, high.id, 'high'), { kind: 'already', effort: high })
    assert.deepEqual(chooseReasoningEffort(efforts, high.id, 'extreme'), { kind: 'unknown', requested: 'extreme' })
    assert.deepEqual(chooseReasoningEffort([], high.id, ''), { kind: 'unsupported' })
  })

  it('formats context usage as compact used/limit values', () => {
    assert.equal(formatContextTokens(0), '0')
    assert.equal(formatContextTokens(100_000), '100k')
    assert.equal(formatContextTokens(1_000_000), '1m')
    assert.equal(formatContextTokens(1_200_000), '1.2m')
  })

  it('paints inset rails and the complete mode/path/Git prompt surface', () => {
    const enabled = createPalette(true, 'dark', true)
    const border = '\u001b[38;2;137;180;250m'
    const surface = '\u001b[48;2;17;17;27m'
    const tail = '\u001b[38;2;17;17;27m\u001b[39m'
    const [rail] = new InputBorderComponent(enabled).render(12)
    assert.equal(rail, ` ${border}${'─'.repeat(10)}\u001b[39m `)
    const [emptyTop] = new StatusLineComponent([], () => undefined, enabled).render(20)
    assert.ok(emptyTop!.includes(border))
    assert.equal(visibleWidth(emptyTop!), 20)

    const values: Record<string, string> = {
      mode: `${enabled.accent('标准')} ${enabled.statusSep('')} `,
      cwd: enabled.path(' D:/Projects/dsh'),
      'git/worktree': ` ${enabled.statusSep('')} ${enabled.git(' main')}`,
    }
    const [top] = new StatusLineComponent(
      [{ type: 'value', name: 'mode' }, { type: 'value', name: 'cwd' }, { type: 'value', name: 'git/worktree' }],
      name => values[name],
      enabled,
    ).render(72)
    assert.ok(top!.includes(`${tail}${surface} `))
    assert.ok(top!.includes(`${enabled.path(' D:/Projects/dsh')} `))
    assert.ok(top!.indexOf(tail) < top!.indexOf(surface))
    assert.equal(visibleWidth(top!), 72)
  })
  it('renders a faint expected-argument hint inside the composer', () => {
    const hint = new CommandHintComponent(() => '<standard|minimal|code|cordis|user preset>', palette)
    assert.deepEqual(hint.render(56), ['  <standard|minimal|code|cordis|user preset>'])
    const hidden = new CommandHintComponent(() => undefined, palette)
    assert.deepEqual(hidden.render(48), [])
  })

  it('returns annotated preset options immediately after a command space', async () => {
    const provider = new CombinedAutocompleteProvider([{
      name: 'mode',
      description: '切换模式',
      argumentHint: '<standard|minimal>',
      getArgumentCompletions: () => [
        { value: 'standard', label: 'standard — 标准', description: '完整 Agent 与工具链' },
        { value: 'minimal', label: 'minimal — 极简', description: 'bash + 编辑器双工具' },
      ],
    }], 'D:/work')
    const suggestions = await provider.getSuggestions(
      ['/mode '],
      0,
      '/mode '.length,
      { signal: new AbortController().signal },
    )
    assert.equal(suggestions?.prefix, '')
    assert.deepEqual(suggestions?.items.map(item => [item.value, item.description]), [
      ['standard', '完整 Agent 与工具链'],
      ['minimal', 'bash + 编辑器双工具'],
    ])
  })

  it('places the cursor at the end of recalled history', () => {
    const identity = (text: string): string => text
    const editor = new PromptEditor({
      terminal: { rows: 24 },
      requestRender: () => undefined,
    } as never, {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    })
    editor.addToHistory('/help')

    editor.handleInput('\x1b[A')

    assert.equal(editor.getText(), '/help')
    assert.deepEqual(editor.getCursor(), { line: 0, col: '/help'.length })
  })

  it('submits an exact slash-command argument with one Enter press', async () => {
    const identity = (text: string): string => text
    const editor = new PromptEditor({
      terminal: { rows: 24 },
      requestRender: () => undefined,
    } as never, {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    })
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{
      name: 'mode',
      description: '切换模式',
      argumentHint: '<standard|minimal>',
      getArgumentCompletions: () => [
        { value: 'standard', label: 'standard — 标准' },
        { value: 'minimal', label: 'minimal — 极简' },
      ],
    }], 'D:/work'))
    let submitted: string | undefined
    editor.onSubmit = (text): void => { submitted = text }

    for (const character of '/mode minimal') editor.handleInput(character)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(editor.isShowingAutocomplete(), true)

    editor.handleInput('\r')
    assert.equal(submitted, '/mode minimal')
    assert.equal(editor.getText(), '')
  })
})
