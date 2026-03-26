# A/B Testing Skill

You have access to a message variant testing system that helps you learn which communication approaches work best.

## When to Use

Before composing these types of messages, check for a variant:
- **First reply to a new lead** → category: `greeting_new_lead`
- **Responding to cost/pricing questions** → category: `objection_cost`
- **Following up with a quiet lead** → category: `follow_up_stale`
- **Pushing toward booking/appointment** → category: `closing_booking`

## How to Use

### Step 1: Get Your Variant
```bash
npx tsx tools/learning/get-variant.ts --category greeting_new_lead
```

Returns JSON with the guidance to follow:
```json
{
  "variant_id": "greeting_new_lead-social_proof",
  "variant_name": "social_proof",
  "template": "Mention relevant experience early...",
  "selection_method": "exploit"
}
```

### Step 2: Use the Guidance
Shape your response according to the variant's template. Don't copy it word-for-word — adapt it naturally to the conversation. The template is guidance, not a script.

### Step 3: Record the Outcome
After the conversation progresses, record what happened:

```bash
# Customer replied AND moved to next pipeline stage:
npx tsx tools/learning/record-variant-outcome.ts --variant-id greeting_new_lead-social_proof --converted --replied

# Customer replied but didn't advance:
npx tsx tools/learning/record-variant-outcome.ts --variant-id greeting_new_lead-social_proof --replied

# No response at all (record usage only):
npx tsx tools/learning/record-variant-outcome.ts --variant-id greeting_new_lead-social_proof
```

## Important Rules

- **Always be natural.** The variant is guidance, not a rigid script. Adapt to the customer's energy and context.
- **Don't mention the test.** Never tell customers you're testing different approaches.
- **Record honestly.** If the customer didn't respond, don't mark it as replied.
- **One variant per category per conversation.** Don't switch variants mid-conversation.
- **Skip if irrelevant.** If the conversation doesn't fit any category, just respond naturally without a variant.

## How It Works Behind the Scenes

The system uses epsilon-greedy selection — 80% of the time it picks the best-performing variant, 20% of the time it explores alternatives. After 50+ data points in a category, the analysis task automatically graduates the winner and writes the winning approach permanently to your lessons.md. A new challenger variant is created to keep improving.

This means you're always getting better at talking to customers, backed by real data.
