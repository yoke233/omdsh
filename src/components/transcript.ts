/**
 * OMP-compatible transcript components adapted to DeepSeek Harness events:
 * responsive welcome panel, full-width user surfaces, unlabelled assistant
 * prose/reasoning, and lifecycle-aware tool output blocks.
 */

import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { frameBlock, gradientLogo, type MarkdownTheme, type Palette } from '../theme.ts'
import type { Translator } from '../i18n.ts'
import { contentText, parseArguments } from './content.ts'
import { displayText } from './text.ts'

const DSH_LOGO = [
  '██████╗ ███████╗██╗  ██╗',
  '██╔══██╗██╔════╝██║  ██║',
  '██║  ██║███████╗███████║',
  '██║  ██║╚════██║██╔══██║',
  '██████╔╝███████║██║  ██║',
]

const COLLAPSED_TEXT_SCAN_LIMIT = 16_384
const COLLAPSED_BLOCK_SCAN_LIMIT = 64
const COLLAPSED_DIFF_PATH_LIMIT = 3

/** Cache rendered rows for a component until its state or width changes. */
/** Raw event budget retained when a persisted transcript is first resumed. */
export const TRANSCRIPT_RECENT_EVENT_LIMIT = 2_000
export const TRANSCRIPT_LOAD_EVENT_STEP = 1_000

export function recentTranscriptStart(eventCount: number): number {
  return Math.max(0, eventCount - TRANSCRIPT_RECENT_EVENT_LIMIT)
}

interface RenderCache {
  key: string
  lines: string[]
}

/**
 * Transcript viewport: renders all children, then returns only the visible
 * line window. In follow-latest mode the window stays anchored to the bottom
 * as live events arrive; paging up freezes the top offset for history reading.
 */
export class TranscriptViewport extends Container {
  lineOffset = 0
  followLatest = true
  lastTotalLines = 0
  lastViewportLines = 0

  constructor(private readonly resolveViewportHeight: (width: number) => number) {
    super()
  }

  override render(width: number): string[] {
    const allLines = super.render(width)
    const maxLines = Math.max(0, Math.floor(this.resolveViewportHeight(width)))
    const maxOffset = Math.max(0, allLines.length - maxLines)
    if (this.followLatest) {
      this.lineOffset = maxOffset
    } else {
      this.lineOffset = Math.max(0, Math.min(this.lineOffset, maxOffset))
    }
    this.lastTotalLines = allLines.length
    this.lastViewportLines = Math.max(0, Math.min(maxLines, allLines.length - this.lineOffset))
    if (allLines.length <= maxLines) return allLines
    return allLines.slice(this.lineOffset, this.lineOffset + maxLines)
  }
}

function cachedRender(
  cache: RenderCache | undefined,
  key: string,
  compute: () => string[],
): { cache: RenderCache; lines: string[] } {
  if (cache !== undefined && cache.key === key) return { cache, lines: cache.lines }
  const lines = compute()
  return { cache: { key, lines }, lines }
}

/** Format a non-negative count without paying Intl initialization cost in a render path. */
function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function fitWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), '')
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
}

function center(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, '')
  const space = Math.max(0, width - visibleWidth(clipped))
  const left = Math.floor(space / 2)
  return `${' '.repeat(left)}${clipped}${' '.repeat(space - left)}`
}

/** Wrap one plain-text line into rows no wider than `width` display columns. */
function wrapToWidth(text: string, width: number): string[] {
  // Materialize tabs exactly like displayText/pi-tui measure them (3 cells),
  // so the terminal's hardware tab stops can never reflow a wrapped row.
  const safeText = text.replace(/\t/g, '   ')
  const safeWidth = Math.max(1, width)
  if (visibleWidth(safeText) <= safeWidth) return [safeText]
  const rows: string[] = []
  let current = ''
  let currentWidth = 0
  for (const char of Array.from(safeText)) {
    const charWidth = visibleWidth(char)
    if (currentWidth + charWidth > safeWidth) {
      if (current !== '') rows.push(current)
      current = char
      currentWidth = charWidth
    } else {
      current += char
      currentWidth += charWidth
    }
  }
  if (current !== '') rows.push(current)
  return rows
}

/** Responsive two-column welcome panel following OMP's startup composition. */
export class HeaderComponent implements Component {
  private renderCache: RenderCache | undefined

  constructor(
    private readonly agent: Agent,
    private readonly subtitle: () => string | undefined,
    private readonly palette: Palette,
    private readonly gradient: boolean,
    private readonly t: Translator,
    private readonly selection?: () => ModelSelection | undefined,
  ) {}

  invalidate(): void {
    this.renderCache = undefined
  }

  render(width: number): string[] {
    const selection = this.selection?.()
    const cacheKey = `${width}|${selection?.model ?? ''}|${selection?.provider ?? ''}|${this.subtitle() ?? ''}`
    const cached = cachedRender(this.renderCache, cacheKey, () => this.renderUncached(width, selection))
    this.renderCache = cached.cache
    return cached.lines
  }

