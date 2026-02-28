---
name: square-payments
description: Create Square payment links for deposits and rentals, check payment status, and list recent payments. Use for collecting deposits and verifying payments.
allowed-tools: Bash(npx tsx /workspace/project/tools/square/square.ts *)
---

# Square Payments

## Commands

### Create a payment link

Generate a checkout link to send to the customer for deposit or full payment.

```bash
npx tsx /workspace/project/tools/square/square.ts create-payment-link \
  --amount 250 \
  --description "RV Camper Deposit — John Smith" \
  --customer-email "john@example.com"
```

Required: `--amount` (in dollars)
Optional: `--description`, `--customer-name`, `--customer-email`

Returns a `paymentLink` URL to send to the customer and an `orderId` to track payment status.

**Important:** Always save the `orderId` from the response — you need it to check if the customer has paid.

### Check payment status

Check whether a payment link has been paid.

```bash
npx tsx /workspace/project/tools/square/square.ts check-payment \
  --order-id "ORDER_ID_FROM_CREATE"
```

Use `--order-id` (from create-payment-link response) or `--payment-id` (from Square directly).

Returns `isPaid: true/false` and payment details.

### List recent payments

```bash
npx tsx /workspace/project/tools/square/square.ts list-payments \
  --begin "2026-02-01T00:00:00Z" \
  --end "2026-02-28T23:59:59Z"
```

Optional: `--begin`, `--end` (defaults to last 7 days), `--limit` (default: 20)

## Deposit Amounts

- **RV Camper**: $250
- **Car Hauler**: $50
- **Landscaping Trailer**: $50

## Workflow

1. Customer confirms they want to book
2. Create payment link: `create-payment-link --amount 250 --description "RV Camper Deposit — Customer Name"`
3. Send the payment link to the customer in chat
4. When customer says they've paid, verify: `check-payment --order-id "..."`
5. If paid, proceed with booking (create calendar event, send confirmation)

## Output

All commands return JSON with a `status` field (`"success"` or `"error"`).

## Notes

- Payment links expire after 28 days
- After payment, customers are redirected to sheridantrailerrentals.us/thank-you
- The `orderId` is the key to checking payment status — always save it
- For web chat: include the payment link in a `<payment-link>` tag so it renders as a button
  Example: `<payment-link url="https://square.link/...">Pay $250 Deposit</payment-link>`
