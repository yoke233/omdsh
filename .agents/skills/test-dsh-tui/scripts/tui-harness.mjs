import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const ANSI_16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

function paletteColor(index) {
  if (index < ANSI_16.length) return ANSI_16[index]
  if (index >= 16 && index <= 231) {
    const value = index - 16
    const level = component => component === 0 ? 0 : 55 + component * 40
    const red = level(Math.floor(value / 36))
    const green = level(Math.floor(value / 6) % 6)
    const blue = level(value % 6)
    return rgb(red, green, blue)
  }
  const gray = 8 + (index - 232) * 10
  return rgb(gray, gray, gray)
}

function rgb(red, green, blue) {
  return `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function rgbNumber(value) {
  return rgb((value >> 16) & 255, (value >> 8) & 255, value & 255)
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function safeName(value) {
  return value.replaceAll(/[^a-zA-Z0-9_.-]+/g, '-')
}

function matches(text, expected) {
  if (typeof expected === 'string') return text.includes(expected)
  expected.lastIndex = 0
  return expected.test(text)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Real packaged DSH TUI controlled through ConPTY and mirrored in xterm-headless. */
export class TuiHarness {
  constructor(config) {
    this.config = config
    this.cols = 120
    this.rows = 40
    this.output = ''
    this.session = `${config.id}-session`
    this.rawLog = join(config.artifacts, 'pty-output.log')
    this.require = createRequire(join(config.harnessRoot, 'package.json'))
    this.pty = this.require('node-pty')
    this.dshLaunch = this.resolveDshLaunch()
    const { Terminal } = this.require('@xterm/headless')
    this.sharp = config.keepArtifacts ? this.require('sharp') : undefined
    this.virtual = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: {
        background: '#0c0c0c',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
      },
    })
    this.screenWrites = Promise.resolve()
  }

  /** Start the packaged `tui` Profile with optional dsh arguments. */
  async start(args = []) {
    return this.spawnTerminal(this.dshLaunch.command, [
      ...this.dshLaunch.prefix,
      '--profile', 'tui', '--session', this.session, ...args,
    ])
  }

  /**
   * Start the `tui` Profile under the packaged omdsh supervisor, the seam the
   * `/reload` respawn contract requires: the supervisor keeps the terminal
   * while dsh generations come and go.
   */
  async startSupervised(args = []) {
    const omdsh = join(this.config.projectRoot, 'scripts', 'omdsh.js')
    return this.spawnTerminal(process.execPath, [omdsh, '--session', this.session, ...args])
  }

  spawnTerminal(command, argv) {
    if (this.terminal !== undefined) throw new Error('TUI is already running')
    const childEnv = {
      ...process.env,
      DSH_HOME: this.config.dshHome,
      DSH_REAL: this.config.dshExecutable,
      OMDSH_NO_BOOTSTRAP: '1',
    }
    if (!this.config.allowModelRequests) {
      for (const name of Object.keys(childEnv)) {
        if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) delete childEnv[name]
      }
    }
    this.terminal = this.pty.spawn(command, argv, {
      cwd: this.config.projectRoot,
      env: childEnv,
      cols: this.cols,
      rows: this.rows,
      name: 'xterm-256color',
    })
    this.exitPromise = new Promise(resolve => {
      this.terminal.onExit(event => resolve(event))
    })
    this.terminal.onData(data => {
      this.output += data
      this.screenWrites = this.screenWrites.then(() => new Promise(resolve => {
        this.virtual.write(data, resolve)
      }))
    })
    return this
  }

  /** Whether the scenario started a real terminal process. */
  hasStarted() {
    return this.terminal !== undefined
  }

  /** Raw-output offset for assertions that must ignore earlier terminal history. */
  mark() {
    return this.output.length
  }

  /** Submit one complete input line. */
  submit(line) {
    this.assertRunning()
    this.terminal.write(`${line}\r`)
  }

  /** Send raw terminal input such as `\x1b`, `\x1b[A`, or `\x03`. */
  key(sequence) {
    this.assertRunning()
    this.terminal.write(sequence)
  }

  /** ANSI-stripped output, optionally from a previous mark. */
  plainOutput(since = 0) {
    return this.output.slice(since)
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\r/g, '')
  }

  /** Current visible viewport after applying all VT updates. */
  async screenText() {
    await this.screenWrites
    const buffer = this.virtual.buffer.active
    const rows = []
    for (let row = 0; row < this.rows; row += 1) {
      rows.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    return rows.join('\n')
  }

  /** Wait for text or a regex in incremental raw output. */
  async waitForOutput(expected, options = {}) {
    const since = options.since ?? 0
    return await this.waitFor(
      () => matches(this.plainOutput(since), expected),
      options.timeoutMs ?? 15_000,
      options.label ?? String(expected),
    )
  }

  /** Wait for text or a regex on the current visible screen. */
  async waitForScreen(expected, options = {}) {
    return await this.waitFor(
      async () => matches(await this.screenText(), expected),
      options.timeoutMs ?? 15_000,
      options.label ?? String(expected),
    )
  }

  /** Probe until the slash-command menu is ready after asynchronous Profile refreshes. */
  async waitForSlashMenu(options = {}) {
    const expected = options.expected ?? /→\s+\S+/
    const retryMs = options.retryMs ?? 500
    let nextProbeAt = 0
    return await this.waitFor(
      async () => {
        if (matches(await this.screenText(), expected)) return true
        const now = Date.now()
        if (now >= nextProbeAt) {
          this.key('\x15')
          this.key('/')
          nextProbeAt = now + retryMs
        }
        return false
      },
      options.timeoutMs ?? 15_000,
      options.label ?? 'slash-command menu readiness',
    )
  }

  /** Wait for a predicate while preserving the terminal tail on timeout. */
  async waitFor(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${label}.\n${this.plainOutput().slice(-5000)}`)
  }

  /**
   * Current DSH Node process id for continuity assertions. The `--profile`
   * requirement distinguishes the booted dsh process from the omdsh
   * supervisor, whose own argv also carries the session id.
   */
  pid() {
    if (process.platform === 'win32') {
      const command = [
        `$id = ${JSON.stringify(this.session)}`,
        "$process = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $id + '*') -and $_.CommandLine -like '*--profile*' } | Select-Object -First 1 -ExpandProperty ProcessId",
        'Write-Output $process',
      ].join('; ')
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { encoding: 'utf8' })
      const pid = Number(result.stdout.trim())
      if (Number.isInteger(pid) && pid > 0) return pid
      throw new Error(`Cannot find DSH process: ${result.stdout}\n${result.stderr}`)
    }
    const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
    const line = result.stdout.split('\n').find(value =>
      value.includes(this.session) && value.includes('node') && value.includes('--profile'))
    const pid = Number(line?.trim().split(/\s+/, 1)[0])
    if (Number.isInteger(pid) && pid > 0) return pid
    throw new Error(`Cannot find DSH process in ps output for ${this.session}`)
  }

  /** Full command line of one process, for launch-argument assertions. */
  commandLine(pid) {
    if (process.platform === 'win32') {
      const command = `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object -ExpandProperty CommandLine`
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { encoding: 'utf8' })
      return result.stdout.trim()
    }
    const result = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    return result.stdout.trim()
  }

  /** Run a non-interactive dsh command against the isolated Profile. */
  runDsh(args) {
    const result = spawnSync(this.dshLaunch.command, [...this.dshLaunch.prefix, ...args], {
      cwd: this.config.projectRoot,
      env: { ...process.env, DSH_HOME: this.config.dshHome },
      encoding: 'utf8',
    })
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`)
    return result
  }

  /** Create and pack a temporary DSH Bundle for a scenario. */
  packFixture({ name, patch, source, version = '1.0.0' }) {
    const root = join(this.config.artifacts, 'fixtures', safeName(name))
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name,
      version,
      type: 'module',
      main: './index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, undefined, 2) + '\n')
    writeFileSync(join(root, 'cordis.patch.yml'), patch.endsWith('\n') ? patch : `${patch}\n`)
    writeFileSync(join(root, 'index.js'), source.endsWith('\n') ? source : `${source}\n`)
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm', 'pack', '--pack-destination', this.config.artifacts], {
        cwd: root,
        encoding: 'utf8',
      })
      : spawnSync('pnpm', ['pack', '--pack-destination', this.config.artifacts], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`)
    const filename = `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`
    return join(this.config.artifacts, filename)
  }

  /** Path below the isolated DSH home for marker-based assertions. */
  marker(name) {
    return join(this.config.dshHome, safeName(name))
  }

  /** Save current screen as text, deterministic SVG, and PNG. */
  async snapshot(name) {
    if (!this.config.keepArtifacts) return { captured: false }
    await this.screenWrites
    const stem = safeName(name)
    const textPath = join(this.config.artifacts, `${stem}.txt`)
    const svgPath = join(this.config.artifacts, `${stem}.svg`)
    const pngPath = join(this.config.artifacts, `${stem}.png`)
    writeFileSync(textPath, `${await this.screenText()}\n`)
    const svg = this.renderSvg()
    writeFileSync(svgPath, svg)
    await this.sharp(Buffer.from(svg)).png().toFile(pngPath)
    return { textPath, svgPath, pngPath }
  }

  renderSvg() {
    const cellWidth = 10
    const cellHeight = 20
    const padding = 12
    const width = this.cols * cellWidth + padding * 2
    const height = this.rows * cellHeight + padding * 2
    const buffer = this.virtual.buffer.active
    const backgrounds = []
    const glyphs = []
    for (let row = 0; row < this.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      if (line === undefined) continue
      for (let column = 0; column < this.cols; column += 1) {
        const cell = line.getCell(column)
        if (cell === undefined || cell.getWidth() === 0) continue
        let foreground = this.cellColor(cell, 'fg', '#d4d4d4')
        let background = this.cellColor(cell, 'bg', '#0c0c0c')
        if (cell.isInverse()) [foreground, background] = [background, foreground]
        const x = padding + column * cellWidth
        const y = padding + row * cellHeight
        const span = Math.max(1, cell.getWidth())
        if (background !== '#0c0c0c') {
          backgrounds.push(`<rect x="${x}" y="${y}" width="${span * cellWidth}" height="${cellHeight}" fill="${background}"/>`)
        }
        const chars = cell.getChars()
        if (chars === '' || cell.isInvisible()) continue
        const weight = cell.isBold() ? '700' : '400'
        const style = cell.isItalic() ? 'italic' : 'normal'
        const decoration = cell.isUnderline() ? 'underline' : 'none'
        const opacity = cell.isDim() ? '0.55' : '1'
        glyphs.push(`<text x="${x}" y="${y + 15}" textLength="${span * cellWidth}" lengthAdjust="spacingAndGlyphs" fill="${foreground}" font-weight="${weight}" font-style="${style}" text-decoration="${decoration}" opacity="${opacity}">${xml(chars)}</text>`)
      }
    }
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      '<rect width="100%" height="100%" fill="#0c0c0c"/>',
      `<g font-family="Cascadia Mono, Consolas, monospace" font-size="15" xml:space="preserve">`,
      ...backgrounds,
      ...glyphs,
      '</g>',
      '</svg>',
      '',
    ].join('\n')
  }

  cellColor(cell, kind, fallback) {
    const prefix = kind === 'fg' ? 'Fg' : 'Bg'
    if (cell[`is${prefix}Default`]()) return fallback
    if (cell[`is${prefix}RGB`]()) return rgbNumber(cell[`get${prefix}Color`]())
    return paletteColor(cell[`get${prefix}Color`]())
  }

  resolveDshLaunch() {
    const bin = join(dirname(this.config.dshExecutable), '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    return { command: process.execPath, prefix: [bin] }
  }

  processTable() {
    if (process.platform === 'win32') {
      const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { encoding: 'utf8' })
      const parsed = JSON.parse(result.stdout || '[]')
      return (Array.isArray(parsed) ? parsed : [parsed]).map(process => ({
        pid: Number(process.ProcessId),
        parentPid: Number(process.ParentProcessId),
      }))
    }
    const result = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    return result.stdout.split('\n').map(line => {
      const [pid, parentPid] = line.trim().split(/\s+/).map(Number)
      return { pid, parentPid }
    }).filter(process => Number.isInteger(process.pid) && Number.isInteger(process.parentPid))
  }

  processTreeIds(rootPid) {
    const table = this.processTable()
    const ids = new Set([rootPid])
    let changed = true
    while (changed) {
      changed = false
      for (const process of table) {
        if (ids.has(process.parentPid) && !ids.has(process.pid)) {
          ids.add(process.pid)
          changed = true
        }
      }
    }
    return [...ids]
  }

  existingProcessIds(ids) {
    const live = new Set(this.processTable().map(process => process.pid))
    return ids.filter(pid => live.has(pid))
  }

  /** Gracefully stop the TUI, verify its process tree is gone, and persist VT output. */
  async stop() {
    writeFileSync(this.rawLog, this.output)
    if (this.terminal === undefined) {
      this.virtual.dispose()
      return
    }
    const ownedPids = this.processTreeIds(this.terminal.pid)
    this.terminal.write('\x03')
    await sleep(250)
    this.terminal.write('\x03')
    let exited = await Promise.race([
      this.exitPromise.then(() => true),
      sleep(3_000).then(() => false),
    ])
    if (!exited) {
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/pid', String(this.terminal.pid), '/t', '/f'], { encoding: 'utf8' })
      } else {
        try { this.terminal.kill('SIGKILL') } catch {}
      }
      exited = await Promise.race([
        this.exitPromise.then(() => true),
        sleep(5_000).then(() => false),
      ])
    }
    let remaining = this.existingProcessIds(ownedPids)
    if (remaining.length > 0) {
      if (process.platform === 'win32') {
        for (const pid of remaining) {
          spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { encoding: 'utf8' })
        }
      } else {
        for (const pid of remaining) {
          try { process.kill(pid, 'SIGKILL') } catch {}
        }
      }
      await sleep(500)
      remaining = this.existingProcessIds(ownedPids)
    }
    if (remaining.length > 0) throw new Error(`TUI process tree is still live: ${remaining.join(', ')}`)
    if (!exited) throw new Error('ConPTY did not report exit after its process tree stopped')
    writeFileSync(this.rawLog, this.output)
    this.virtual.dispose()
  }

  assertRunning() {
    if (this.terminal === undefined) throw new Error('TUI has not been started')
  }
}

/** Load the JSON configuration emitted by the PowerShell wrapper. */
export function readHarnessConfig(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Filename used in reports for a custom scenario. */
export function scenarioName(path) {
  return basename(path, '.mjs')
}