  private renderUncached(width: number, selection: ModelSelection | undefined): string[] {
    const boxWidth = Math.min(100, Math.max(0, width - 2))
    if (boxWidth < 4) return []

    const showRight = boxWidth >= 64
    const leftWidth = showRight ? Math.min(28, Math.floor((boxWidth - 3) * 0.36)) : boxWidth - 2
    const rightWidth = showRight ? boxWidth - leftWidth - 3 : 0
    const logo = this.gradient
      ? gradientLogo(DSH_LOGO)
      : DSH_LOGO.map(line => this.palette.accent(line))
    const model = displayText(String(selection?.model ?? this.agent.options.model ?? 'No model'))
    const provider = displayText(String(selection?.provider ?? this.agent.options.provider ?? 'DeepSeek'))
    const leftLines = [
      '',
      center(this.palette.bold(this.t('headerWelcome')), leftWidth),
      '',
      ...logo.map(line => center(line, leftWidth)),
      '',
      center(this.palette.muted(model), leftWidth),
      center(this.palette.dim(provider), leftWidth),
      '',
    ]

    const separator = ` ${this.palette.dim('─'.repeat(Math.max(0, rightWidth - 2)))}`
    const session = displayText(String(this.agent.session.id))
    const workspace = displayText(this.agent.session.header.cwd ?? process.cwd())
    const extra = this.subtitle()
    const rightLines = [
      ` ${this.palette.bold(this.palette.accent(this.t('headerTips')))}`,
      ` ${this.palette.dim('/')} ${this.palette.muted(this.t('headerCommands'))}`,
      ` ${this.palette.dim('!')} ${this.palette.muted(this.t('headerShell'))}`,
      ` ${this.palette.dim('@')} ${this.palette.muted(this.t('headerSessions'))}`,
      ` ${this.palette.dim('Tab')} ${this.palette.muted(this.t('headerComplete'))}`,
      ` ${this.palette.dim('Ctrl+O')} ${this.palette.muted(this.t('headerExpand'))}`,
      separator,
      ` ${this.palette.bold(this.palette.accent(this.t('headerSession')))}`,
      ` ${this.palette.muted(session)}`,
      ` ${this.palette.dim(this.t('headerWorkspace'))}`,
      ` ${this.palette.muted(workspace)}`,
      ...extra === undefined ? [] : [` ${this.palette.dim(displayText(extra))}`],
      '',
    ]

    const horizontal = '─'
    const title = truncateToWidth('─── dsh ', Math.max(0, boxWidth - 2), '')
    const top = this.palette.dim(
      `╭${title}${horizontal.repeat(Math.max(0, boxWidth - 2 - visibleWidth(title)))}╮`,
    )
    const vertical = this.palette.dim('│')
    const lines = [top]
    const rows = showRight ? Math.max(leftLines.length, rightLines.length) : leftLines.length
    for (let index = 0; index < rows; index++) {
      const left = fitWidth(leftLines[index] ?? '', leftWidth)
      if (showRight) {
        const right = fitWidth(rightLines[index] ?? '', rightWidth)
        lines.push(`${vertical}${left}${vertical}${right}${vertical}`)
      } else {
        lines.push(`${vertical}${left}${vertical}`)
      }
    }
    const bottom = showRight
      ? `╰${horizontal.repeat(leftWidth)}┴${horizontal.repeat(rightWidth)}╯`
      : `╰${horizontal.repeat(leftWidth)}╯`
    lines.push(this.palette.dim(bottom))
    if (boxWidth >= 24) {
      const tip = this.palette.italic(
        ` ${this.palette.accent(this.t('headerTip'))} ${this.palette.muted(this.t('headerTipBody'))}`,
      )
      lines.push(truncateToWidth(tip, boxWidth, ''))
    }
    return lines
  }
}

/** OMP user bubble: padded Markdown on a full-width mantle surface, no label or outline. */
export class UserMessageComponent extends Container {
  private renderCache: RenderCache | undefined

  constructor(
    text: string,
    private readonly palette: Palette,
    mdTheme: MarkdownTheme,
    verticalPadding = 1,
  ) {
    super()
    this.addChild(new Markdown(displayText(text), 2, verticalPadding, mdTheme, {
      color: (value: string) => palette.text(value),
    }, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
    }))
  }

  override invalidate(): void {
    this.renderCache = undefined
    super.invalidate()
  }

  override render(width: number): string[] {
    const cached = cachedRender(this.renderCache, String(width), () =>
      super.render(width).map((row) => {
        const clipped = truncateToWidth(row, Math.max(1, width), '')
        const fill = ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
        return this.palette.userMessageBg(`${clipped}${fill}`)
      }))
    this.renderCache = cached.cache
    return cached.lines
  }
}

/** Borderless full-width surface for terminal turn failures. */
export class ErrorMessageComponent extends Container {
  private renderCache: RenderCache | undefined

  constructor(rows: readonly string[], private readonly palette: Palette) {
    super()
    this.addChild(new Text(rows.join('\n'), 2, 1))
  }

  override invalidate(): void {
    this.renderCache = undefined
    super.invalidate()
  }

  override render(width: number): string[] {
    const cached = cachedRender(this.renderCache, String(width), () =>
      super.render(width).map((row) => {
        const clipped = truncateToWidth(row, Math.max(1, width), '')
        const fill = ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
        return this.palette.toolErrorBg(`${clipped}${fill}`)
      }))
    this.renderCache = cached.cache
    return cached.lines
  }
}

/** OMP reasoning prose: inset, muted, italic, and deliberately unlabelled. */
export class ThinkingBlock extends Container {
  private renderCache: RenderCache | undefined

  constructor(reasoning: string, palette: Palette, mdTheme: MarkdownTheme) {
    super()
    this.addChild(new Markdown(displayText(reasoning), 2, 0, mdTheme, {
      color: (value: string) => palette.thinking(value),
      italic: true,
    }))
  }

  override invalidate(): void {
    this.renderCache = undefined
    super.invalidate()
  }

  override render(width: number): string[] {
    const cached = cachedRender(this.renderCache, String(width), () => super.render(width))
    this.renderCache = cached.cache
    return cached.lines
  }
}

/** Children of an assistant message: optional reasoning, then response prose. */
function assistantMessageChildren(
  content: readonly ContentBlock[],
  showReasoning: boolean,
  palette: Palette,
  mdTheme: MarkdownTheme,
): Component[] {
  const reasoning = displayText(textBlocks(content, 'reasoning').trim())
  const text = displayText(textBlocks(content, 'text').trim())
  const children: Component[] = []
  if (reasoning !== '' && showReasoning) children.push(new ThinkingBlock(reasoning, palette, mdTheme))
  if (text !== '') {
    if (children.length > 0) children.push(new Spacer(1))
    children.push(new Markdown(text, 2, 0, mdTheme, {
      color: (value: string) => palette.text(value),
    }))
  }
  return children
}

/** Concatenate the text of every block of one type, separated by blank lines. */
function textBlocks(content: readonly ContentBlock[], type: 'text' | 'reasoning'): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: typeof type }> => block.type === type)
    .map(block => block.text)
    .join('\n\n')
}

interface StreamingBlock {
  type: string
  text: string
}

/** A live assistant step: streamed reasoning/text blocks until the message settles. */
export class StreamingAssistantComponent extends Container {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settledContent: readonly ContentBlock[] | undefined
  private renderCache: RenderCache | undefined

  constructor(
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    private showReasoning: boolean,
  ) {
    super()
    this.rebuild()
  }

  override invalidate(): void {
    this.renderCache = undefined
    super.invalidate()
  }

