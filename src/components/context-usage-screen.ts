/** Full-screen context usage inspector, modelled after OMP's context map. */

import { getKeybindings, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Translator, MessageKey } from '../i18n.ts'
import type { Palette } from '../theme.ts'

export type ContextCategoryId = 'system-prompt' | 'system-tools' | 'custom-tools' | 'memory' | 'skills' | 'user-messages' | 'agent-text' | 'agent-thinking' | 'agent-tool-calls' | 'tool-output' | 'compacted-data' | 'autocomplete-buffer'
export interface ContextCategory { id: ContextCategoryId; tokens: number; children?: Array<{ label: string; tokens: number }> }
export interface ContextUsageSnapshot { model: string; usedTokens: number; contextWindow: number; categories: ContextCategory[] }
interface MeasurementNode { seq: number; tokens: number }

const IDS: readonly ContextCategoryId[] = ['system-prompt', 'system-tools', 'custom-tools', 'memory', 'skills', 'user-messages', 'agent-text', 'agent-thinking', 'agent-tool-calls', 'tool-output', 'compacted-data', 'autocomplete-buffer']
const LABELS: Record<ContextCategoryId, MessageKey> = {
  'system-prompt': 'contextSystemPrompt', 'system-tools': 'contextSystemTools', 'custom-tools': 'contextCustomTools',
  memory: 'contextMemory', skills: 'contextSkills', 'user-messages': 'contextUserMessages', 'agent-text': 'contextAgentText',
  'agent-thinking': 'contextAgentThinking', 'agent-tool-calls': 'contextAgentToolCalls', 'tool-output': 'contextToolOutput',
  'compacted-data': 'contextCompactedData', 'autocomplete-buffer': 'contextAutocompleteBuffer',
}

function estimate(value: unknown): number {
  let text = ''
  try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? '' } catch { text = String(value) }
  return text === '' ? 0 : Math.max(1, Math.ceil(text.length / 4) + 4)
}

function userCategory(message: Record<string, unknown>): ContextCategoryId {
  const source = message.source as Record<string, unknown> | undefined
  const producer = typeof source?.kind === 'string' ? source.kind.toLowerCase() : ''
  const text = JSON.stringify(message.content ?? '').toLowerCase()
  if (producer.includes('skill') || text.includes('<skill') || text.includes('skill.md')) return 'skills'
  if (text.includes('agents.md') || producer.includes('instruction') || source?.form === 'instructions') return 'memory'
  return 'user-messages'
}

function assistantCategory(block: Record<string, unknown>): ContextCategoryId {
  if (block.type === 'reasoning') return 'agent-thinking'
  if (block.type === 'tool-call') return 'agent-tool-calls'
  return 'agent-text'
}

