/** Official Code Dispatch cards toggle between compact and expanded in the packaged TUI. */
export async function run(tui) {
  const packageName = 'dsh-live-code-dispatch-fixture'
  const fixture = tui.packFixture({
    name: packageName,
    patch: [
      '- insert:',
      '    - id: live-code-dispatch-fixture',
      `      name: '${packageName}'`,
      '- id: agent-default-model',
      '  config:',
      '    provider: code-dispatch-fixture',
      '    model: controlled',
      '',
    ].join('\n'),
    source: [
      "import { LlmAdapter } from '@deepseek-ai/dsh-llm'",
      "export const inject = ['llm']",
      'class ControlledAdapter extends LlmAdapter {',
      '  async resolveModel(provider, model) {',
      "    return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } }",
      '  }',
      '  async * stream() {',
      "    yield { type: 'block-start', index: 0, blockType: 'text' }",
      "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CODE_DISPATCH_DONE' } }",
      "    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }",
      "    yield { type: 'finish', reason: { kind: 'stop' } }",
      '  }',
      '}',
      'let emitted = false',
      'export function apply(ctx) {',
      "  ctx.llm.registerAdapter(['code-dispatch-fixture'], new ControlledAdapter())",
      "  ctx.on('agent/pre-step', async ({ agent }, next) => {",
      '    if (!emitted) {',
      '      emitted = true',
      "      const rootCallId = 'fixture-root'",
      "      const subCallId = 'fixture-root:repl:1'",
      "      agent.session.append('tool/call', { callId: rootCallId, name: 'repl', arguments: JSON.stringify({ code: 'await tools.edit({ file_path: \"src/a.ts\" })' }) })",
      "      const args = { file_path: 'src/a.ts', old_string: 'const oldValue = 1', new_string: 'const newValue = 2' }",
      "      agent.session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId: rootCallId, subCallId, name: 'edit', arguments: args })",
      '      await new Promise(resolve => setTimeout(resolve, 750))',
      "      agent.session.append('tool/result', { turn: 0, step: 0, message: { source: { kind: 'tool', callId: rootCallId }, content: [{ type: 'tool-result', toolCallId: rootCallId, content: [{ type: 'text', text: 'Edited src/a.ts.' }] }] } }, { surfaceOp: 'append' })",
      "      agent.session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId, subCallId, name: 'edit', arguments: args, isError: false, content: [{ type: 'text', text: 'Edited src/a.ts.' }] })",
      '    }',
      '    return next()',
      '  })',
      '}',
      '',
    ].join('\n'),
  })
  tui.runDsh(['plugin', '--profile', 'tui', 'add', fixture])

  await tui.start()
  await tui.waitForOutput(/欢迎回来|Welcome back/, { timeoutMs: 30_000, label: 'welcome screen' })
  const pidBefore = tui.pid()
  tui.submit('RUN_CODE_DISPATCH_FIXTURE')
  await tui.waitForScreen(/ Repl · await tools\.edit.*Ctrl\+O to expand[\s\S]* Edit · src\/a\.ts.*Ctrl\+O to expand/, {
    timeoutMs: 20_000,
    label: 'compact pending REPL tree',
  })
  await tui.waitForOutput('CODE_DISPATCH_DONE', { timeoutMs: 20_000, label: 'controlled turn completion' })
  await tui.waitForScreen(/✓ Edit .*src\/a\.ts.*Ctrl\+O to expand/, {
    timeoutMs: 20_000,
    label: 'compact edit card',
  })
  const compactScreen = await tui.screenText()
  if (!/✓ Repl/.test(compactScreen)) throw new Error('Successful REPL wrapper disappeared after its dispatched child completed')

  tui.key('\x0f')
  await tui.waitForScreen(/✓ Edit .*src\/a\.ts[\s\S]*Edited src\/a\.ts\./, {
    timeoutMs: 20_000,
    label: 'expanded edit card',
  })

  tui.key('\x0f')
  await tui.waitForScreen(/✓ Edit .*src\/a\.ts.*Ctrl\+O to expand/, {
    timeoutMs: 20_000,
    label: 'collapsed edit card after second toggle',
  })
  const collapsedScreen = await tui.screenText()
  if (collapsedScreen.includes('Edited src/a.ts.')) throw new Error('Tool card remained expanded after second Ctrl+O')
  const snapshot = await tui.snapshot('code-dispatch')
  const pidAfter = tui.pid()
  if (pidBefore !== pidAfter) throw new Error(`DSH PID changed: ${pidBefore} -> ${pidAfter}`)

  return {
    ready: true,
    compactCardRendered: true,
    compactPendingTreeRendered: true,
    expandedCardRendered: true,
    replWrapperPersisted: true,
    processStayedLive: true,
    pidBefore,
    pidAfter,
    snapshot,
  }
}