  override render(width: number): string[] {
    const cached = cachedRender(this.renderCache, String(width), () => super.render(width))
    this.renderCache = cached.cache
    return cached.lines
  }

  /** Replace the streamed blocks with the step's settled content. */
  settle(content: readonly ContentBlock[]): void {
    this.settledContent = content
    this.rebuild()
  }

  /** Toggle whether reasoning blocks render, then re-render. */
  setShowReasoning(show: boolean): void {
    if (this.showReasoning === show) return
    this.showReasoning = show
    this.rebuild()
  }

  /** Fold one streamed chunk into the live block buffer and re-render. */
  update(chunk: StreamChunk): void {
    if (chunk.type === 'block-start') {
      this.blocks.set(chunk.index, { type: chunk.blockType, text: '' })
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      const block = this.blocks.get(chunk.index) ?? { type, text: '' }
      block.text += chunk.text
      this.blocks.set(chunk.index, block)
    } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
      this.blocks.set(chunk.index, { type: chunk.block.type, text: chunk.block.text })
    }
    this.rebuild()
  }

  private rebuild(): void {
    this.renderCache = undefined
    this.clear()
    const children = assistantMessageChildren(
      this.presentedContent(),
      this.showReasoning,
      this.palette,
      this.mdTheme,
    )
    if (children.length > 0) this.addChild(new Spacer(1))
    for (const child of children) this.addChild(child)
  }

  /** The settled content when available, otherwise the streamed blocks in model order. */
  private presentedContent(): readonly ContentBlock[] {
    return this.settledContent ?? [...this.blocks.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap<ContentBlock>(([, block]) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'reasoning') return [{ type: 'reasoning', text: block.text }]
        return []
      })
  }
}

/**
 * Owns one live assistant step without mounting it at `step/start`.
 * DSH emits `step/start` before the turn's entered `user/message` events, so
 * the component joins the transcript only when assistant content materializes.
 */
export class AssistantStreamController {
  private current: StreamingAssistantComponent | undefined
  private mounted = false

  constructor(
    private readonly transcript: Container,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
  ) {}

  /** Prepare an assistant step while preserving space for its input messages. */
  start(showReasoning: boolean): void {
    this.current = new StreamingAssistantComponent(this.palette, this.mdTheme, showReasoning)
    this.mounted = false
  }

  /** Append streamed content after every user/context message entered for this step. */
  update(chunk: StreamChunk): void {
    if (this.current === undefined) return
    this.current.update(chunk)
    this.mountCurrent()
  }

  /** Materialize providers that commit a message without publishing chunks. */
  settle(content: readonly ContentBlock[]): void {
    if (this.current === undefined) return
    this.current.settle(content)
    this.mountCurrent()
  }

  /** Detach controller state; already-mounted transcript content remains durable. */
  end(): void {
    this.current = undefined
    this.mounted = false
  }

  private mountCurrent(): void {
    if (this.current === undefined || this.mounted) return
    this.transcript.addChild(this.current)
    this.mounted = true
  }
}

/** Title a tool call carries on its card (`str_replace_editor` → `Str Replace Editor`). */
export function toolLabel(name: string): string {
  const safeName = name.trim() === '' ? 'unknown' : name
  return safeName
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

/** Summary key preference per tool variant, mirroring the official OMP tool row. */
const SUMMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  bash: ['command', 'description'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
}

function toolVariant(name: string): string {
  if (name === 'bash' || name === 'pwsh') return 'bash'
  if (name === 'read' || name === 'web_fetch') return 'read'
  if (name === 'web_search' || name === 'grep' || name === 'glob') return 'search'
  if (name === 'write') return 'write'
  if (name === 'edit') return 'edit'
  if (name === 'run_code') return 'code'
  return 'others'
}

/** Pick the first non-empty string arg for the given keys. */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return displayText(value.trim())
    }
  }
  return undefined
}

/** Return a display-safe string argument, or an empty string when absent. */
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? displayText(value) : ''
}

/**
 * `str_replace_editor` renders the model-facing edit content here because its
 * result text only says "edited successfully"; the actual old/new strings live
 * in the call arguments.
 */
function strReplaceEditorDetail(args: Record<string, unknown>): string {
  const path = stringArg(args, 'path')
  const command = stringArg(args, 'command')
  if (command === 'create') {
    return `path: ${path}\nfile_text:\n${stringArg(args, 'file_text')}`
  }
  if (command === 'str_replace') {
    return `path: ${path}\nold_str:\n${stringArg(args, 'old_str')}\nnew_str:\n${stringArg(args, 'new_str')}`
  }
  if (command === 'insert') {
    const line = typeof args.insert_line === 'number' ? String(args.insert_line) : ''
    return `path: ${path}\ninsert_line: ${line}\nnew_str:\n${stringArg(args, 'new_str')}`
  }
  if (command === 'view') {
    const range = Array.isArray(args.view_range) ? args.view_range.map(item => displayText(String(item))).join(', ') : ''
    return `path: ${path}${range === '' ? '' : `\nview_range: [${range}]`}`
  }
  return `path: ${path}${command === '' ? '' : `\ncommand: ${command}`}`
}

/** Build `Input`/`Diff` sections for a settled `str_replace_editor` call. */
function strReplaceEditorSections(
  argumentsJson: string,
  palette: Palette,
  width: number,
): { title: string; lines: string[] }[] {
  const parsed = parseArguments(argumentsJson)
  if (!parsed.valid || typeof parsed.value !== 'object' || parsed.value === null) return []
  const args = parsed.value as Record<string, unknown>
  const command = stringArg(args, 'command')
  const path = stringArg(args, 'path')
  const inputLines: string[] = []
  if (path !== '') inputLines.push(`path: ${path}`)
  if (command === 'view') {
    const range = Array.isArray(args.view_range) ? args.view_range.map(item => displayText(String(item))).join(', ') : ''
    if (range !== '') inputLines.push(`view_range: [${range}]`)
  }
  const sections: { title: string; lines: string[] }[] = []
  if (inputLines.length > 0) sections.push({ title: 'Input', lines: inputLines })

  const diffWidth = Math.max(1, width - 6)
  const plus = (line: string): string => palette.success(`+ ${line}`)
  const minus = (line: string): string => palette.error(`- ${line}`)
  const diffLines = (text: string, sign: 'plus' | 'minus'): string[] =>
    text.split('\n')
      .flatMap(line => wrapToWidth(line, diffWidth))
      .map(line => sign === 'plus' ? plus(line) : minus(line))

  if (command === 'create') {
    sections.push({ title: 'Diff', lines: diffLines(stringArg(args, 'file_text'), 'plus') })
  } else if (command === 'str_replace') {
    sections.push({
      title: 'Diff',
      lines: [
        ...diffLines(stringArg(args, 'old_str'), 'minus'),
        ...diffLines(stringArg(args, 'new_str'), 'plus'),
      ],
    })
  } else if (command === 'insert') {
    sections.push({ title: 'Diff', lines: diffLines(stringArg(args, 'new_str'), 'plus') })
  }
  return sections
}

