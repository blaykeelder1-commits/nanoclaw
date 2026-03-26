---
name: fb-marketplace
description: Create and manage Facebook Marketplace listings for Sheridan Rentals. Use when asked to post, renew, or manage Marketplace rental listings.
allowed-tools: Bash(npx tsx /workspace/project/tools/social/fb-marketplace.ts *), Bash(agent-browser:*)
---

# Facebook Marketplace — Sheridan Rentals

## Create a Listing

```bash
npx tsx /workspace/project/tools/social/fb-marketplace.ts create-listing \
  --title "RV Camper Rental - $150/night - Tomball TX" \
  --price 150 \
  --description "36ft RV camper available for rent. $150/night, $250 refundable deposit. Includes generator add-on ($75/night). Delivery available within 60 miles of Tomball ($250 flat). Book at sheridantrailerrentals.us/form/" \
  --category CAMPING \
  --location "Tomball, TX" \
  --images "https://drive-photo-url-1.jpg,https://drive-photo-url-2.jpg" \
  --condition USED_GOOD \
  [--dry-run]
```

If the Commerce API isn't available, the tool returns a `fallback_needed` status with all listing data formatted for manual posting via agent-browser.

## List Active Listings

```bash
npx tsx /workspace/project/tools/social/fb-marketplace.ts list-active [--limit 20]
```

## Update a Listing

```bash
npx tsx /workspace/project/tools/social/fb-marketplace.ts update-listing \
  --listing-id "123456" \
  --price 125 \
  --availability IN_STOCK
```

## Delete a Listing

```bash
npx tsx /workspace/project/tools/social/fb-marketplace.ts delete-listing --listing-id "123456"
```

## Renew a Listing

Re-posts an old listing with fresh content for visibility:

```bash
npx tsx /workspace/project/tools/social/fb-marketplace.ts renew-listing \
  --listing-id "123456" \
  [--title "Updated title"] \
  [--price 150] \
  [--description "Updated description"]
```

---

## Listing Templates

### RV Camper
- **Title**: "RV Camper Rental - $150/night - Tomball TX"
- **Price**: 150
- **Category**: CAMPING
- **Description**: "36ft RV camper for rent in Tomball, TX. Perfect for camping trips, family getaways, or weekend adventures. $150/night with a $250 refundable security deposit. Generator add-on available ($75/night includes 5 gal gas). We deliver within 60 miles of Tomball for $250 flat. Everything included — just hook up and go! Book at sheridantrailerrentals.us/form/"
- **Condition**: USED_GOOD
- **Photos**: Minimum 4 — exterior, interior, kitchen, bedroom

### Car Hauler
- **Title**: "Car Hauler Trailer Rental - $65/day - Tomball TX"
- **Price**: 65
- **Category**: VEHICLE_PARTS
- **Description**: "Car hauler trailer for rent in Tomball, TX. $65/day with a $50 refundable deposit. Includes straps, ramps, winch, and spare tire. Perfect for picking up a vehicle, moving a project car, or hauling equipment. 6,000 lb capacity. Book at sheridantrailerrentals.us/form/"
- **Condition**: USED_GOOD
- **Photos**: Minimum 3 — full trailer, ramps deployed, straps/accessories

### Landscaping Trailer
- **Title**: "Landscaping Trailer Rental - $50/day - Tomball TX"
- **Price**: 50
- **Category**: TOOLS
- **Description**: "Landscaping trailer for rent in Tomball, TX. $50/day with a $50 refundable deposit. Includes dolly for furniture and appliances. Great for moving, yard work, hauling debris, or any project. Book at sheridantrailerrentals.us/form/"
- **Condition**: USED_GOOD
- **Photos**: Minimum 3 — full trailer, dolly, loaded example

---

## Posting & Renewal Schedule

### Active Listings (keep live at all times)
- 1x RV Camper listing
- 1x Car Hauler listing
- 1x Landscaping Trailer listing

### Renewal Cadence
- **Every Monday at 7 AM CT**: Check `marketplace-listings.md` for listings older than 7 days
- Renew by deleting the old listing and creating a fresh one
- Slightly vary the title and first line of description each renewal (avoids looking like spam)
- Update `marketplace-listings.md` with new listing IDs and dates

### Title Variations (rotate weekly)
**RV Camper:**
- "RV Camper Rental - $150/night - Tomball TX"
- "36ft Camper for Rent - Tomball/Houston Area"
- "Weekend RV Rental - $150/night - Delivery Available"

**Car Hauler:**
- "Car Hauler Trailer Rental - $65/day - Tomball TX"
- "Car Hauler for Rent - Houston/Tomball Area"
- "Tow Trailer Rental - $65/day - Ramps & Straps Included"

**Landscaping Trailer:**
- "Landscaping Trailer Rental - $50/day - Tomball TX"
- "Utility Trailer for Rent - $50/day - Tomball Area"
- "Moving/Hauling Trailer - $50/day - Dolly Included"

---

## Handling Marketplace Inquiries

When someone messages about a Marketplace listing:

1. **Respond within 15 minutes** — Marketplace rewards fast responses with better listing visibility
2. **Confirm availability** — Check Google Calendar for their dates
3. **Answer their specific question** — Don't send a generic pitch
4. **Direct to booking**: "Those dates are open! Head to sheridantrailerrentals.us/form/ to lock them in."
5. **Create a CRM deal** with `--source messenger --source-channel messenger`
6. **Track in pipeline** — move through stages as the conversation progresses

### Common Marketplace Questions
- "Is this available?" → Check calendar, confirm, give booking link
- "What's included?" → List inclusions from inventory.md
- "Can you deliver?" → "$250 flat within 60 miles of Tomball"
- "How do I book?" → "sheridantrailerrentals.us/form/"
- Price negotiation → "Our rates are already the best in the area — $X/day all-inclusive"
