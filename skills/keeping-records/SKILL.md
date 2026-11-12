---
name: keeping-records
description: How to use the @loopengine-co/records tools to keep lists that last between runs (punch-ins, daily picks, what's already been done), with consistent fields, no duplicates, and answers drawn from the records rather than memory.
---

# Keeping records

The @loopengine-co/records tools keep named lists of records for this
agent, saved between runs and conversations. Use them for anything you
must remember exactly: who punched in, what was chosen each day, which
items were already handled.

## Lists and fields

- One list per kind of thing, named plainly: `punch-ins`, `verses`,
  `answered-posts`. Check `records_lists` before inventing a new name, so
  the same thing doesn't end up in two lists.
- Keep the same field names and formats in every record of a list. Dates
  as `YYYY-MM-DD` in the workspace's time zone, times as `HH:MM`, people
  by the name the chat shows. Then `where` and `range` find them reliably.
- Save what later questions need, and link records with a shared field:
  a punch-in can carry the `reference` of the verse it was for.

## No duplicates

When something may only happen once (one punch-in per person per day,
one verse per day), pass `unique_by` to `records_add`, e.g.
`["date", "person"]`. A repeat is skipped and reported with the existing
record's id, even if two people write at the same moment. Tell the
person it was already recorded; don't add it again.

## Read before you answer

Answer questions about the past from `records_find`, never from memory
or the chat: "who punched in today", "which verses have we used", "how
many days did Bob memorise this month" (a `range` on `date`). Before
picking something new that mustn't repeat, find what's already in the
list.

## Removing

`records_remove` asks a person first by default. Remove only what's
clearly wrong (a punch-in by mistake, a duplicate), by id where you can.
It returns the removed records, so say what was removed.

## Never

- Never claim something was recorded without a successful `records_add`.
- Never edit a list's file by hand or keep records anywhere else.
- Never remove records just to tidy up, or to make a report look better.
