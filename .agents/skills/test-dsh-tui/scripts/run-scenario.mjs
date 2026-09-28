import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TuiHarness, readHarnessConfig, scenarioName } from './tui-harness.mjs'

const [configPath, scenarioPath] = process.argv.slice(2)
if (configPath === undefined || scenarioPath === undefined) {
  throw new Error('usage: node run-scenario.mjs <config.json> <scenario.mjs>')
}

const config = readHarnessConfig(configPath)
const scenario = await import(pathToFileURL(scenarioPath).href)
if (typeof scenario.run !== 'function') {
  throw new TypeError(`${scenarioPath} must export async function run(tui)`)
}

const tui = new TuiHarness(config)
let result
let failure
try {
  result = await scenario.run(tui)
  if (!tui.hasStarted()) throw new Error('scenario completed without starting the TUI')
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new TypeError('scenario must return a JSON acceptance-report object')
  }
  if (!Object.values(result).some(value => value === true)) {
    throw new Error('scenario report must contain at least one successful boolean assertion')
  }
} catch (error) {
  failure = error
} finally {
  try {
    await tui.stop()
  } catch (stopError) {
    failure ??= stopError
  }
}

if (failure !== undefined) throw failure
const report = {
  scenario: scenarioName(scenarioPath),
  packagedLiveTest: true,
  packageSource: config.packageSource,
  tuiPackage: config.tuiPackage,
  extraBundles: config.extraBundles,
  dshVersion: config.dshVersion,
  dshExecutable: config.dshExecutable,
  ...result,
  artifactDirectory: config.keepArtifacts ? config.artifacts : null,
}
writeFileSync(join(config.artifacts, 'report.json'), JSON.stringify(report, undefined, 2) + '\n')
process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`)
// node-pty can retain a Windows ConPTY helper handle after the child exits.
// The scenario and graceful shutdown have completed; end the isolated runner.
process.exit(0)
