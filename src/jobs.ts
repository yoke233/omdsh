/** Background-job command formatting and registry integration. */

import type { Context } from '@deepseek-ai/cordis'
import type { JobStatus, JobView } from '@deepseek-ai/dsh-jobs'
import { visibleWidth } from '@earendil-works/pi-tui'
import type {} from '@deepseek-ai/dsh-commands'
import type { Translator } from './i18n.ts'
import { displayInlineText } from './components/text.ts'

const LIVE_STATUSES: ReadonlySet<JobStatus> = new Set(['running', 'stopping'])

const STATUS_SYMBOL: Record<JobStatus, string> = {
  running: '●',
  stopping: '◐',
  completed: '✓',
  killed: '!',
  failed: '✗',
}

const STATUS_MESSAGE: Record<JobStatus, 'jobsStatusRunning' | 'jobsStatusStopping' | 'jobsStatusCompleted' | 'jobsStatusKilled' | 'jobsStatusFailed'> = {
  running: 'jobsStatusRunning',
  stopping: 'jobsStatusStopping',
  completed: 'jobsStatusCompleted',
  killed: 'jobsStatusKilled',
  failed: 'jobsStatusFailed',
}

export interface ActiveJobSummary {
  count: number
  stopping: boolean
}

/** Count jobs that have not reached a terminal state. */
export function summarizeActiveJobs(jobs: readonly JobView[]): ActiveJobSummary {
  let count = 0
  let stopping = false
  for (const job of jobs) {
    if (!LIVE_STATUSES.has(job.status)) continue
    count++
    if (job.status === 'stopping') stopping = true
  }
  return { count, stopping }
}

/** Live jobs first in start order, followed by the newest settled jobs. */
export function orderJobs(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const leftLive = LIVE_STATUSES.has(left.status)
    const rightLive = LIVE_STATUSES.has(right.status)
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    if (leftLive) return left.startedAt - right.startedAt || String(left.id).localeCompare(String(right.id))
    return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
      || String(left.id).localeCompare(String(right.id))
  })
}

/** Render elapsed time with at most two adjacent units. */
export function formatJobDuration(startedAt: number, finishedAt: number | undefined, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((finishedAt ?? now) - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function oneLine(value: string): string {
  return displayInlineText(value).replace(/\s+/g, ' ').trim()
}

function padEndVisible(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - visibleWidth(value)))
}

function padStartVisible(value: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleWidth(value))) + value
}

/** Format the complete /jobs result for direct TUI presentation. */
export function formatJobsList(jobs: readonly JobView[], t: Translator, now = Date.now()): string {
  if (jobs.length === 0) return t('jobsEmpty')

  const ordered = orderJobs(jobs)
  const active = summarizeActiveJobs(ordered)
  const rows = ordered.map(job => ({
    job,
    id: String(job.id),
    status: t(STATUS_MESSAGE[job.status]),
    duration: formatJobDuration(job.startedAt, job.finishedAt, now),
  }))
  const idWidth = Math.max(...rows.map(row => visibleWidth(row.id)))
  const statusWidth = Math.max(...rows.map(row => visibleWidth(row.status)))
  const durationWidth = Math.max(...rows.map(row => visibleWidth(row.duration)))
  const body = rows.map(({ job, id, status, duration }) => {
    const normalizedDetail = job.detail === undefined ? '' : oneLine(job.detail)
    const detail = normalizedDetail === '' ? '' : ` — ${normalizedDetail}`
    return `${STATUS_SYMBOL[job.status]} ${padEndVisible(id, idWidth)}  ${padEndVisible(status, statusWidth)}  ${padStartVisible(duration, durationWidth)}  ${oneLine(job.label)}${detail}`
  })
  return [t('jobsSummary', { active: active.count, total: ordered.length }), '', ...body].join('\n')
}

/** Register the human-facing command while keeping execution in the owner fence. */
export function registerJobsCommand(ctx: Context, t: Translator): () => void {
  return ctx.commands.register({
    name: 'jobs',
    description: t('cmdJobs'),
    recordInput: false,
    handler: (invocation) => {
      if (invocation.rawInput.trim() !== '') {
        return { kind: 'error', text: t('jobsUsage') }
      }
      return {
        kind: 'success',
        text: formatJobsList(ctx.jobs.list(invocation.agent.id), t),
      }
    },
  })
}
