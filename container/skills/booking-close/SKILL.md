---
name: booking-close
description: Close a Sheridan Trailer Rentals booking inside the chat conversation. The new flow is license → signed agreement → payment, in that order. Andy creates the booking, sends the customer two links (license upload + agreement signing), then mints the Square payment link once both are received. Use this instead of telling the customer to "go to the website form."
allowed-tools: Bash(npx tsx /workspace/project/tools/booking/create-booking.ts *), Bash(npx tsx /home/nanoclaw/nanoclaw/tools/booking/create-booking.ts *), Bash(npx tsx /workspace/project/tools/booking/mint-payment-link.ts *), Bash(npx tsx /home/nanoclaw/nanoclaw/tools/booking/mint-payment-link.ts *), Bash(curl -sS https://chat.sheridantrailerrentals.us/api/booking/* *), Bash(npx tsx /workspace/project/tools/calendar/calendar.ts *), Bash(npx tsx /home/nanoclaw/nanoclaw/tools/calendar/calendar.ts *)
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

The flow has THREE customer-touchpoints, in this order. **Never skip ahead.**

1. **Create booking** → call `tools/booking/create-booking.ts`. Server creates a `pending` row, mints a `sign_token`, returns `bookingId`, `licenseUploadUrl`, `signUrl`. **No Square payment link is created yet.**
2. **Send the customer license + agreement URLs** in one message on their original channel.
3. **Check status before minting** → call `GET /api/booking/:bookingId`. When `readyToPay === true` (i.e. `licenseUploaded && agreementSigned`), call `tools/booking/mint-payment-link.ts --booking <id>` to mint the Square link and send it to the customer.

The server independently enforces the gate — `mint-payment-link` returns 412 if either step is missing. **Do not retry on 412**: tell the customer which step is still pending.

## Inputs you must collect first

Before calling create-booking, get these from the customer:

| Field | Notes |
|---|---|
| `equipment` | `rv`, `carhauler`, or `landscaping`. Confirm explicitly. |
| `dates` | Sorted list of `YYYY-MM-DD`. RV requires ≥ 2 dates (pickup + drop-off). Same-day for car hauler/landscaping is OK (single date = 1 day). |
| `first-name` + `last-name` | If only one name given, ask for the other. Don't guess. |
| `phone` | E.164 (`+15551234567`) or 10-digit US — used for the license/agreement reminder SMS. |
| `email` | Required for Square receipt + confirmation. |
| `delivery-address` | Required for RV. Use the customer's stated drop-off address. If they want pickup-only, ask about the RIVER promo (escalate if novel). |
| `add-ons` | `delivery` is implied for RV. `generator` if mentioned. |
| `payment-mode` | `deposit` for RV booked > 1 week out; `full` otherwise. Confirm with the customer if there's ambiguity. |
| `promo` | Only if customer named one (e.g. RIVER). Never invent. |

## How to call

### Step 1 — Create the booking

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

(CLI mode swaps to `/home/nanoclaw/nanoclaw/tools/booking/create-booking.ts`.)

Expected response:

```json
{
  "status": "success",
  "bookingId": "SR-A1B2C3D4",
  "licenseUploadUrl": "https://chat.sheridantrailerrentals.us/license/SR-A1B2C3D4",
  "signUrl": "https://chat.sheridantrailerrentals.us/sign/SR-A1B2C3D4/<token>",
  "pricing": { "subtotal": 825, "deposit": 250, "balance": 575, "chargeNow": 575, "paymentMode": "deposit", "lineItems": [...] }
}
```

If `status: "error"`, do NOT improvise — send "let me check on that and get right back to you" and call `mcp__nanoclaw__escalate` with the full error.

### Step 2 — Send the customer license + sign URLs (one message)

On the customer's original channel:

> Booked you in for **RV camper, July 4–6, delivery to 1234 Lake Rd**. Two quick things before payment — both take 30 seconds:
>
> 1. Driver's license photo: `<licenseUploadUrl>`
> 2. Sign your rental agreement: `<signUrl>`
>
> Once both are done I'll send you the secure payment link. Total $825 ($250 deposit due today).

Keep it 3–5 sentences. No marketing fluff. Phrase it warmly but tightly.

### Step 3 — Check status when the customer comes back

When the customer responds (any text, or replies "done"), check status:

```bash
curl -sS https://chat.sheridantrailerrentals.us/api/booking/SR-A1B2C3D4
```

Look at the response:

| Field | Meaning | What to do |
|---|---|---|
| `licenseUploaded: false` | License not yet uploaded | Re-send `licenseUploadUrl` only |
| `agreementSigned: false` | Agreement not yet signed | Re-send `signUrl` only |
| `readyToPay: true` | Both done — mint the Square link | Proceed to Step 4 |
| `status: "paid"` or `"confirmed"` | Customer already paid | Acknowledge and close |
| `status: "cancelled"` | Pending booking expired (>30 min) | Tell the customer; escalate if they still want it |

### Step 4 — Mint the payment link and send it

```bash
npx tsx /workspace/project/tools/booking/mint-payment-link.ts --booking SR-A1B2C3D4
```

Expected response:

```json
{ "status": "success", "paymentUrl": "https://square.link/u/...", "orderId": "..." }
```

Send the customer one message:

> Got your license and signed agreement — thanks. Here's your secure payment link: `<paymentUrl>` — total $825 ($250 due today).

If `mint-payment-link` returns `error: "license_missing"` or `"agreement_missing"`, **do not bypass it**. Tell the customer specifically what's still pending and re-send the matching URL.

## After payment lands

You don't need to do anything. The booking service's Square webhook handles:
- Status: `pending` → `paid` (deposit) or `confirmed` (full)
- Google Calendar event creation
- Customer confirmation email
- Owner notification email

The customer's signed rental agreement is included in both confirmation emails as a public read-only link (`/api/agreements/<AG-...>`).

## What to escalate (do NOT close in-chat)

Per `/workspace/global/authority.md`:

- Custom pricing / discount discussion outside published rates
- Refund or cancellation of an existing booking
- Pickup-only RV requests (RIVER promo) without prior approval
- Same-week RV bookings (deposit-only is not allowed — confirm full payment with customer first)
- Repeat customer asking for "the usual" you can't confirm in writing
- Any equipment damage / complaint thread
- Customer asking to speak to Blayke directly (escalate AND keep the conversation warm)

Escalate via `mcp__nanoclaw__escalate` with severity, summary, recommendation, and chat context.

## Logging

After a successful close, append one line to `groups/sheridan-rentals/lessons.md` under `## Conversion & Sales` capturing the pattern you used (channel → dates → time-to-license → time-to-sign → close time). This builds the muscle so Phase 1 evals can graduate the pattern to fully auto-act if it stays clean.
