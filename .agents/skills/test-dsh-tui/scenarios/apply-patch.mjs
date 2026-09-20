/** Raw apply_patch dispatch arguments render as a themed grouped patch. */
export async function run(tui) {
  const packageName = 'dsh-live-apply-patch-fixture'
  const fixture = tui.packFixture({
    name: packageName,
    patch: [
      '- insert:',
      '    - id: live-apply-patch-fixture',
      `      name: '${packageName}'`,
      '- id: agent-default-model',
      '  config:',
      '    provider: apply-patch-fixture',
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
      "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'APPLY_PATCH_DONE' } }",
      "    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }",
      "    yield { type: 'finish', reason: { kind: 'stop' } }",
      '  }',
      '}',
      'let emitted = false',
      'export function apply(ctx) {',
      "  ctx.llm.registerAdapter(['apply-patch-fixture'], new ControlledAdapter())",
      "  ctx.on('agent/pre-step', ({ agent }, next) => {",
      '    if (!emitted) {',
      '      emitted = true',
      "      const rootCallId = 'patch-root'",
      "      const subCallId = 'patch-root:repl:1'",
      "      const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-const value = 1', '+const value = 2', '*** Add File: src/b.ts', '+export const added = true', '*** End Patch'].join('\\n')",
      '      const args = { patch }',
      "      agent.session.append('tool/ptc-dispatch-start', { rootCallId, parentCallId: rootCallId, subCallId, name: 'apply_patch', arguments: args })",
      "      agent.session.append('tool/ptc-dispatch', { rootCallId, parentCallId: rootCallId, subCallId, name: 'apply_patch', arguments: args, isError: false, content: [{ type: 'text', text: 'Applied patch to 2 files.' }] })",
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
  tui.submit('RUN_APPLY_PATCH_FIXTURE')
  await tui.waitForOutput('APPLY_PATCH_DONE', { timeoutMs: 20_000, label: 'controlled turn completion' })
  await tui.waitForScreen(/Apply Patch.*2 files \(\+2 -1\).*Ctrl\+O to expand/, { timeoutMs: 20_000, label: 'compact patch summary' })
  const expandOffset = tui.mark()
  tui.key('\x0f')
  await tui.waitForOutput(/Update src\/a\.ts/, { since: expandOffset, timeoutMs: 20_000, label: 'expanded themed patch' })
  const expandedOutput = tui.plainOutput(expandOffset)
  for (const expected of ['Update src/a.ts', '- const value = 1', '+ const value = 2', 'Add src/b.ts']) {
    if (!expandedOutput.includes(expected)) throw new Error(`Expanded patch omitted: ${expected}`)
  }
  if (expandedOutput.includes('*** Begin Patch') || expandedOutput.includes('*** Update File')) throw new Error('Raw patch protocol markers remained visible')
  const pidAfter = tui.pid()
  if (pidBefore !== pidAfter) throw new Error(`DSH PID changed: ${pidBefore} -> ${pidAfter}`)
  return { ready: true, compactSummary: true, groupedPatchRendered: true, rawMarkersHidden: true, pidBefore, pidAfter }
}
