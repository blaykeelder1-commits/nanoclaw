---
name: google-calendar
description: Manage Google Calendar events — list, create, update, delete events, and check availability. Use for scheduling appointments, booking reservations, and checking free/busy times.
allowed-tools: Bash(npx tsx /workspace/project/tools/calendar/calendar.ts *)
---

# Google Calendar

## Commands

### List events

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts list-events \
  --time-min "2026-02-21T00:00:00Z" \
  --time-max "2026-02-28T00:00:00Z"
```

Optional flags:
- `--max-results 10` — limit number of events returned (default: 50)
- `--q "search term"` — filter events by text search

Returns JSON with `events` array and `eventCount`.

### Create an event

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts create-event \
  --summary "Vending Machine Placement Call" \
  --start "2026-02-22T10:00:00" \
  --end "2026-02-22T10:30:00" \
  --description "Call with John from ABC Corp about lobby placement" \
  --location "Phone call"
```

Required: `--summary`, `--start`, `--end`
Optional: `--description`, `--location`, `--timezone "America/New_York"`, `--attendees '[{"email":"a@b.com"}]'`

Returns the created event with `id` and `htmlLink`.

### Update an event

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts update-event \
  --event-id "abc123def456" \
  --summary "Updated: Vending Placement Call" \
  --start "2026-02-22T11:00:00" \
  --end "2026-02-22T11:30:00"
```

Required: `--event-id`
Optional: any combination of `--summary`, `--description`, `--location`, `--start`, `--end`, `--timezone`

### Delete an event

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts delete-event \
  --event-id "abc123def456"
```

### Check availability (free/busy)

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts free-busy \
  --time-min "2026-02-22T00:00:00Z" \
  --time-max "2026-02-22T23:59:59Z"
```

Returns `busySlots` array with `start` and `end` times for each busy period, and `busyCount`.

## Output

All commands return JSON with a `status` field (`"success"` or `"error"`).

## Notes

- Start/end times without a timezone suffix use the `--timezone` flag, `TZ` environment variable, or default to UTC
- Use `free-busy` to check availability before creating events to avoid double-booking
- Event IDs are returned by `list-events` and `create-event` — use them for updates and deletes
- The calendar ID and credentials are configured via environment variables
