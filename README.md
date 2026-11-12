# @loopengine-co/records

A [loopengine](https://github.com/loopengine-co/loopengine) ability:
named lists of records an agent keeps between runs (punch-ins, a daily
pick, what's already been done), with tools to add, find and remove
records, plus a skill on keeping them tidy. Removing records asks a
person first by default. No settings or accounts needed.

```sh
npx loopengine add-ability @loopengine-co/records --agent <your-agent>
```

## What's in it

- **Tools**
  - `records_add(list, records, unique_by?)`: saves one or more records
    (objects of fields) to a list, created on first use. Each gets an
    `id` and an `added_at` time. `unique_by` names fields that must not
    repeat, e.g. `["date", "person"]`: a repeat is skipped and reported
    with the existing record's id.
  - `records_find(list, where?, range?, max_results?, oldest_first?)`:
    records whose fields equal `where` (a list of values matches any),
    and whose `range.field` is between `from` and `to` (compared as text,
    so ISO dates work). Newest first.
  - `records_remove(list, ids? | where?)`: removes records by id or by
    fields, and returns them. Never empties a list without either.
  - `records_lists()`: the agent's lists, with record counts and when
    each last changed.
- **Skill**: `keeping-records`: consistent fields and dates, `unique_by`
  for one-per-day rules, and answering from the records, not memory.
- **actauth rules**: adding, finding and listing are `allow`; removing is
  `ask`.

## Example: a daily verse

Two lists. Each morning a scheduled workflow finds the verses already
used, picks a new one and saves it:

```json
records_add {"list": "verses", "records": [{"date": "2026-11-12", "reference": "Philippians 4:13", "text": "I can do all things through Christ which strengtheneth me."}], "unique_by": ["date"]}
```

When someone in the group says they've memorised it:

```json
records_add {"list": "memorised", "records": [{"date": "2026-11-12", "person": "Alice", "reference": "Philippians 4:13", "time": "08:40"}], "unique_by": ["date", "person"]}
```

And in the evening's report:

```json
records_find {"list": "memorised", "where": {"date": "2026-11-12"}}
```

## Where records are kept

Each list is a JSON file, `agents/<agent>/records/<list>.json`, in the
project the server runs from (on LoopEngine Cloud, the workspace's
volume, so it survives restarts and upgrades). Each agent has its own
lists. Writes replace the file in one step, and changes to a list wait
for each other, so records aren't lost when two people write at once.

A list holds up to 10,000 records, each up to 10,000 characters.

## Permissions

| Tool | Default | Why |
| --- | --- | --- |
| `records_add`, `records_find`, `records_lists` | allow | Only the agent's own lists |
| `records_remove` | ask | Deletes what people recorded |

Change these in the agent's Permissions tab.
