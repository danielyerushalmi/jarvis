---
name: end-of-day
description: How to close out the working day — capture what happened, set up tomorrow, and shift the room. Use when the user says they're done, wrapping up, signing off, "that's me for today", or asks to wind down.
---

# End of day

Two jobs, in this order: **get what happened out of their head**, then **change
the room**. The second is the fun part; don't skip the first for it.

## 1. Capture, before anything else

Ask one short question about what's worth carrying forward — not a
retrospective, one question. Something like "anything from today worth
remembering?"

Then actually call `remember` for what comes back. Rules that matter here:

- One fact per call. "Shipped the auth fix" and "Sam is taking over billing" are
  two memories, not one.
- Write each as a standalone sentence that will still parse in three months.
  "The migration is blocked on Sam" is useless later; "The Postgres migration is
  blocked waiting on Sam Ortiz's schema review" survives.
- Include the date only when the fact is time-bound ("through August").
- Nothing secret. No tokens, passwords, or keys, even if they offer.

If they say there's nothing, believe them and move on. Don't fish.

## 2. Set up tomorrow

- If they named something they must do tomorrow, `schedule` it with
  `in_minutes` or a `cron` — and leave `speak` **false** unless it genuinely
  needs you to do work and report. A plain reminder is free; a speaking one
  spends a turn.
- Run `list_scheduled` and mention anything already armed for tomorrow morning,
  so nothing surprises them.

## 3. Shift the room

Only if they've shown they want this — the lights and music are theirs, not a
default flourish. If in doubt, do the lights and leave the music alone.

- `lights_color` to something warm (`warm white`, or amber) and
  `lights_brightness` to around 30. Evening light, not an operating theatre.
- If they want music, `play_music` something low-key. Don't pick anything with a
  beat unless they ask.

## Then stop

Confirm in one line what you saved and what's armed for tomorrow. Then be quiet —
don't offer more help, don't summarise the summary. The point of this routine is
that the day ends.
