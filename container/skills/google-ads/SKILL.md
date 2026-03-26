---
name: google-ads
description: Manage Google Ads campaigns — create campaigns, monitor performance, adjust budgets, manage keywords, and generate reports. Use for paid advertising management and keyword research.
allowed-tools: Bash(npx tsx /workspace/project/tools/ads/google-ads.ts *)
---

# Google Ads Management

## Create a Campaign

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts create-campaign \
  --name "Snak Group - Vending Houston" \
  --budget 25 \
  --type SEARCH \
  --keywords "vending machine houston,office vending houston,break room vending" \
  --location "Houston, TX" \
  --ad-text "Premium Vending Solutions" \
  --description "Zero-cost vending machines for Houston businesses. 50+ locations. Get started today." \
  [--dry-run]
```

Options:
- `--name` (required): Campaign name
- `--budget` (required): Daily budget in dollars
- `--type`: SEARCH (default), DISPLAY, or LOCAL
- `--keywords`: Comma-separated target keywords (for SEARCH)
- `--location`: Geo target (default: "Houston, TX")
- `--ad-text`: Headline text
- `--description`: Ad description text
- `--dry-run`: Preview without creating

**CRITICAL: Always use --dry-run first and send the preview to the owner for approval before creating any campaign that spends money.**

## List Campaigns

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts list-campaigns [--status ALL]
```

Options: `--status` ALL (default), ENABLED, or PAUSED

## Pause / Enable Campaign

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts pause-campaign --campaign-id "123456"
npx tsx /workspace/project/tools/ads/google-ads.ts enable-campaign --campaign-id "123456"
```

## Performance Report

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts report \
  [--days 7] \
  [--campaign-id "123456"] \
  [--breakdown campaign]
```

Options:
- `--days`: Report period (default: 7)
- `--campaign-id`: Specific campaign (omit for all)
- `--breakdown`: campaign (default), ad_group, keyword, or day

Returns: impressions, clicks, CTR, conversions, cost, CPA, ROAS.

## Keyword Management

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts add-keywords \
  --campaign-id "123456" \
  --keywords "office coffee houston,workplace coffee service" \
  --match-type PHRASE
```

Match types: BROAD, PHRASE (default), EXACT

## Adjust Budget

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts adjust-budget \
  --campaign-id "123456" \
  --budget 50
```

## Keyword Research

```bash
npx tsx /workspace/project/tools/ads/google-ads.ts keyword-ideas \
  --keywords "vending machine,office coffee,smart cooler" \
  --location "Houston, TX" \
  [--limit 20]
```

Returns: keyword, avg monthly searches, competition, suggested bid.

---

## Campaign Strategy

### Snak Group Campaigns

**Campaign 1: Vending Houston (Search)**
- Keywords: "vending machine houston", "office vending houston", "break room vending near me", "free vending machine placement"
- Budget: $15-25/day
- Goal: Lead generation (form fills, calls)

**Campaign 2: Coffee Service Houston (Search)**
- Keywords: "office coffee service houston", "coffee machine for office", "workplace coffee solution"
- Budget: $15-25/day
- Goal: Coffee machine placement leads

**Campaign 3: Smart Cooler (Search)**
- Keywords: "smart cooler houston", "healthy vending houston", "grab and go cooler office"
- Budget: $10-15/day
- Goal: Smart cooler placements

### Sheridan Rentals Campaigns

**Campaign 1: Trailer Rental (Search)**
- Keywords: "trailer rental tomball tx", "car hauler rental houston", "landscaping trailer rental"
- Budget: $10-20/day
- Goal: Booking inquiries

**Campaign 2: RV Rental (Search)**
- Keywords: "rv rental houston", "camper rental tomball", "rv rental near me"
- Budget: $10-20/day
- Goal: RV bookings

---

## Weekly Review Process

Every Monday (scheduled task):

1. **Pull 7-day report**: `report --days 7`
2. **Check CPA thresholds**:
   - Snak Group: CPA should be under $50 per qualified lead
   - Sheridan Rentals: CPA should be under $30 per booking inquiry
3. **Auto-actions**:
   - If CPA > 2x threshold for 7 days → pause the campaign and notify owner
   - If CTR < 1% for 7 days → flag for ad copy refresh
   - If a keyword has 100+ impressions and 0 clicks → add as negative keyword
4. **Budget optimization**:
   - If a campaign converts well (CPA < threshold) → suggest budget increase
   - If a campaign bleeds money (CPA > threshold) → suggest budget decrease or pause
5. **Generate summary** and email owner with key metrics and recommendations

---

## Rules

- **NEVER create a live campaign without owner approval** — always --dry-run first
- **NEVER exceed the approved daily budget** without asking
- **Pause immediately** if something looks wrong (unexpected spend, irrelevant clicks)
- **Track conversions** — connect Google Ads conversions to CRM deals when possible
- **Negative keywords** — actively add irrelevant search terms as negatives (check search term reports)
- **A/B test ad copy** — run 2 ad variants per ad group, retire the loser after 100+ impressions each
