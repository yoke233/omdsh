import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'

/** Events proving that a session contains model-facing conversation data. */
const CONVERSATION_EVENT_TYPES: Readonly<Record<string, true>> = {
  'user/message': true,
  'assistant/message': true,
  'tool/call': true,
}

/** Whether a session has crossed the blank-session boundary. */
export function hasConversationData(events: readonly SessionEvent[]): boolean {
  return events.some(event => CONVERSATION_EVENT_TYPES[event.type] === true)
}

export interface SessionSubagent {
  readonly id?: string
  readonly label?: string
  readonly provider: string
  readonly mode: 'one-shot' | 'continuable'
  readonly status?: 'idle' | 'running'
}

export interface SessionViewState {
  readonly todos: readonly TodoItem[]
  readonly goal: { readonly objective: string; readonly phase: string } | undefined
  readonly tokenTotals: { readonly inputTokens: number; readonly outputTokens: number }
  readonly subagents: readonly SessionSubagent[]
}

/** Validate the optional subagent event extension before rendering it. */
export function sessionSubagent(event: SessionEvent): SessionSubagent | undefined {
  const candidate: unknown = event
  if (typeof candidate !== 'object' || candidate === null
    || !('type' in candidate) || candidate.type !== 'subagent/descriptor'
    || !('data' in candidate) || typeof candidate.data !== 'object' || candidate.data === null) return undefined
  const label = 'label' in candidate.data ? candidate.data.label : undefined
  const provider = 'provider' in candidate.data ? candidate.data.provider : undefined
  const mode = 'mode' in candidate.data ? candidate.data.mode : undefined
  if (label !== undefined && typeof label !== 'string') return undefined
  if (provider !== undefined && typeof provider !== 'string') return undefined
  if (mode !== undefined && mode !== 'one-shot' && mode !== 'continuable') return undefined
  return {
    ...(label === undefined ? {} : { label }),
    provider: provider ?? 'subagent',
    mode: mode ?? 'one-shot',
  }
}

interface SubagentDescriptorCursor {
  nextIndex: number
  descriptor?: SessionSubagent
}

const subagentDescriptorCursors = new WeakMap<Session, SubagentDescriptorCursor>()

/** Scan each live child session's append-only suffix once instead of once per event from every agent. */
function liveSubagentDescriptor(session: Session): SessionSubagent | undefined {
  const events = session.snapshotEvents()
  const suffixStart = session.inheritedEventCount
  let cursor = subagentDescriptorCursors.get(session)
  if (cursor === undefined || cursor.nextIndex < suffixStart || cursor.nextIndex > events.length) {
    cursor = { nextIndex: suffixStart }
    subagentDescriptorCursors.set(session, cursor)
  }
  if (cursor.descriptor !== undefined) return cursor.descriptor

  for (let index = cursor.nextIndex; index < events.length; index++) {
    const descriptor = sessionSubagent(events[index]!)
    if (descriptor === undefined) continue
    cursor.descriptor = descriptor
    cursor.nextIndex = index + 1
    return descriptor
  }
  cursor.nextIndex = events.length
  return undefined
}

/** Project direct, currently live child agents for the main-screen navigator. */
export function liveChildSubagents(agents: readonly Agent[], parentId: SessionId): SessionSubagent[] {
  return agents
    .filter(candidate => candidate.session.header.parentSession === parentId
      && candidate.session.header.origin === 'subagent')
    .sort((left, right) => left.session.header.createdAt - right.session.header.createdAt
      || String(left.id).localeCompare(String(right.id)))
    .map(candidate => {
      const descriptor = liveSubagentDescriptor(candidate.session)
      const provider = descriptor?.provider === undefined || descriptor.provider === 'subagent'
        ? candidate.options.provider ?? 'subagent'
        : descriptor.provider
      return {
        id: String(candidate.id),
        ...(descriptor?.label === undefined ? {} : { label: descriptor.label }),
        provider,
        mode: descriptor?.mode ?? 'one-shot',
        status: candidate.status,
      }
    })
}

/** Fold session-owned UI projections independently from the visible transcript window. */
export function foldSessionView(events: readonly SessionEvent[]): SessionViewState {
  let todos: readonly TodoItem[] = []
  let goal: SessionViewState['goal']
  let inputTokens = 0
  let outputTokens = 0
  const subagents: SessionViewState['subagents'][number][] = []
  for (const event of events) {
    if (event.type === 'todo/write') {
      todos = event.data.todos
    } else if (event.type === 'goal/change') {
      goal = event.data.operation === 'clear'
        ? undefined
        : { objective: event.data.goal.objective, phase: event.data.goal.phase }
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      inputTokens += event.data.usage.inputTokens
      outputTokens += event.data.usage.outputTokens
    } else {
      const descriptor = sessionSubagent(event)
      if (descriptor !== undefined) subagents.push(descriptor)
    }
  }
  return { todos, goal, tokenTotals: { inputTokens, outputTokens }, subagents }
}

/**
 * Persist a runtime preset immediately before the first user message. Keeping
 * this out of blank-session setup preserves the persistence backend's lazy
 * materialization contract: an abandoned session leaves no artifact.
 */
export function recordConversationPreset(session: Session, preset: string, recordedPreset: string | undefined): void {
  if (recordedPreset === preset) return
  session.append('agent-preset/selected', { agentPreset: preset })
}
