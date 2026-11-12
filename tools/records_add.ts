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

export const recordsAdd: ToolDefinition = {
  name: 'records_add',
  description:
    'Save one or more records to a named list, e.g. today\'s verse to "verses", or a punch-in to "punch-ins". A record is an object of fields (text, numbers, true/false), such as {"date": "2026-11-12", "person": "Alice"}. Each gets an id and an added_at time. unique_by names fields that must not repeat: a record whose values for them match one already saved (or one earlier in the same call) is skipped and reported, e.g. unique_by ["date", "person"] for one punch-in per person per day. Lists are created on first use and kept between runs.',
  input_schema: {
    type: 'object',
    properties: {
      list: { type: 'string', description: 'The list\'s name: letters, digits, - and _, e.g. "punch-ins".' },
      records: { type: 'array', items: { type: 'object' }, description: 'The records to save, each an object of fields.' },
      unique_by: { type: 'array', items: { type: 'string' }, description: 'Fields whose values together must not repeat in the list.' },
    },
    required: ['list', 'records'],
  },
  execute: async (input, ctx) => {
    const action = 'records_add'
    const list = listName(action, input.list)
    const incoming = Array.isArray(input.records) ? input.records : input.records && typeof input.records === 'object' ? [input.records] : []
    if (!incoming.length) throw new Error(`${action}: records must be a list of one or more objects`)
    if (incoming.length > 500) throw new Error(`${action}: up to 500 records at a time`)
    const uniqueBy = Array.isArray(input.unique_by) ? input.unique_by.map(String).filter(Boolean) : []
    const fresh = incoming.map((r, i) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`${action}: record ${i + 1} isn't an object of fields`)
      const fields = Object.fromEntries(Object.entries(r as Record<string, unknown>).filter(([k]) => k !== 'id' && k !== 'added_at'))
      if (!Object.keys(fields).length) throw new Error(`${action}: record ${i + 1} has no fields`)
      if (JSON.stringify(fields).length > MAX_RECORD_BYTES) throw new Error(`${action}: record ${i + 1} is over ${MAX_RECORD_BYTES} characters`)
      for (const field of uniqueBy) if (!(field in fields)) throw new Error(`${action}: record ${i + 1} has no "${field}", which unique_by needs`)
      return fields
    })
    return withList(ctx.agentName, list, () => {
      const records = readList(ctx.agentName, list)
      const added: StoredRecord[] = []
      const skipped: { record: Record<string, unknown>; existing_id: string }[] = []
      for (const fields of fresh) {
        const key = Object.fromEntries(uniqueBy.map((f) => [f, fields[f]]))
        const existing = uniqueBy.length ? records.find((r) => matches(r, key)) : undefined
        if (existing) {
          skipped.push({ record: fields, existing_id: existing.id })
          continue
        }
        const record = { id: randomBytes(5).toString('hex'), added_at: new Date().toISOString(), ...fields } as StoredRecord
        records.push(record)
        added.push(record)
      }
      if (records.length > MAX_RECORDS) throw new Error(`${action}: "${list}" would hold over ${MAX_RECORDS} records; remove old ones first`)
      if (added.length) writeList(ctx.agentName, list, records)
      return JSON.stringify({ list, added, ...(skipped.length ? { skipped } : {}), total: records.length })
    })
  },
}
