import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/** Running-turn composer input is visible immediately and joins the same turn as steer. */
export async function run(tui) {
  const packageName = 'dsh-live-steer-fixture'
  const requestStarted = tui.marker('steer-request-started')
  const releaseRequest = tui.marker('steer-release-request')
  const messageTurn = tui.marker('steer-message-turn')
  const secondRequest = tui.marker('steer-second-request')
  for (const path of [requestStarted, releaseRequest, messageTurn, secondRequest]) {
    rmSync(path, { force: true })
  }

  const fixture = tui.packFixture({
    name: packageName,
    patch: [
      '- insert:',
      '    - id: live-steer-llm',
      `      name: '${packageName}'`,
      '- id: agent-default-model',
      '  config:',
      '    provider: steer-fixture',
      '    model: controlled',
      '',
    ].join('\n'),
    source: [
      "import { existsSync, writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { setTimeout as delay } from 'node:timers/promises'",
      "import { LlmAdapter } from '@deepseek-ai/dsh-llm'",
      "export const inject = ['llm']",
      'let requestCount = 0',
      'class ControlledAdapter extends LlmAdapter {',
      '  async resolveModel(provider, model) {',
      "    return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } }",
      '  }',
      '  async * stream(options) {',
      '    requestCount += 1',
      "    const root = process.env.DSH_HOME",
      '    if (requestCount === 1) {',
      "      writeFileSync(join(root, 'steer-request-started'), String(process.pid))",
      "      yield { type: 'block-start', index: 0, blockType: 'text' }",
      "      yield { type: 'text-delta', index: 0, text: 'FIRST_STEP_WAITING' }",
      "      while (!existsSync(join(root, 'steer-release-request'))) {",
      "        if (options.signal?.aborted) throw new Error('aborted')",
      '        await delay(25)',
      '      }',
      "      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'FIRST_STEP_WAITING' } }",
      "      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }",
      "      yield { type: 'finish', reason: { kind: 'stop' } }",
      '      return',
      '    }',
      "    writeFileSync(join(root, 'steer-second-request'), String(process.pid))",
      "    yield { type: 'block-start', index: 0, blockType: 'text' }",
      "    yield { type: 'text-delta', index: 0, text: 'SECOND_STEP_OK' }",
      "    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SECOND_STEP_OK' } }",
      "    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }",
      "    yield { type: 'finish', reason: { kind: 'stop' } }",
      '  }',
      '}',
      'export function apply(ctx) {',
      "  ctx.llm.registerAdapter(['steer-fixture'], new ControlledAdapter())",
      "  ctx.on('session/event', (session, event) => {",
      "    if (event.type !== 'user/message') return",
      "    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')",
      "    if (!text.includes('STEER_EDIT_ONE') || !text.includes('STEER_EDIT_TWO')) return",
      "    const turn = session.snapshotEvents().findLast(item => item.type === 'turn/start')?.data.turn",
      "    writeFileSync(join(process.env.DSH_HOME, 'steer-message-turn'), String(turn))",
      '  })',
      '}',
      '',
    ].join('\n'),
  })
  tui.runDsh(['plugin', '--profile', 'tui', 'add', fixture])

  await tui.start()
  await tui.waitForOutput(/欢迎回来|Welcome back/, { timeoutMs: 30_000, label: 'welcome screen' })
  const pidBefore = tui.pid()

  const idleSubmittedAt = Date.now()
  tui.submit('START_CONTROLLED_TURN')
  await tui.waitForScreen('START_CONTROLLED_TURN', { timeoutMs: 500, label: 'immediate idle user bubble' })
  const idlePreviewMs = Date.now() - idleSubmittedAt
  await tui.waitFor(() => existsSync(requestStarted), 15_000, 'first model request')
  await tui.waitForOutput('FIRST_STEP_WAITING', { timeoutMs: 15_000, label: 'running first step' })

  tui.submit('STEER_EDIT_ONE')
  tui.submit('STEER_EDIT_TWO')
  await tui.waitForScreen(/STEER_EDIT_ONE[\s\S]*STEER_EDIT_TWO/, { timeoutMs: 5_000, label: 'multiple steer previews' })
  await tui.waitForScreen(/Steering:[\s\S]*Alt\+Up/, { timeoutMs: 5_000, label: 'steer queue edit hint' })
  if (existsSync(messageTurn)) throw new Error('steer reached the durable transcript before the blocked step was released')
  const pendingScreen = await tui.screenText()
  const idleOccurrences = pendingScreen.split('START_CONTROLLED_TURN').length - 1
  if (idleOccurrences !== 1) throw new Error(`idle message rendered ${idleOccurrences} times instead of once`)
  const pending = await tui.snapshot('steer-pending')

  tui.key('\x1b[1;3A')
  await tui.waitFor(async () => {
    const screen = await tui.screenText()
    return screen.includes('STEER_EDIT_ONE') && screen.includes('STEER_EDIT_TWO') && !screen.includes('Steering:')
  }, 5_000, 'Alt+Up merged queued messages into editor')
  const editing = await tui.snapshot('steer-editing')
  tui.key('\r')
  await tui.waitForScreen('Steering:', { timeoutMs: 5_000, label: 'merged steer resubmitted' })

  writeFileSync(releaseRequest, '')
  await tui.waitFor(() => existsSync(messageTurn), 15_000, 'steer user/message event')
  await tui.waitFor(() => existsSync(secondRequest), 15_000, 'second model request')
  await tui.waitForOutput('SECOND_STEP_OK', { timeoutMs: 15_000, label: 'second step response' })
  await tui.waitFor(async () => {
    const screen = await tui.screenText()
    return screen.includes('STEER_EDIT_ONE') && screen.includes('STEER_EDIT_TWO') && !screen.includes('Steering:')
  }, 10_000, 'durable steer transcript without pending label')

  const turn = Number(readFileSync(messageTurn, 'utf8'))
  const appliedPid = Number(readFileSync(requestStarted, 'utf8'))
  const secondRequestPid = Number(readFileSync(secondRequest, 'utf8'))
  const pidAfter = tui.pid()
  const settled = await tui.snapshot('steer-settled')
  const pids = [pidBefore, appliedPid, secondRequestPid, pidAfter]
  if (turn !== 1) throw new Error(`steer opened turn ${turn} instead of remaining in turn 1`)
  if (new Set(pids).size !== 1) throw new Error(`DSH PID changed: ${pids.join(', ')}`)

  return {
    ready: true,
    idlePreviewMs,
    idleMessageRenderedOnce: true,
    immediatePreviewVisible: true,
    pendingLabelVisible: true,
    queuedMessagesMergedForEditing: true,
    steerStayedInTurn: turn === 1,
    secondStepReceivedSteer: true,
    processStayedLive: true,
    pidBefore,
    appliedPid,
    secondRequestPid,
    pidAfter,
    screenshots: { pending, editing, settled },
  }
}
