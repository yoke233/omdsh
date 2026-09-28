import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { createTranslator } from '../src/i18n.ts'
import {
  formatJobDuration,
  formatJobsList,
  orderJobs,
  registerJobsCommand,
  summarizeActiveJobs,
} from '../src/jobs.ts'

const t = createTranslator('en')

function snapshot(overrides: Partial<JobView> & Pick<JobView, 'id' | 'status' | 'startedAt'>): JobView {
  return {
    kind: 'pwsh',
    label: String(overrides.id),
    output: { total: 0, earliest: 0 },
    ...overrides,
  } as JobView
}

describe('/jobs support', () => {
  it('counts running and stopping jobs as active', () => {
    const jobs = [
      snapshot({ id: 'pwsh-1' as JobView['id'], status: 'running', startedAt: 1 }),
      snapshot({ id: 'pwsh-2' as JobView['id'], status: 'stopping', startedAt: 2 }),
      snapshot({ id: 'pwsh-3' as JobView['id'], status: 'completed', startedAt: 3, finishedAt: 4 }),
    ]
    assert.deepEqual(summarizeActiveJobs(jobs), { count: 2, stopping: true })
    assert.deepEqual(summarizeActiveJobs(jobs.slice(2)), { count: 0, stopping: false })
  })

  it('orders live jobs oldest-first and settled jobs newest-first', () => {
    const jobs = [
      snapshot({ id: 'pwsh-4' as JobView['id'], status: 'failed', startedAt: 4, finishedAt: 40 }),
      snapshot({ id: 'pwsh-2' as JobView['id'], status: 'running', startedAt: 20 }),
      snapshot({ id: 'pwsh-3' as JobView['id'], status: 'completed', startedAt: 3, finishedAt: 50 }),
      snapshot({ id: 'pwsh-1' as JobView['id'], status: 'stopping', startedAt: 10 }),
    ]
    assert.deepEqual(orderJobs(jobs).map(job => String(job.id)), ['pwsh-1', 'pwsh-2', 'pwsh-3', 'pwsh-4'])
  })

  it('formats durations at adjacent unit boundaries', () => {
    assert.equal(formatJobDuration(0, 59_999), '59s')
    assert.equal(formatJobDuration(0, 61_000), '1m 1s')
    assert.equal(formatJobDuration(0, 3_661_000), '1h 1m')
    assert.equal(formatJobDuration(0, 90_061_000), '1d 1h')
    assert.equal(formatJobDuration(5_000, 1_000), '0s')
  })

  it('formats all statuses and sanitizes labels and details', () => {
    const now = 100_000
    const statuses: JobView['status'][] = ['running', 'stopping', 'completed', 'killed', 'failed']
    const jobs = statuses.map((status, index) => snapshot({
      id: `pwsh-${index + 1}` as JobView['id'],
      status,
      startedAt: index * 1_000,
      finishedAt: status === 'running' || status === 'stopping' ? undefined : now - index * 1_000,
      label: index === 0 ? 'unsafe\nlabel\u001b[31m' : `job ${index + 1}`,
      detail: index === 4 ? 'exit\ncode 1' : undefined,
    }))
    const text = formatJobsList(jobs, t, now)
    assert.ok(text.includes('Background jobs (2 running, 5 total)'))
    assert.match(text, /● pwsh-1  running/)
    assert.match(text, /◐ pwsh-2  stopping/)
    assert.match(text, /✓ pwsh-3  completed/)
    assert.match(text, /! pwsh-4  cancelled/)
    assert.match(text, /✗ pwsh-5  failed/)
    assert.match(text, /unsafe label/)
    assert.doesNotMatch(text, /\u001b|\nlabel/)
    assert.match(text, /exit code 1/)
    assert.equal(formatJobsList([], t, now), 'No background jobs.')
  })

  it('registers an owner-scoped command and returns its exact disposer', () => {
    let definition: CommandDefinition | undefined
    let caller: SessionIdType | undefined
    let disposed = false
    const owner = { id: SessionId('jobs-owner') } as Agent
    const ctx = {
      commands: {
        register(value: CommandDefinition) {
          definition = value
          return () => { disposed = true }
        },
      },
      jobs: {
        list(value: SessionIdType) {
          caller = value
          return []
        },
      },
    } as unknown as Context

    const dispose = registerJobsCommand(ctx, t)
    assert.equal(definition?.name, 'jobs')
    const result = definition!.handler({ agent: owner, rawInput: '', attachments: [], signal: new AbortController().signal } as never)
    assert.deepEqual(result, { kind: 'success', text: 'No background jobs.' })
    assert.equal(caller, owner.id)
    assert.deepEqual(definition!.handler({ agent: owner, rawInput: ' all', attachments: [], signal: new AbortController().signal } as never), {
      kind: 'error',
      text: 'Usage: /jobs',
    })
    dispose()
    assert.equal(disposed, true)
  })
})