/** Apportion measured pressure using a heuristic category breakdown. */
export function buildContextUsageSnapshot(events: readonly SessionEvent[], nodes: readonly MeasurementNode[], usedTokens: number, contextWindow: number, model: string): ContextUsageSnapshot {
  const totals = new Map<ContextCategoryId, number>(IDS.map(id => [id, 0]))
  const toolChildren = new Map<string, number>()
  const activeTokens = new Map(nodes.map(node => [node.seq, node.tokens]))
  const toolByCallId = new Map<string, string>()
  let latestHeader: Record<string, unknown> | undefined
  const add = (id: ContextCategoryId, tokens: number): void => {
    if (Number.isFinite(tokens) && tokens > 0) totals.set(id, (totals.get(id) ?? 0) + tokens)
  }

  for (const event of events) {
    const data = event.data as unknown as Record<string, unknown>
    if (event.type === 'request/header') { latestHeader = data.header as Record<string, unknown> | undefined; continue }
    if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '')
      if (callId !== '') toolByCallId.set(callId, String(data.name ?? 'tool'))
      continue
    }
    const nodeTokens = activeTokens.get(event.seq)
    if (nodeTokens === undefined) continue
    if (event.type === 'user/message') {
      const op = event.surfaceOp
      if (typeof op === 'object' && op !== null && (op as { op?: unknown }).op === 'replace') add('compacted-data', nodeTokens)
      else add(userCategory(data), nodeTokens)
    } else if (event.type === 'assistant/message') {
      const message = data.message as Record<string, unknown> | undefined
      const blocks = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : []
      const weights = blocks.map(estimate)
      const weightTotal = weights.reduce((sum, value) => sum + value, 0)
      if (weightTotal === 0) add('agent-text', nodeTokens)
      else {
        let assigned = 0
        blocks.forEach((block, index) => {
          const amount = index === blocks.length - 1 ? nodeTokens - assigned : Math.round(nodeTokens * (weights[index] ?? 0) / weightTotal)
          add(assistantCategory(block), amount)
          assigned += amount
        })
      }
    } else if (event.type === 'tool/result') {
      add('tool-output', nodeTokens)
      const message = data.message as Record<string, unknown> | undefined
      const source = message?.source as Record<string, unknown> | undefined
      const content = Array.isArray(message?.content) ? message.content[0] as Record<string, unknown> | undefined : undefined
      const callId = String(source?.callId ?? content?.toolCallId ?? '')
      const name = toolByCallId.get(callId) ?? String(source?.name ?? 'tool')
      toolChildren.set(name, (toolChildren.get(name) ?? 0) + nodeTokens)
    }
  }

  if (latestHeader !== undefined) {
    add('system-prompt', estimate(latestHeader.system))
    const tools = Array.isArray(latestHeader.tools) ? latestHeader.tools : []
    add('custom-tools', tools.reduce((sum, tool) => sum + estimate(tool), 0))
  }

  const safeUsed = Math.max(0, Math.round(usedTokens))
  const rawTotal = [...totals.values()].reduce((sum, value) => sum + value, 0)
  if (safeUsed > 0 && rawTotal > 0) {
    for (const id of IDS) totals.set(id, Math.max(0, Math.round((totals.get(id) ?? 0) * safeUsed / rawTotal)))
    const scaledTotal = [...totals.values()].reduce((sum, value) => sum + value, 0)
    const largest = [...IDS].sort((left, right) => (totals.get(right) ?? 0) - (totals.get(left) ?? 0))[0]!
    totals.set(largest, Math.max(0, (totals.get(largest) ?? 0) + safeUsed - scaledTotal))
  } else if (safeUsed > 0) {
    totals.set('system-prompt', safeUsed)
  }
  const rawToolTotal = [...toolChildren.values()].reduce((sum, value) => sum + value, 0)
  const scaledToolTotal = totals.get('tool-output') ?? 0
  const children = [...toolChildren.entries()].map(([label, tokens]) => ({ label, tokens: rawToolTotal === 0 ? 0 : Math.round(tokens * scaledToolTotal / rawToolTotal) })).sort((a, b) => b.tokens - a.tokens)

  return {
    model,
    usedTokens: safeUsed,
    contextWindow: Math.max(1, Math.round(contextWindow)),
    categories: IDS.map(id => ({ id, tokens: totals.get(id) ?? 0, ...(id === 'tool-output' && children.length > 0 ? { children } : {}) })),
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1) + 'M'
  if (tokens >= 1_000) return (tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1) + 'k'
  return String(Math.round(tokens))
}
function padAnsi(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), '')
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
}

export class ContextUsageScreen implements Component, Focusable {
  focused = false
  onClose?: () => void
  private selectedIndex = 0
  private zoom = 1
  private preview = false
  constructor(private readonly snapshot: ContextUsageSnapshot, private readonly palette: Palette, private readonly t: Translator, private readonly height: number) {}