interface ParsedPatchFile {
  operation: 'Add' | 'Update' | 'Delete'
  path: string
  lines: string[]
  additions: number
  deletions: number
}

function parseApplyPatch(argumentsJson: string): ParsedPatchFile[] {
  const parsed = parseArguments(argumentsJson)
  if (!parsed.valid || typeof parsed.value !== 'object' || parsed.value === null) return []
  const patch = (parsed.value as Record<string, unknown>).patch
  if (typeof patch !== 'string') return []
  const files: ParsedPatchFile[] = []
  let current: ParsedPatchFile | undefined
  for (const rawLine of displayText(patch).split('\n')) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(rawLine)
    if (file !== null) {
      current = { operation: file[1] as ParsedPatchFile['operation'], path: file[2]!, lines: [], additions: 0, deletions: 0 }
      files.push(current)
      continue
    }
    if (current === undefined || rawLine === '*** Begin Patch' || rawLine === '*** End Patch') continue
    if (rawLine.startsWith('*** Move to: ')) {
      current.lines.push('→ ' + rawLine.slice('*** Move to: '.length))
      continue
    }
    current.lines.push(rawLine)
    if (rawLine.startsWith('+')) current.additions++
    else if (rawLine.startsWith('-')) current.deletions++
  }
  return files
}

function applyPatchSummary(argumentsJson: string): string | undefined {
  const files = parseApplyPatch(argumentsJson)
  if (files.length === 0) return undefined
  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)
  return String(files.length) + ' ' + (files.length === 1 ? 'file' : 'files') + ' (+' + String(additions) + ' -' + String(deletions) + ')'
}

/** Render model-facing apply_patch syntax as a themed, file-grouped diff. */
function applyPatchSections(files: readonly ParsedPatchFile[], palette: Palette, width: number): { title: string; lines: string[] }[] {
  if (files.length === 0) return []
  const bodyWidth = Math.max(1, width - 6)
  const rows: string[] = []
  const coloredDiff = (prefix: string, text: string, color: Palette['success']): string[] =>
    wrapToWidth(text, Math.max(1, bodyWidth - 2)).map((line, index) => color((index === 0 ? prefix : '  ') + line))
  for (const file of files) {
    const stats = (file.additions > 0 ? ' +' + String(file.additions) : '')
      + (file.deletions > 0 ? ' -' + String(file.deletions) : '')
    rows.push(palette.accent(file.operation + ' ' + file.path) + palette.dim(stats))
    for (const line of file.lines) {
      if (line.startsWith('+')) rows.push(...coloredDiff('+ ', line.slice(1), palette.success))
      else if (line.startsWith('-')) rows.push(...coloredDiff('- ', line.slice(1), palette.error))
      else if (line.startsWith('@@')) rows.push(palette.dim(line))
      else if (line.startsWith('→ ')) rows.push(palette.accent(line))
      else rows.push(...coloredDiff('  ', line.startsWith(' ') ? line.slice(1) : line, palette.toolOutput))
    }
  }
  return [{ title: 'Patch', lines: rows }]
}

function diffViewSections(
  view: ToolCallView | ToolResultView | undefined,
  palette: Palette,
  width: number,
): { title: string; lines: string[] }[] {
  if (view?.card !== 'diff' || view.diffs.length === 0) return []
  const bodyWidth = Math.max(1, width - 6)
  const rows: string[] = []
  let previousPath: string | undefined
  for (const diff of view.diffs) {
    const path = displayText(diff.path)
    if (path !== previousPath) {
      rows.push(palette.muted(path))
      previousPath = path
    }
    if (diff.oldText !== null) {
      rows.push(...displayText(diff.oldText).split('\n')
        .flatMap(line => wrapToWidth(line, bodyWidth))
        .map(line => palette.error(`- ${line}`)))
    }
    rows.push(...displayText(diff.newText).split('\n')
      .flatMap(line => wrapToWidth(line, bodyWidth))
      .map(line => palette.success(`+ ${line}`)))
  }
  return [{ title: 'Diff', lines: rows }]
}

function callViewDetail(view: ToolCallView | undefined): string | undefined {
  if (view?.card !== 'diff') return undefined
  const paths = view.locations?.map(location => displayText(location.path))
    ?? view.diffs.map(diff => displayText(diff.path))
  const unique = [...new Set(paths)]
  return unique.length === 0 ? undefined : unique.join(', ')
}

/** Bound collapsed diff metadata work to a few paths regardless of diff size. */
function compactCallViewDetail(view: ToolCallView | ToolResultView | undefined): string | undefined {
  if (view?.card !== 'diff') return undefined
  const paths = 'locations' in view && view.locations !== undefined ? view.locations : view.diffs
  const visible: string[] = []
  for (let index = 0; index < Math.min(paths.length, COLLAPSED_DIFF_PATH_LIMIT); index++) {
    const path = displayText(paths[index]!.path)
    if (!visible.includes(path)) visible.push(path)
  }
  if (visible.length === 0) return undefined
  const hidden = Math.max(0, paths.length - COLLAPSED_DIFF_PATH_LIMIT)
  return visible.join(', ') + (hidden === 0 ? '' : `, … +${hidden} more`)
}

/**
 * The concrete input content shown under the tool title and above `Output`:
 * a shell command, a path, a query, or the first meaningful string argument.
 */
