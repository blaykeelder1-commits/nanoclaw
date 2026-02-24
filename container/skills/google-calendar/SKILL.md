---
name: google-calendar
description: Manage Google Calendar events — list, create, update, delete events, and check availability. Use for scheduling appointments, booking reservations, and checking free/busy times.
allowed-tools: Bash(npx tsx /workspace/project/tools/calendar/calendar.ts *)
---

# Google Calendar

## Commands

All commands support an optional `--calendar-id` flag to target a specific calendar. If omitted, uses the default `GOOGLE_CALENDAR_ID` environment variable.

### List events

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts list-events \
  --calendar-id "calendar-id@group.calendar.google.com" \
  --time-min "2026-02-21T00:00:00Z" \
  --time-max "2026-02-28T00:00:00Z"
```

Optional flags:
- `--calendar-id "id"` — target a specific calendar (overrides default)
- `--max-results 10` — limit number of events returned (default: 50)
- `--q "search term"` — filter events by text search

Returns JSON with `events` array and `eventCount`.

### Create an event

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts create-event \
  --calendar-id "calendar-id@group.calendar.google.com" \
  --summary "Vending Machine Placement Call" \
  --start "2026-02-22T10:00:00" \
  --end "2026-02-22T10:30:00" \
  --description "Call with John from ABC Corp about lobby placement" \
  --location "Phone call"
```

Required: `--summary`, `--start`, `--end`
Optional: `--calendar-id`, `--description`, `--location`, `--timezone "America/New_York"`, `--attendees '[{"email":"a@b.com"}]'`

Returns the created event with `id` and `htmlLink`.

### Update an event

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts update-event \
  --calendar-id "calendar-id@group.calendar.google.com" \
  --event-id "abc123def456" \
  --summary "Updated: Vending Placement Call" \
  --start "2026-02-22T11:00:00" \
  --end "2026-02-22T11:30:00"
```

Required: `--event-id`
Optional: `--calendar-id`, any combination of `--summary`, `--description`, `--location`, `--start`, `--end`, `--timezone`

### Delete an event

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts delete-event \
  --calendar-id "calendar-id@group.calendar.google.com" \
  --event-id "abc123def456"
```

### Check availability (free/busy)

```bash
npx tsx /workspace/project/tools/calendar/calendar.ts free-busy \
  --calendar-id "calendar-id@group.calendar.google.com" \
  --time-min "2026-02-22T00:00:00Z" \
  --time-max "2026-02-22T23:59:59Z"
```

Returns `busySlots` array with `start` and `end` times for each busy period, and `busyCount`.

## Known Calendar IDs

### Sheridan Trailer Rentals
- **RV Camper**: `c_7ba6d46497500abce720f92671ef92bb8bbdd79e741f71d41c01084e6bb0d69c@group.calendar.google.com`
- **Car Hauler**: `c_f92948a07076df3480b68fcaac0dd44cfc815ca9265999f709254dfca5fc64ad@group.calendar.google.com`
- **Landscaping Trailer**: `c_684ca11a465fb336458c8d7dfadc9ec83265bce3b8657712d2fa10ea32cc627e@group.calendar.google.com`

## Output

All commands return JSON with a `status` field (`"success"` or `"error"`).

## Notes

- Start/end times without a timezone suffix use the `--timezone` flag, `TZ` environment variable, or default to UTC
- Use `free-busy` to check availability before creating events to avoid double-booking
- Event IDs are returned by `list-events` and `create-event` — use them for updates and deletes
- Pass `--calendar-id` to target a specific calendar, or omit to use the default