  handleInput(data: string): void {
    const kb = getKeybindings()
    if (kb.matches(data, 'tui.select.cancel')) { this.onClose?.(); return }
    if (kb.matches(data, 'tui.select.up') || data === 'k') { this.selectedIndex = (this.selectedIndex - 1 + this.snapshot.categories.length) % this.snapshot.categories.length; return }
    if (kb.matches(data, 'tui.select.down') || data === 'j') { this.selectedIndex = (this.selectedIndex + 1) % this.snapshot.categories.length; return }
    if (data.toLowerCase() === 'z') { this.zoom = (this.zoom + 1) % 3; return }
    if (kb.matches(data, 'tui.select.confirm') || matchesKey(data, 'enter')) this.preview = !this.preview
  }
  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(24, width)
    const contentWidth = Math.max(1, safeWidth - 2)
    const percentage = Math.min(999, this.snapshot.usedTokens / this.snapshot.contextWindow * 100)
    const right = this.palette.bold(this.palette.model(this.snapshot.model + ' · ' + formatTokens(this.snapshot.usedTokens) + '/' + formatTokens(this.snapshot.contextWindow) + ' (' + percentage.toFixed(0) + '%)'))
    const left = this.palette.bold(this.palette.accent(this.t('contextTitle')))
    const gap = Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(right))
    const lines = [truncateToWidth(left + ' '.repeat(gap) + right, contentWidth, ''), '']
    if (contentWidth >= 68) lines.push(...this.renderWide(contentWidth))
    else lines.push(...this.renderMap(contentWidth), '', ...this.renderCategories(contentWidth))

    const selected = this.snapshot.categories[this.selectedIndex]
    if (this.preview && selected !== undefined) {
      lines.push('', this.palette.bold(this.palette.accent(this.t(LABELS[selected.id]))))
      lines.push(...this.wrap(this.t('contextPreview', { category: this.t(LABELS[selected.id]), tokens: formatTokens(selected.tokens) }), contentWidth).map(line => this.palette.dim(line)))
    }
    const footerRows = 4
    while (lines.length < Math.max(0, this.height - footerRows)) lines.push('')
    lines.push(...this.wrap(this.t('contextEstimate'), contentWidth).slice(0, 2).map(line => this.palette.muted(line)))
    while (lines.length < Math.max(0, this.height - 1)) lines.push('')
    lines.push(this.palette.muted(this.t('contextControls')))
    return lines.slice(0, Math.max(1, this.height))
  }

  private renderWide(width: number): string[] {
    const mapWidth = Math.min(30, Math.max(24, Math.floor(width * 0.28)))
    const gap = 3
    const listWidth = Math.max(20, width - mapWidth - gap)
    const map = this.renderMap(mapWidth)
    const list = this.renderCategories(listWidth)
    return Array.from({ length: Math.max(map.length, list.length) }, (_, i) => padAnsi(map[i] ?? '', mapWidth) + ' '.repeat(gap) + padAnsi(list[i] ?? '', listWidth))
  }

  private renderMap(width: number): string[] {
    const columns = Math.max(4, Math.min(14, Math.floor(width / 2)))
    const rows = [8, 12, 16][this.zoom]!
    const cells = columns * rows
    const blockSize = this.snapshot.contextWindow / cells
    const boundaries: Array<{ end: number; index: number }> = []
    let cursor = 0
    this.snapshot.categories.forEach((category, index) => { cursor += category.tokens; boundaries.push({ end: cursor, index }) })
    const glyphs: string[] = []
    for (let cell = 0; cell < cells; cell++) {
      const start = cell * blockSize
      const end = (cell + 1) * blockSize
      if (start >= this.snapshot.usedTokens) { glyphs.push(this.palette.dim('◌')); continue }
      const first = boundaries.find(entry => start < entry.end)
      const last = boundaries.find(entry => Math.min(end, this.snapshot.usedTokens) <= entry.end)
      glyphs.push(this.role(first?.index ?? 0)(first?.index === last?.index ? '■' : '▣'))
    }
    const lines: string[] = []
    for (let row = 0; row < rows; row++) lines.push(glyphs.slice(row * columns, (row + 1) * columns).join(' '))
    lines.push('', this.palette.bold(this.palette.warning(this.t('contextMap'))))
    lines.push(this.palette.muted(' ■ — ' + this.t('contextMapSingle')))
    lines.push(this.palette.muted(' ▣ — ' + this.t('contextMapShared')))
    lines.push(this.palette.muted(' ◌ — ' + this.t('contextBlockSize', { size: formatTokens(blockSize), percent: (100 / cells).toFixed(1) })))
    return lines
  }

  private renderCategories(width: number): string[] {
    const lines = [this.palette.bold(this.palette.warning(this.t('contextCategory')))]
    const labelWidth = Math.max(10, Math.min(31, Math.floor(width * 0.55)))
    this.snapshot.categories.forEach((category, index) => {
      const label = this.t(LABELS[category.id])
      const dots = '.'.repeat(Math.max(2, labelWidth - visibleWidth(label)))
      const prefix = index === this.selectedIndex ? '→ ' : '  '
      const row = prefix + this.role(index)('■') + ' ' + label + ' ' + dots + ' ' + formatTokens(category.tokens).padStart(6) + '  ' + (category.tokens / this.snapshot.contextWindow * 100).toFixed(1).padStart(5) + '%'
      lines.push(index === this.selectedIndex ? this.palette.bold(row) : row)
      for (const child of category.children?.slice(0, 4) ?? []) {
        const childDots = '.'.repeat(Math.max(2, labelWidth - visibleWidth(child.label) + 1))
        lines.push(this.palette.muted('     • ' + child.label + ' ' + childDots + ' ' + formatTokens(child.tokens).padStart(6)))
      }
    })
    const free = Math.max(0, this.snapshot.contextWindow - this.snapshot.usedTokens)
    const label = this.t('contextFreeSpace')
    const dots = '.'.repeat(Math.max(2, labelWidth - visibleWidth(label)))
    lines.push('  ' + this.palette.dim('◌') + ' ' + label + ' ' + dots + ' ' + formatTokens(free).padStart(6) + '  ' + (free / this.snapshot.contextWindow * 100).toFixed(1).padStart(5) + '%')
    return lines.map(line => truncateToWidth(line, width, ''))
  }

  private role(index: number): (text: string) => string {
    const roles = [this.palette.warning, this.palette.toolTitle, this.palette.accent, this.palette.git, this.palette.thinking, this.palette.error, this.palette.code, this.palette.warning, this.palette.accent, this.palette.toolOutput, this.palette.spend, this.palette.context]
    return roles[index % roles.length] ?? this.palette.text
  }
  private wrap(text: string, width: number): string[] {
    const lines: string[] = []
    let line = ''
    for (const word of text.split(/\s+/)) {
      if (line !== '' && visibleWidth(line + ' ' + word) > width) { lines.push(line); line = word }
      else line = line === '' ? word : line + ' ' + word
    }
    if (line !== '') lines.push(line)
    return lines
  }
}
