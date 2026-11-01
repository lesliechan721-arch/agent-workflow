import path from 'node:path'

import fs from 'fs-extra'

const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024
const MAX_ROLLOUT_LINES = 100_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function selectedCodexSkillInstruction(event: unknown): {
  name: string
  path: string
} | null {
  if (!isRecord(event) || event.type !== 'response_item' || !isRecord(event.payload)) return null
  const payload = event.payload
  if (payload.type !== 'message' || payload.role !== 'user') return null
  const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : null
  if (!metadata || !Array.isArray(metadata.content_item_kinds)
    || !metadata.content_item_kinds.includes('skills.selected_skill_instructions')) return null
  if (!Array.isArray(payload.content)) return null
  const text = payload.content.filter(isRecord)
    .filter((entry) => entry.type === 'input_text' && typeof entry.text === 'string')
    .map((entry) => entry.text as string).join('\n').replaceAll('\\', '/')
  const name = text.match(/<name>([^/<>]+)<\/name>/u)?.[1]
  const skillPath = text.match(/<path>([^<>]+)<\/path>/u)?.[1]
  return name && skillPath ? { name, path: skillPath } : null
}

export async function readCodexEvalRollouts(codexHome: string): Promise<Array<{
  file: string
  events: Record<string, unknown>[]
}>> {
  const files: string[] = []
  async function visit(current: string): Promise<void> {
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error('Codex rollout tree contains a symbolic link.')
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && target.endsWith('.jsonl')) files.push(target)
      else if (entry.isSymbolicLink()) throw new Error('Codex rollout tree contains a symbolic link.')
    }
  }
  await visit(path.join(codexHome, 'sessions'))
  const records = []
  let totalBytes = 0
  let totalLines = 0
  for (const file of files.sort()) {
    const stat = await fs.lstat(file)
    if (!stat.isFile()) throw new Error('Codex rollout must be a regular file.')
    totalBytes += stat.size
    if (totalBytes > MAX_ROLLOUT_BYTES) throw new Error('Codex rollout evidence is too large.')
    const bytes = await fs.readFile(file)
    if (bytes.length !== stat.size) throw new Error('Codex rollout changed during evidence collection.')
    const lines = bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '')
    totalLines += lines.length
    if (totalLines > MAX_ROLLOUT_LINES) throw new Error('Codex rollout evidence has too many events.')
    const events = lines.map((line, index) => {
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        throw new Error(`Codex rollout contains invalid JSON at line ${index + 1}.`)
      }
      if (!isRecord(value)) throw new Error(`Codex rollout event ${index + 1} must be an object.`)
      return value
    })
    records.push({ file, events })
  }
  return records
}