export function toolDetail(name: string, argumentsJson: string): string | undefined {
  const parsed = parseArguments(argumentsJson)
  if (!parsed.valid || typeof parsed.value !== 'object' || parsed.value === null) {
    const raw = displayText(argumentsJson).trim()
    return raw === '' ? undefined : raw
  }
  const args = parsed.value as Record<string, unknown>
  if (name === 'str_replace_editor') return strReplaceEditorDetail(args)
  if (name === 'apply_patch') return applyPatchSummary(argumentsJson)
  const picked = pickString(args, SUMMARY_KEYS[toolVariant(name)] ?? [])
  if (picked !== undefined) return picked
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim() !== '') {
      return displayText(value.trim())
    }
  }
  const raw = displayText(argumentsJson).trim()
  return raw === '' ? undefined : raw
}

/**
 * OMP tool lifecycle: pending calls are one quiet status row; settled calls
 * become rounded output blocks with a titled `Output` separator.
 */
export class ToolCardComponent implements Component {
  private result: {
    content: ContentBlock[]
    status: 'completed' | 'failed' | 'interrupted'
    view?: ToolResultView
  } | undefined
  private readonly subCalls: ToolCardComponent[] = []
  private parent: ToolCardComponent | undefined
  private visibility: ToolCardVisibility = 'collapsed'
  private renderCache: RenderCache | undefined
  private parsedPatchFiles: ParsedPatchFile[] | undefined

  constructor(
    private readonly name: string,
    private readonly argumentsJson: string,
    private readonly maxOutputLines: number,
    private readonly palette: Palette,
    private readonly callView?: ToolCallView,
  ) {}

  /** Record one native top-level tool result. */
  updateResult(
    event: Extract<SessionEvent, { type: 'tool/result' }>['data'],
    view?: ToolResultView,
  ): void {
    const message = event.message
    const interrupted = event.error?.code === 'ABORTED' || event.error?.code === 'ABORTED_BEFORE_DISPATCH'
    this.setResult(message.content, interrupted ? 'interrupted' : message.isError === true ? 'failed' : 'completed', view)
  }

  /** Record one settled official Code Dispatch child result. */
  updateDispatch(content: readonly ContentBlock[], isError: boolean, view?: ToolResultView): void {
    this.setResult(content, isError ? 'failed' : 'completed', view)
  }

  private setResult(
    content: readonly ContentBlock[],
    status: 'completed' | 'failed' | 'interrupted',
    view?: ToolResultView,
  ): void {
    this.result = { content: [...content], status, ...(view === undefined ? {} : { view }) }
    this.invalidate()
  }

  /** Attach one official Code Dispatch child below this call. */
  addSubCall(call: ToolCardComponent): void {
    call.parent = this
    call.setVisibility(this.visibility)
    this.subCalls.push(call)
    this.invalidate()
  }

  /** Set this call tree's visibility state. */
  setVisibility(visibility: ToolCardVisibility): void {
    if (this.visibility === visibility) return
    this.visibility = visibility
    for (const child of this.subCalls) child.setVisibility(visibility)
    this.invalidate()
  }

  invalidate(): void {
    this.renderCache = undefined
    this.parent?.invalidate()
  }

  render(width: number): string[] {
    const cacheKey = `${width}|${this.visibility}|${this.result?.status ?? ''}|${this.subCalls.length}`
    const cached = cachedRender(this.renderCache, cacheKey, () => {
      const own = this.renderUncached(width)
      if (this.subCalls.length === 0) return own
      const childWidth = Math.max(1, width - 2)
      const children = this.subCalls.flatMap(child => child.render(childWidth)
        .map(line => line === '' ? '' : `  ${line}`))
      return [...own, ...children]
    })
    this.renderCache = cached.cache
    return cached.lines
  }

  private renderUncached(width: number): string[] {
    const title = displayText(this.result?.view?.title ?? this.callView?.title ?? toolLabel(this.name))
    if (this.result === undefined) {
      const header = `${this.palette.warning('')} ${this.palette.toolTitle(title)}`
      if (this.visibility === 'collapsed') {
        return ['', this.summaryRow(width, header, 'expand')]
      }
      const rows = ['', this.summaryRow(width, header, 'collapse')]
      const detail = this.compactDetail()
      if (detail !== undefined) {
        for (const line of detail.split('\n').flatMap(line => wrapToWidth(line, Math.max(1, width - 4)))) {
          rows.push(truncateToWidth(`  ${this.palette.muted(line)}`, Math.max(1, width - 2), ''))
        }
      }
      return rows
    }

    const statusColor = this.result.status === 'completed'
      ? this.palette.success
      : this.result.status === 'interrupted' ? this.palette.warning : this.palette.error
    const glyph = this.result.status === 'completed' ? '✓' : this.result.status === 'interrupted' ? '■' : ''
    const header = `${statusColor(glyph)} ${this.palette.toolTitle(title)}`
    if (this.visibility === 'collapsed') {
      return ['', this.summaryRow(width, header, 'expand')]
    }
    const output = displayText(contentText(this.result.content).trim())
    const outputLines = output === ''
      ? [this.palette.dim('(no output)')]
      : output.split('\n')
        .flatMap(line => wrapToWidth(line, Math.max(1, width - 4)))
        .map(line => this.palette.toolOutput(line))
    const sections: { title: string; lines: string[] }[] = []
    const presentedDiff = this.result.status !== 'completed'
      ? []
      : diffViewSections(this.result.view ?? this.callView, this.palette, width)
    const editorSections = presentedDiff.length > 0
      ? []
      : this.name === 'str_replace_editor'
        ? strReplaceEditorSections(this.argumentsJson, this.palette, width)
        : []
    const patchSections = presentedDiff.length > 0 || this.name !== 'apply_patch'
      ? []
      : applyPatchSections(this.patchFiles(), this.palette, width)
    if (presentedDiff.length > 0) {
      sections.push(...presentedDiff)
    } else if (patchSections.length > 0) {
      sections.push(...patchSections)
    } else if (editorSections.length > 0) {
      sections.push(...editorSections)
    } else {
      const detail = callViewDetail(this.callView) ?? toolDetail(this.name, this.argumentsJson)
      if (detail !== undefined && !this.detailFitsSummary(width, header, detail)) {
        const inputLines = detail
          .split('\n')
          .flatMap(line => wrapToWidth(line, Math.max(1, width - 4)))
          .map(line => this.palette.muted(line))
        sections.push({ title: 'Input', lines: inputLines })
      }
    }
    sections.push({ title: 'Output', lines: outputLines })
    return [
      '',
      this.summaryRow(width, header, 'collapse'),
      ...this.expandedSectionRows(sections),
    ]
  }

