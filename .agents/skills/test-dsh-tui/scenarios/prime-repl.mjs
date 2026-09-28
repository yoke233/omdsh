/** Verifies an installed Prime bundle with two controlled-model turns and real REPL execution. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export async function run(tui) {
  const proofPath = join(tui.config.artifacts, 'prime-live-proof.json')
  writeFileSync(join(tui.config.dshHome, 'settings.yaml'), 'agent-presets:\n  default: prime\n')
  const name = 'dsh-prime-upgrade-fixture'
  const fixture = tui.packFixture({
    name,
    patch: `- insert:\n    - id: prime-upgrade-fixture\n      name: ${name}\n- id: agent-default-model\n  config:\n    provider: prime-upgrade-fixture\n    model: controlled\n- id: session-title-llm-tui\n  disabled: true\n`,
    source: `import { writeFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
export const inject = ['llm']
let requests = 0
const results = []
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: [{id:'max',name:'Max'}], defaultEffort:'max' } }
  }
  async *stream(request) {
    const toolNames = request.tools?.map(tool => tool.name)
    if (JSON.stringify(toolNames) !== '["repl"]') throw new Error('Prime exposed unexpected tools: ' + JSON.stringify(toolNames))
    const index = requests++
    if (index === 0 || index === 2) {
      const id = 'prime-upgrade-' + index
      const code = index === 0 ? 'const upgradeSentinel = 424242; upgradeSentinel' : 'upgradeSentinel + 1'
      const argumentsJson = JSON.stringify({code})
      yield {type:'block-start',index:0,blockType:'tool-call'}
      yield {type:'tool-call-delta',index:0,id,name:'repl',argumentsDelta:argumentsJson}
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'repl',arguments:argumentsJson}}
      yield {type:'finish',reason:{kind:'tool-calls'}}
      return
    }
    const last = request.messages.filter(message => message.role === 'tool').at(-1)
    const text = last?.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (last?.isError || (index === 1 ? !text?.includes('424242') : index !== 3 || !/^424243(?:\\r?\\n|$)/.test(text ?? ''))) throw new Error('Unexpected real REPL result: ' + JSON.stringify(last))
    results.push(text)
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'block-end',index:0,block:{type:'text',text:index === 1 ? 'PRIME_FIRST_TURN_OK' : 'PRIME_PERSISTENCE_OK'}}
    yield {type:'usage',usage:{inputTokens:1,outputTokens:1}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['prime-upgrade-fixture'], new Adapter()))
  ctx.on('agent/status', ({agent,status}) => {
    if (status === 'idle' && requests >= 2) writeFileSync(${JSON.stringify(proofPath)}, JSON.stringify({requests,results,id:agent.id,idle:true}))
  })
}
`,
  })
  tui.runDsh(['plugin', '--profile', 'tui', 'add', fixture])
  await tui.start()
  await tui.waitForOutput(/欢迎回来|Welcome back/, {timeoutMs:60000,label:'Prime startup'})
  await tui.waitForSlashMenu()
  tui.key('\x1b')
  tui.key('\x15')
  await tui.waitForScreen(/◆\s+prime/i, {timeoutMs:15000,label:'legacy Prime default restored'})
  const pid = tui.pid()
  tui.submit('/mode standard')
  await tui.waitForScreen(/◆\s+standard/, {timeoutMs:15000,label:'switch from Prime'})
  tui.submit('/mode prime')
  await tui.waitForScreen(/◆\s+prime/i, {timeoutMs:15000,label:'switch back to Prime'})
  tui.submit('RUN_PRIME_FIRST')
  await tui.waitForOutput('PRIME_FIRST_TURN_OK', {timeoutMs:45000,label:'first real REPL turn'})
  await tui.waitFor(() => existsSync(proofPath) && JSON.parse(readFileSync(proofPath,'utf8')).requests === 2, 15000, 'first turn settled')
  tui.submit('RUN_PRIME_SECOND')
  await tui.waitForOutput('PRIME_PERSISTENCE_OK', {timeoutMs:45000,label:'second real REPL turn'})
  await tui.waitFor(() => JSON.parse(readFileSync(proofPath,'utf8')).requests === 4, 15000, 'second turn settled')
  const proof = JSON.parse(readFileSync(proofPath,'utf8'))
  assert.match(proof.results[1], /^424243(?:\r?\n|$)/)
  const patch = readFileSync(join(tui.config.dshHome,'profiles','tui','cordis.patch.yml'),'utf8')
  assert.match(patch, /selectedDefault: prime/)
  const screenshot = await tui.snapshot('prime-persistent-repl')
  assert.equal(tui.pid(), pid)
  return {legacyPrimeDefaultMigrated:true,onlyReplExposed:true,persistentReplAcrossTwoTurns:true,secondResult:proof.results[1],presetSwitchRoundTrip:true,pid,screenshot}
}
