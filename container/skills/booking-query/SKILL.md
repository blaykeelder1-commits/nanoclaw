---
name: booking-query
description: Query the Sheridan Rentals bookings database. Use when asked about bookings, upcoming rentals, revenue, or when compiling the daily digest.
allowed-tools: Bash(npx tsx /workspace/project/tools/booking/query-bookings.ts *)
---

# Booking Query Tool

Query the Sheridan Rentals SQLite bookings database (read-only).

## List bookings

```bash
npx tsx /workspace/project/tools/booking/query-bookings.ts list
npx tsx /workspace/project/tools/booking/query-bookings.ts list --status confirmed
npx tsx /workspace/project/tools/booking/query-bookings.ts list --equipment rv
npx tsx /workspace/project/tools/booking/query-bookings.ts list --days 7
npx tsx /workspace/project/tools/booking/query-bookings.ts list --status confirmed --equipment rv --days 14
```

## Get booking details

```bash
npx tsx /workspace/project/tools/booking/query-bookings.ts get SR-ABC12345
```

## Upcoming bookings summary (next 7 days)

```bash
npx tsx /workspace/project/tools/booking/query-bookings.ts summary
```

## Daily digest data

```bash
npx tsx /workspace/project/tools/booking/query-bookings.ts digest
```

Returns: tomorrow's pickups/returns, this week's bookings, revenue estimate, pending bookings.

## Notes

- Database is mounted read-only at `/workspace/extra/booking-data/bookings.db`
- All output is JSON
- Dates are stored as JSON arrays of YYYY-MM-DD strings
- Statuses: pending, paid, confirmed, cancelled
