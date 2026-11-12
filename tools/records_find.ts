import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ToolDefinition } from 'loopengine'

// ---- Shared helpers --------------------------------------------------
// Duplicated verbatim across every tool file in this ability: add-ability
// copies each tool file standalone, with no shared-module support, so
// this block is the contract between them. Keep the copies identical.
//
// Each list is one JSON file, agents/<agent>/records/<list>.json (from
// the project folder the server runs in), holding an array of records.
// Every record gets an `id` and an `added_at` time. Writes go to a
// temporary file that's then renamed over the list, so a crash never
// leaves half a file, and changes to one list wait for each other (one
// lock per list, shared by every tool file in the process).
const MAX_RECORDS = 10_000
const MAX_RECORD_BYTES = 10_000

type StoredRecord = { id: string; added_at: string } & Record<string, unknown>

function listName(action: string, value: unknown): string {
  const name = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`${action}: list must be a name of letters, digits, - and _ (up to 64), e.g. "punch-ins"`)
  }
  return name
}

function recordsDir(agentName: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(agentName)) throw new Error(`records: unexpected agent name "${agentName}"`)
  return join(process.cwd(), 'agents', agentName, 'records')
}

function readList(agentName: string, list: string): StoredRecord[] {
  const file = join(recordsDir(agentName), `${list}.json`)
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error(`records: ${file} isn't a list of records`)
  return parsed as StoredRecord[]
}

function writeList(agentName: string, list: string, records: StoredRecord[]): void {
  const dir = recordsDir(agentName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${list}.json`)
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`)
  renameSync(temp, file)
}

function listNames(agentName: string): string[] {
  const dir = recordsDir(agentName)
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort()
  } catch {
    return []
  }
}

// One queue per list, on globalThis so the separately loaded tool files
// share it.
const LOCKS_KEY = Symbol.for('loopengine-records.locks')
const locks: Map<string, Promise<unknown>> = ((globalThis as Record<symbol, unknown>)[LOCKS_KEY] as Map<string, Promise<unknown>> | undefined) ??
  ((globalThis as Record<symbol, unknown>)[LOCKS_KEY] = new Map<string, Promise<unknown>>())

async function withList<T>(agentName: string, list: string, change: () => T): Promise<T> {
  const key = `${agentName}/${list}`
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(change)
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

// `where`: field -> value (equal) or a list of values (any of them).
function matches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, wanted]) => {
    const value = record[field]
    return Array.isArray(wanted) ? wanted.some((w) => sameValue(value, w)) : sameValue(value, wanted)
  })
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b))
}

function whereOf(action: string, value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${action}: where must be an object of field: value, e.g. {"date": "2026-11-12"}`)
  return value as Record<string, unknown>
}
// ---- End of shared helpers -------------------------------------------

export const recordsFind: ToolDefinition = {
  name: 'records_find',
  description:
    'Find records in a list: those whose fields equal the values in where (a list of values matches any of them), and, with range, those whose field is between from and to (compared as text, so ISO dates like "2026-11-01" work). Newest first. Returns how many match and the records. With no where or range, the latest records. records_lists shows the lists there are.',
  input_schema: {
    type: 'object',
    properties: {
      list: { type: 'string', description: 'The list\'s name.' },
      where: { type: 'object', description: 'Field: value to match, e.g. {"date": "2026-11-12"} or {"person": ["Alice", "Bob"]}.' },
      range: {
        type: 'object',
        description: 'A field between two values, inclusive, e.g. {"field": "date", "from": "2026-11-01", "to": "2026-11-30"}. Either end can be left out.',
        properties: { field: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
        required: ['field'],
      },
      max_results: { type: 'number', description: 'How many records to return, 1 to 1000. Default 100.' },
      oldest_first: { type: 'boolean', description: 'Oldest first instead of newest first.' },
    },
    required: ['list'],
  },
  execute: async (input, ctx) => {
    const action = 'records_find'
    const list = listName(action, input.list)
    const where = whereOf(action, input.where)
    const range = input.range && typeof input.range === 'object' ? (input.range as { field?: unknown; from?: unknown; to?: unknown }) : undefined
    if (range && !range.field) throw new Error(`${action}: range needs a field`)
    const inRange = (r: Record<string, unknown>) => {
      if (!range) return true
      const value = r[String(range.field)]
      if (value === undefined || value === null) return false
      const text = String(value)
      return (range.from === undefined || text >= String(range.from)) && (range.to === undefined || text <= String(range.to))
    }
    const found = readList(ctx.agentName, list).filter((r) => matches(r, where) && inRange(r))
    if (!input.oldest_first) found.reverse()
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(input.max_results) || 100)))
    return JSON.stringify({ list, matched: found.length, records: found.slice(0, limit) })
  },
  safe: true,
}
