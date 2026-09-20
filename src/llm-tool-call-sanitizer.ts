import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'llm-tool-call-sanitizer'

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** Make empty tool-call delta ids/names harmless before the LLM assembler sees them. */
export function sanitizeToolCallChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type === 'tool-call-delta') {
    const id = nonEmptyString(chunk.id, `call-${chunk.index}`)
    const name = nonEmptyString(chunk.name, 'unknown')
    if (id === chunk.id && name === chunk.name) return chunk
    return { ...chunk, id: ToolCallId(id), name } as StreamChunk
  }

  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    const block = chunk.block
    const id = nonEmptyString(block.id, `call-${chunk.index}`)
    const name = nonEmptyString(block.name, 'unknown')
    if (id === block.id && name === block.name) return chunk
    return {
      ...chunk,
      block: { ...block, id: ToolCallId(id), name },
    } as StreamChunk
  }

  return chunk
}

async function* sanitizeToolCallDeltaStream(source: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of source) yield sanitizeToolCallChunk(chunk)
}


export function apply(ctx: Context): void {
  ctx.on('llm/stream', (_options, next) => sanitizeToolCallDeltaStream(next()), { global: true })
}