  /** Present expanded content as ordinary transcript text, without card chrome. */
  private expandedSectionRows(sections: readonly { title: string; lines: readonly string[] }[]): string[] {
    const rows: string[] = []
    for (const section of sections) {
      if (rows.length > 0 || section.title !== 'Input') rows.push('')
      if (section.title === 'Input') {
        section.lines.forEach((line, index) => {
          rows.push(index === 0 ? `  ${this.palette.accent('›')} ${line}` : `    ${line}`)
        })
      } else {
        // Diff/Patch lines are already grouped and themed by their existing
        // presenters. Output retains the tool-output color in the same way.
        rows.push(...section.lines.map(line => `  ${line}`))
      }
    }
    return rows
  }

  /** Avoid repeating a single-line input that is already fully visible above. */
  private detailFitsSummary(width: number, header: string, detail: string): boolean {
    if (detail.includes('\n')) return false
    const outputSize = this.compactOutputSize()
    const summary = [
      header,
      this.palette.muted(`· ${detail}`),
      outputSize === undefined ? undefined : this.palette.dim(`· ${outputSize}`),
    ].filter((part): part is string => part !== undefined).join(' ')
    const hint = this.palette.dim(' · (Ctrl+O to collapse)')
    const available = Math.max(1, width)
    return visibleWidth(hint) < available
      && visibleWidth(summary) <= available - visibleWidth(hint)
  }

  /** Keep one stable summary row as the visual anchor in both visibility states. */
  private summaryRow(width: number, header: string, action: 'expand' | 'collapse'): string {
    const compactDetail = this.compactDetail()?.replace(/\n+/g, ' ')
    const outputSize = this.compactOutputSize()
    const summary = [
      header,
      compactDetail === undefined ? undefined : this.palette.muted(`· ${compactDetail}`),
      outputSize === undefined ? undefined : this.palette.dim(`· ${outputSize}`),
    ].filter((part): part is string => part !== undefined).join(' ')
    const hint = this.palette.dim(` · (Ctrl+O to ${action})`)
    const available = Math.max(1, width)
    if (visibleWidth(hint) >= available) return this.truncateSummary(summary, available)
    return `${this.truncateSummary(summary, available - visibleWidth(hint))}${hint}`
  }

  /** pi-tui appends an SGR reset when clipping, even for unstyled text. */
  private truncateSummary(summary: string, width: number): string {
    const clipped = truncateToWidth(summary, width, '')
    return summary.includes('\x1b') ? clipped : clipped.replace(/\x1b\[0m/g, '')
  }

  /** A bounded summary that never parses or sanitizes a large argument payload. */
  private compactDetail(): string | undefined {
    const viewDetail = compactCallViewDetail(this.result?.view ?? this.callView)
    if (viewDetail !== undefined) return viewDetail
    if (this.argumentsJson.length > COLLAPSED_TEXT_SCAN_LIMIT) {
      return `${formatCount(this.argumentsJson.length)} chars input`
    }
    return toolDetail(this.name, this.argumentsJson)
  }

  /** Summarize large output from block metadata without concatenating or splitting it. */
  private compactOutputSize(): string | undefined {
    if (this.result === undefined) return undefined
    if (this.result.content.length > COLLAPSED_BLOCK_SCAN_LIMIT) {
      return `${formatCount(this.result.content.length)} blocks output`
    }
    let characters = 0
    let textBlocks = 0
    for (const block of this.result.content) {
      if (block.type !== 'text' && block.type !== 'reasoning') continue
      characters += block.text.length
      textBlocks++
    }
    if (characters === 0) return undefined
    if (characters > COLLAPSED_TEXT_SCAN_LIMIT) return `${formatCount(characters)} chars output`
    const text = contentText(this.result.content)
    const lines = text === '' ? 0 : text.split('\n').length
    return lines > this.maxOutputLines ? `${lines} lines` : textBlocks > 1 ? `${textBlocks} blocks` : undefined
  }

  /** Parse raw patch syntax only after expansion and reuse the structural parse across widths. */
  private patchFiles(): readonly ParsedPatchFile[] {
    this.parsedPatchFiles ??= parseApplyPatch(this.argumentsJson)
    return this.parsedPatchFiles
  }
}

/** Ctrl+O toggles between a compact summary and the complete tool card. */
export type ToolCardVisibility = 'collapsed' | 'expanded'

export interface VisibilityCard {
  setVisibility(visibility: ToolCardVisibility): void
}

/** Register any transcript card controlled by the global Ctrl+O toggle. */
export function registerVisibilityCard<T extends VisibilityCard>(
  cards: Set<VisibilityCard>,
  card: T,
  visibility: ToolCardVisibility,
): T {
  card.setVisibility(visibility)
  cards.add(card)
  return card
}

/** Apply one global visibility state to every registered transcript card. */
export function applyCardVisibility(
  cards: Iterable<VisibilityCard>,
  visibility: ToolCardVisibility,
): void {
  for (const card of cards) card.setVisibility(visibility)
}

export function nextToolCardVisibility(visibility: ToolCardVisibility): ToolCardVisibility {
  return visibility === 'collapsed' ? 'expanded' : 'collapsed'
}

/**
 * A non-human prompt contribution (plugin/goal sources), framed so it cannot
 * be mistaken for the assistant's unframed italic reasoning prose.
 */
export class ContextCardComponent implements Component {
  private readonly fullLines: string[]
  private readonly title: string
  private visibility: ToolCardVisibility = 'collapsed'
  private renderCache: RenderCache | undefined

  constructor(
    label: string,
    text: string,
    private readonly maxOutputLines: number,
    private readonly palette: Palette,
    heading = 'Injected context',
  ) {
    this.fullLines = displayText(text).split('\n')
    this.title = `${palette.context(heading)} ${palette.dim(`· ${displayText(label)}`)}`
  }

  setVisibility(visibility: ToolCardVisibility): void {
    if (this.visibility === visibility) return
    this.visibility = visibility
    this.renderCache = undefined
  }

  invalidate(): void {
    this.renderCache = undefined
  }

