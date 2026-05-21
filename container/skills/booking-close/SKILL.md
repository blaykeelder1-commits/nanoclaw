---
name: booking-close
description: Close a Sheridan Trailer Rentals booking inside the chat conversation — create the booking, generate a Square payment link, and send the customer one SMS with the payment URL + a post-payment license-upload URL. Use this instead of telling the customer to "go to the website form."
allowed-tools: Bash(npx tsx /workspace/project/tools/booking/create-booking.ts *), Bash(npx tsx /home/nanoclaw/nanoclaw/tools/booking/create-booking.ts *), Bash(npx tsx /workspace/project/tools/calendar/calendar.ts *), Bash(npx tsx /home/nanoclaw/nanoclaw/tools/calendar/calendar.ts *)
---

# Closing a Sheridan Booking In-Chat

## When to use this skill

A Sheridan customer is in an active chat (Quo SMS, WhatsApp, FB Messenger, Gmail) AND:

- They have **confirmed the equipment** (RV camper / car hauler / landscaping trailer), AND
- They have **confirmed exact dates** (no "maybe next weekend" — actual YYYY-MM-DD), AND
- They are **inside the published rate sheet** (no custom pricing — that's escalate), AND
- The conversation is **not a refund / cancellation / complaint** (those escalate).

If any of the above is missing, do NOT use this skill — keep gathering info (or escalate, per `/workspace/global/authority.md`).

## What this skill does

1. Checks calendar availability for the requested dates.
2. Calls `tools/booking/create-booking.ts` to create a `pending` booking row and a Square hosted payment link.
3. Returns: `bookingId`, `paymentUrl`, `licenseUploadUrl`, `pricing`.
4. The agent then sends ONE message to the customer on their original channel with the payment URL and a short note about the post-payment license-upload step.

## Inputs you must collect first

Before calling the tool, get these from the customer:

| Field | Notes |
|---|---|
| `equipment` | `rv`, `carhauler`, or `landscaping`. Confirm explicitly. |
| `dates` | Sorted list of `YYYY-MM-DD`. RV requires ≥ 2 dates (pickup + drop-off). Same-day for car hauler/landscaping is OK (single date = 1 day). |
| `first-name` + `last-name` | If only one name given, ask for the other. Don't guess. |
| `phone` | E.164 (`+15551234567`) or 10-digit US — the post-payment license SMS goes here. |
| `email` | Required for the Square receipt + confirmation. |
| `delivery-address` | Required for RV. Use the customer's stated drop-off address. If they want pickup-only, ask about the RIVER promo (escalate if novel). |
| `add-ons` | `delivery` is implied for RV. `generator` if mentioned. |
| `payment-mode` | `deposit` for RV booked > 1 week out; `full` otherwise. Confirm with the customer if there's ambiguity. |
| `promo` | Only if customer named one (e.g. RIVER). Never invent. |

## How to call

```bash
npx tsx /workspace/project/tools/booking/create-booking.ts \
  --equipment rv \
  --dates 2026-07-04,2026-07-05,2026-07-06 \
  --first-name Jane --last-name Doe \
  --phone "+18175551234" --email jane@example.com \
  --delivery-address "1234 Lake Rd, Brenham TX" \
  --add-ons delivery \
  --payment-mode deposit
```

(In CLI mode the path is `/home/nanoclaw/nanoclaw/tools/booking/create-booking.ts` — the runtime swaps it.)

## Output to expect

```json
{
  "status": "success",
  "bookingId": "SR-A1B2C3D4",
  "paymentUrl": "https://square.link/u/...",
  "licenseUploadUrl": "https://chat.sheridantrailerrentals.us/license/SR-A1B2C3D4",
  "pricing": { "subtotal": 825, "deposit": 250, "balance": 575, "chargeNow": 575, "paymentMode": "deposit", "lineItems": [...] }
}
```

If `status: "error"`, do NOT improvise. Send the customer a short "let me check on that and get right back to you" and call `mcp__nanoclaw__escalate` with the full error and your recommendation.

## Sending the customer message

After a successful response, send **ONE** message on the customer's original channel with:

- A one-line confirmation of equipment + dates
- The `paymentUrl`
- A one-line note that they'll get a license-upload link by SMS after payment
- Total + what they'll be charged today

Example (SMS):

> Booked: RV camper July 4–6, delivery to 1234 Lake Rd. Total $825 ($250 deposit due today). Pay here: <paymentUrl> — once Square confirms, we'll text you a 1-tap link to upload your driver's license.

Keep it 2–4 sentences. No marketing fluff.

## After payment lands

You don't need to do anything. The booking service's Square webhook handles:
- Status: `pending` → `paid` (deposit) or `confirmed` (full)
- Google Calendar event creation
- Customer confirmation email
- Owner notification email
- **License-upload SMS** to the customer's phone (only fires on agent-initiated bookings without a license on file)

The customer uploads via the `licenseUploadUrl` and the booking is fully fulfilled.

## What to escalate (do NOT close in-chat)

Per `/workspace/global/authority.md`:

- Custom pricing / discount discussion outside published rates
- Refund or cancellation of an existing booking
- Pickup-only RV requests (RIVER promo) without prior approval
- Same-week RV bookings (deposit-only is not allowed — confirm full payment with customer first)
- Repeat customer asking for "the usual" you can't confirm in writing
- Any equipment damage / complaint thread
- Customer asking to speak to Blayke directly (escalate AND keep the conversation warm)

Escalate via `mcp__nanoclaw__escalate` with severity, summary, recommendation, and the chat context.

## Logging

After a successful close, append one line to `groups/sheridan-rentals/lessons.md` under `## Conversion & Sales` capturing the pattern you used (channel → dates → close time). This builds the muscle so Phase 1 evals can graduate the pattern to fully auto-act if it stays clean.
