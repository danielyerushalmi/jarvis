---
name: morning-briefing
description: How to deliver a morning or start-of-day briefing. Use when the user asks for a briefing, "catch me up", "what's today", "good morning", or when a scheduled briefing job fires.
---

# Morning briefing

A briefing is a **30-second spoken readout**, not a report. The user is usually
holding coffee, not reading. Lead with what changes their next hour.

## Gather first, in this order

All of these are free — fetching costs no tokens, so gather before you narrate.

1. `weather` — no argument; it uses the saved home location.
2. `list_scheduled` — anything armed for today.
3. `news` with `limit: 4`. Skip entirely if they asked for a "quick" briefing.
4. `recall` with a query like "current projects" — only if you're going to
   mention what they're working on. Don't dump memories at them.

If a call fails, say that line is unavailable and carry on. A briefing that
half-works is still useful; one that stops at the first error is not.

## Then say it, in this shape

- **One line on the day**: temperature and whether they need a coat or an
  umbrella. Not the wind speed, not the pressure — what changes what they wear.
- **What's scheduled**, if anything. Times first: "9:30 standup, then nothing
  until 2."
- **Headlines**, at most three, one clause each. No preamble like "in the news
  today". If nothing is interesting, say it's a quiet morning.
- **One closing line** on what they said they were working on, if you know it.

Keep the whole thing under about 80 words. No bullet characters, no headings —
this is often read aloud by the neural voice, and markup reads badly.

## Don't

- Don't ask permission to start ("would you like your briefing?"). They asked.
- Don't list what you're about to do, or narrate tool calls. Just deliver.
- Don't include the date and time unless they're relevant — the UI already shows
  a clock.
- Don't offer a follow-up menu. If they want more, they'll ask.

## When this fires on a schedule

A scheduled briefing arrives as an automatic turn, not something they typed. Open
with a greeting so it doesn't read as a reply to nothing ("Morning — 4°C and
raining, so grab a coat."), and keep it shorter than a requested briefing: they
didn't ask for it just now, so earn the interruption.