  render(width: number): string[] {
    const cacheKey = `${width}|${this.visibility}`
    const cached = cachedRender(this.renderCache, cacheKey, () => {
      let linesToRender: string[]
      let truncated = false
      if (this.visibility === 'collapsed' && this.fullLines.length > this.maxOutputLines) {
        const hidden = this.fullLines.length - this.maxOutputLines
        linesToRender = [...this.fullLines.slice(0, this.maxOutputLines), `… +${hidden} lines (Ctrl+O to expand)`]
        truncated = true
      } else {
        linesToRender = this.fullLines
      }
      const body = new Text(linesToRender.map((line, index) =>
        truncated && index >= this.maxOutputLines ? this.palette.dim(line) : this.palette.muted(line)).join('\n'), 0, 0)
      const rows = body.render(Math.max(1, width - 4))
      return frameBlock(rows, width, this.palette.borderMuted, this.palette.toolPendingBg, this.title)
    })
    this.renderCache = cached.cache
    return cached.lines
  }
}

/** A static framed block of pre-rendered rows (e.g. the `/palette` listing). */
export class StaticCardComponent implements Component {
  private renderCache: RenderCache | undefined

  constructor(
    private readonly rows: readonly string[],
    private readonly palette: Palette,
  ) {}

  invalidate(): void {
    this.renderCache = undefined
  }

  render(width: number): string[] {
    const cached = cachedRender(this.renderCache, String(width), () =>
      ['', ...frameBlock(this.rows, width, this.palette.borderMuted, this.palette.toolSuccessBg)])
    this.renderCache = cached.cache
    return cached.lines
  }
}

/**
 * The plan/todo panel rendered above the status line: the current goal plus
 * the whole-list `todo/write` snapshot, omp `Plan` style. Renders nothing
 * while there is neither a goal nor any todo.
 */
/** A child subagent descriptor shown above the transcript. */
export interface SubagentDescriptor {
  readonly id?: string
  readonly label?: string
  readonly provider: string
  readonly mode: 'one-shot' | 'continuable'
  readonly status?: 'idle' | 'running'
}

export interface BackgroundJobDescriptor {
  readonly id: string
  readonly kind?: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly startedAt?: number
  readonly finishedAt?: number
}

export type BackgroundTaskSelection =
  | { readonly kind: 'subagent'; readonly descriptor: SubagentDescriptor }
  | { readonly kind: 'job'; readonly descriptor: BackgroundJobDescriptor }

export interface BackgroundTaskViewContext {
  readonly kind: 'subagent' | 'job'
  readonly label: string
}

/** One-line notice for older transcript entries that are currently folded. */
export class TranscriptFoldNoticeComponent implements Component {
  constructor(
    private readonly resolveFolded: () => number,
    private readonly palette: Palette,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const folded = this.resolveFolded()
    if (folded <= 0) return []
    const line = this.palette.dim(`… 已折叠更早的 ${folded} 条记录`)
    return [truncateToWidth(line, Math.max(1, width), '')]
  }
}

/**
 * Compact live-subagent hint above the status line. Down expands the direct-child
 * list and Left returns to the main-agent view without changing foreground input.
 */
export class SubagentPanelComponent implements Component {
  private descriptors: readonly SubagentDescriptor[] = []
  private jobs: readonly BackgroundJobDescriptor[] = []
  private expanded = false
  private selectedIndex = 0
  private viewing: BackgroundTaskViewContext | undefined
  private renderCache: RenderCache | undefined

  constructor(private readonly palette: Palette) {}

  invalidate(): void {
    this.renderCache = undefined
  }

  add(descriptor: SubagentDescriptor): void {
    this.descriptors = [...this.descriptors, descriptor]
    this.renderCache = undefined
  }

  set(descriptors: readonly SubagentDescriptor[]): void {
    this.descriptors = [...descriptors]
    if (!this.hasEntries()) this.expanded = false
    this.clampSelection()
    this.renderCache = undefined
  }

  setJobs(jobs: readonly BackgroundJobDescriptor[]): void {
    this.jobs = [...jobs]
    if (!this.hasEntries()) this.expanded = false
    this.clampSelection()
    this.renderCache = undefined
  }

  hasEntries(): boolean {
    return this.descriptors.length + this.jobs.length > 0
  }

  isExpanded(): boolean {
    return this.expanded
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded || (expanded && !this.hasEntries())) return
    this.expanded = expanded
    this.renderCache = undefined
  }

  setViewing(viewing: BackgroundTaskViewContext | undefined): void {
    this.viewing = viewing
    this.renderCache = undefined
  }

  moveSelection(delta: -1 | 1): void {
    const count = this.descriptors.length + this.jobs.length
    if (!this.expanded || count === 0) return
    this.selectedIndex = (this.selectedIndex + delta + count) % count
    this.renderCache = undefined
  }

  isFirstSelected(): boolean {
    return this.selectedIndex === 0
  }

  selected(): BackgroundTaskSelection | undefined {
    const descriptor = this.descriptors[this.selectedIndex]
    if (descriptor !== undefined) return { kind: 'subagent', descriptor }
    const job = this.jobs[this.selectedIndex - this.descriptors.length]
    return job === undefined ? undefined : { kind: 'job', descriptor: job }
  }

  private clampSelection(): void {
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.descriptors.length + this.jobs.length - 1))
  }

  clear(): void {
    this.descriptors = []
    this.jobs = []
    this.expanded = false
    this.selectedIndex = 0
    this.renderCache = undefined
  }

  render(width: number): string[] {
    const cacheKey = `${width}|${this.expanded}|${this.selectedIndex}|${this.viewing?.kind ?? ''}:${this.viewing?.label ?? ''}|${this.descriptors.map(descriptor => `${descriptor.id ?? ''}:${descriptor.label ?? descriptor.provider}:${descriptor.status ?? ''}`).join('\u0000')}|${this.jobs.map(job => `${job.id}:${job.status}:${job.label}`).join('\u0000')}`
    const cached = cachedRender(this.renderCache, cacheKey, () => this.renderUncached(width))
    this.renderCache = cached.cache
    return cached.lines
  }

  private renderUncached(width: number): string[] {
    if (!this.hasEntries()) return []
    const sidePadding = '  '
    const innerWidth = Math.max(1, width - visibleWidth(sidePadding) * 2)
    const inset = (line: string): string => `${sidePadding}${truncateToWidth(line, innerWidth, '')}`
    const selectedRow = (line: string): string => {
      const clipped = truncateToWidth(line, innerWidth, '')
      const padded = clipped + ' '.repeat(Math.max(0, innerWidth - visibleWidth(clipped)))
      return `${sidePadding}${this.palette.toolPendingBg(this.palette.text(padded))}${sidePadding}`
    }
    const agentRunning = this.descriptors.filter(descriptor => descriptor.status === 'running').length
    const agentIdle = this.descriptors.filter(descriptor => descriptor.status === 'idle').length
    const jobsRunning = this.jobs.filter(job => job.status === 'running').length
    const jobsStopping = this.jobs.filter(job => job.status === 'stopping').length
    const jobsSettled = this.jobs.length - jobsRunning - jobsStopping
    if (!this.expanded) {
      if (this.viewing !== undefined) {
        const kind = this.viewing.kind === 'subagent' ? 'SUBAGENT' : 'JOB'
        return [inset(`${this.palette.bold(this.palette.accent(kind))} · ${this.palette.text(this.viewing.label)} · ${this.palette.muted('Esc/← Main · ↓ Switch')}`)]
      }
      const groups = [
        this.descriptors.length === 0 ? undefined : `agents ● ${agentRunning} running ○ ${agentIdle} idle`,
        this.jobs.length === 0 ? undefined : `jobs ● ${jobsRunning} running ◐ ${jobsStopping} stopping ✓ ${jobsSettled} settled`,
      ].filter((group): group is string => group !== undefined)
      return [inset(this.palette.muted(`${groups.join(' · ')} · ↓ select`))]
    }
    const title = this.viewing === undefined
      ? 'Background tasks'
      : `${this.viewing.kind === 'subagent' ? 'SUBAGENT' : 'JOB'} · ${this.viewing.label}`
    const lines = [inset(this.palette.bold(this.palette.accent(title))), inset(this.palette.dim('↑↓ select · Enter open · Esc/← Main'))]
    let itemIndex = 0
    if (this.descriptors.length > 0) {
      lines.push(inset(this.palette.accent('Subagents')))
      this.descriptors.forEach((descriptor, index) => {
        const branch = index === this.descriptors.length - 1 ? '└─' : '├─'
        const name = descriptor.label ?? descriptor.provider
        const status = descriptor.status === undefined ? '' : ` · ${descriptor.status}`
        const line = `${branch} ${name} · ${descriptor.mode}${status}`
        lines.push(itemIndex++ === this.selectedIndex ? selectedRow(line) : inset(this.palette.muted(line)))
      })
    }
    if (this.jobs.length > 0) {
      lines.push(inset(this.palette.accent('Jobs')))
      this.jobs.forEach((job, index) => {
        const branch = index === this.jobs.length - 1 ? '└─' : '├─'
        const line = `${branch} ${job.id} · ${job.status} · ${job.label}`
        lines.push(itemIndex++ === this.selectedIndex ? selectedRow(line) : inset(this.palette.muted(line)))
      })
    }
    return lines.map(line => truncateToWidth(line, Math.max(1, width), ''))
  }
}

/** Whole-view projection for a background job without consuming its output cursor. */
export class BackgroundJobViewComponent implements Component {
  private job: BackgroundJobDescriptor | undefined

  constructor(private readonly palette: Palette) {}

  set(job: BackgroundJobDescriptor | undefined): void {
    this.job = job
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.job === undefined) return [this.palette.warning('Background job is no longer available')]
    const job = this.job
    const lines = [
      this.palette.bold(this.palette.accent('Background job')),
      '',
      this.palette.text(job.label),
      this.palette.muted(`${job.id}${job.kind === undefined ? '' : ` · ${job.kind}`} · ${job.status}`),
    ]
    if (job.detail !== undefined && job.detail !== '') lines.push('', this.palette.dim(job.detail))
    lines.push('', this.palette.dim('Live output remains reserved for the job reader.'), this.palette.dim('Esc or ← returns to the main agent.'))
    return lines.map(line => truncateToWidth(line, Math.max(1, width), ''))
  }
}

export class TodoPanelComponent implements Component {
  private todos: readonly TodoItem[] = []
  private goal: { readonly objective: string; readonly phase: string } | undefined
  private renderCache: RenderCache | undefined

  constructor(private readonly palette: Palette) {}

  invalidate(): void {
    this.renderCache = undefined
  }

  /** Replace the whole todo list (last `todo/write` wins). */
  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos
    this.renderCache = undefined
  }

  /** Replace the current goal snapshot, or clear it. */
  setGoal(goal: { readonly objective: string; readonly phase: string } | undefined): void {
    this.goal = goal
    this.renderCache = undefined
  }

  render(width: number): string[] {
    const cacheKey = `${width}|${this.todos.length}|${this.goal?.phase ?? ''}|${this.goal?.objective ?? ''}`
    const cached = cachedRender(this.renderCache, cacheKey, () => this.renderUncached(width))
    this.renderCache = cached.cache
    return cached.lines
  }

  private renderUncached(width: number): string[] {
    if (this.todos.length === 0 && this.goal === undefined) return []

    const completed = this.todos.filter(todo => todo.status === 'completed').length
    const progress = this.todos.length === 0 ? '' : this.palette.dim(`  ${completed}/${this.todos.length}`)
    const rail = this.palette.borderMuted('│')
    const lines: string[] = [
      `  ${this.palette.borderMuted('╭─')} ${this.palette.bold(this.palette.accent(' Plan'))}${progress}`,
    ]

    if (this.goal !== undefined) {
      lines.push(`  ${rail} ${this.palette.dim(`Goal · ${this.goal.phase}: ${displayText(this.goal.objective)}`)}`)
    }
    for (const todo of this.todos) {
      const mark = todo.status === 'completed' ? '󰄲' : todo.status === 'in_progress' ? '' : ''
      const color = todo.status === 'completed'
        ? this.palette.dim
        : todo.status === 'in_progress' ? this.palette.accent : this.palette.text
      lines.push(`  ${rail} ${color(`${mark} ${displayText(todo.content)}`)}`)
    }
    lines.push(`  ${this.palette.borderMuted('╰─')}`)

    return lines.map(line => truncateToWidth(line, Math.max(1, width), ''))
  }
}
