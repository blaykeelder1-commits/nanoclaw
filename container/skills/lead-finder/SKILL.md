---
name: lead-finder
description: Find new business leads using Google Maps, website scraping, and directories. Use when asked to find leads, prospect, or research businesses in a market.
allowed-tools: Bash(npx tsx /workspace/project/tools/leads/google-maps.ts *), Bash(npx tsx /workspace/project/tools/leads/website-scraper.ts *), Bash(npx tsx /workspace/project/tools/crm/lead-score.ts *), Bash(npx tsx /workspace/project/tools/crm/import-apollo.ts *), Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *)
---

# Lead Finder

Find, import, score, and enrich business leads from multiple sources.

## Weekly Lead Scraping (Monday 7 AM)

Automated Monday morning lead generation pipeline. Run all searches, enrich, score, tag, and report.

### Step 1: Google Maps Searches

Run each vertical as a separate search with `--import` and appropriate tags. Use `--limit 60` for each.

```bash
# Office & coworking
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "office buildings Houston TX" --limit 60 --import --tags "maps,offices,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "coworking spaces Houston TX" --limit 60 --import --tags "maps,coworking,2026-W$(date +%V)"

# Fitness & hospitality
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "gyms fitness centers Houston TX" --limit 60 --import --tags "maps,gyms,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "hotels Houston TX" --limit 60 --import --tags "maps,hotels,2026-W$(date +%V)"

# Automotive
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "car dealerships Houston TX" --limit 60 --import --tags "maps,dealerships,2026-W$(date +%V)"

# Healthcare & education
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "hospitals medical centers Houston TX" --limit 60 --import --tags "maps,hospitals,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "universities colleges Houston TX" --limit 60 --import --tags "maps,universities,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "schools Houston TX" --limit 60 --import --tags "maps,schools,2026-W$(date +%V)"

# Residential
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "apartment complexes Houston TX" --limit 60 --import --tags "maps,apartments,2026-W$(date +%V)"

# Industrial & logistics
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "warehouses Houston TX" --limit 60 --import --tags "maps,warehouses,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "manufacturers Houston TX" --limit 60 --import --tags "maps,manufacturers,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "Amazon warehouses Houston TX" --limit 60 --import --tags "maps,amazon,2026-W$(date +%V)"
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "trucking shipping yards Houston TX" --limit 60 --import --tags "maps,trucking,2026-W$(date +%V)"
```

### Step 2: Website Scraper Batch

After all Maps searches complete, scrape websites for contact info:

```bash
npx tsx /workspace/project/tools/leads/website-scraper.ts batch --source google_maps --limit 50
```

### Step 3: Lead Scoring Batch

Score all new contacts:

```bash
npx tsx /workspace/project/tools/crm/lead-score.ts batch --source google_maps --limit 200
```

### Step 4: Smart Service Tagging

After scoring, apply service-fit tags based on industry and business type using CRM queries:

**`coffee-primary`** -- Best fit for coffee service:
- Offices with 50+ employees, coworking spaces, hotels, hospitals, universities
- Query: contacts with industry in (office, coworking, hospitality, healthcare, education) AND tags containing maps

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry office --tag maps --no-tag coffee-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add coffee-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry coworking --tag maps --no-tag coffee-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add coffee-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry hospitality --tag maps --no-tag coffee-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add coffee-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry healthcare --tag maps --no-tag coffee-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add coffee-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry education --tag universities --no-tag coffee-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add coffee-primary
```

**`vending-primary`** -- Best fit for vending machines:
- Gyms, apartment complexes, car dealerships, warehouses, manufacturers, trucking yards, schools
- Query: contacts with industry in (fitness, residential, automotive, manufacturing, logistics, education/schools)

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry fitness --tag maps --no-tag vending-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add vending-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry residential --tag maps --no-tag vending-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add vending-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry automotive --tag maps --no-tag vending-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add vending-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry manufacturing --tag maps --no-tag vending-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add vending-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry logistics --tag maps --no-tag vending-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add vending-primary
npx tsx /workspace/project/tools/crm/query-contacts.ts search --tag schools --no-tag vending-primary | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add vending-primary
```

**`ice-machine-fit`** -- Good fit for ice machine placement:
- Hotels, hospitals, gyms, restaurants, car dealerships
- Query: contacts with industry in (hospitality, healthcare, fitness, food_service, automotive)

```bash
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry hospitality --tag maps --no-tag ice-machine-fit | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add ice-machine-fit
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry healthcare --tag maps --no-tag ice-machine-fit | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add ice-machine-fit
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry fitness --tag maps --no-tag ice-machine-fit | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add ice-machine-fit
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry food_service --tag maps --no-tag ice-machine-fit | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add ice-machine-fit
npx tsx /workspace/project/tools/crm/query-contacts.ts search --industry automotive --tag maps --no-tag ice-machine-fit | xargs -I{} npx tsx /workspace/project/tools/crm/query-contacts.ts tag --contact-id {} --add ice-machine-fit
```

Note: A lead can have multiple service tags (e.g., a hotel gets both `coffee-primary` and `ice-machine-fit`).

### Step 5: Report via WhatsApp

Send a summary message with:
- Total new leads imported this week
- Enriched count (websites scraped successfully)
- Score distribution: hot (80+), warm (50-79), cool (20-49), cold (<20)
- Top 5 hottest leads (highest score, with company name and industry)

## Lead Enrichment Pipeline

After Google Maps import, the enrichment pipeline deepens lead quality:

1. **Website scraping** -- For each imported business, scrape their website looking for:
   - Contact emails: prioritize facility manager, office manager, property manager, general manager
   - Phone numbers: direct lines over main switchboard
   - Decision-maker names and titles

2. **Score updates based on enrichment** -- After scraping:
   - Leads with real email addresses get +10 score boost (via `hasEmail` in scoring config)
   - Leads with direct decision-maker contact get additional title keyword bonuses
   - Leads with complete data (email + phone + title + website) score highest

3. **Coffee-ideal location boost** -- Increase priority for locations that are ideal coffee placements:
   - Large offices (50+ employees visible from Google Maps review count as proxy)
   - Coworking spaces (high foot traffic, shared amenities)
   - Hotels (lobby coffee service demand)
   - Hospitals (24/7 staff need caffeine)
   - Universities (students and faculty)

4. **Existing coffee service detection** -- Lower priority for locations that already have coffee:
   - If website mentions "complimentary coffee", "coffee bar", "Starbucks on-site", or similar: reduce score or add `has-coffee-service` tag
   - These leads move to bottom of outreach queue but are not excluded (they may want to switch providers)

## Google Maps Search

Find businesses by category and location:

```bash
# Search only (preview results)
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "convenience stores Houston TX"

# Search and import to CRM
npx tsx /workspace/project/tools/leads/google-maps.ts search --query "warehouses Katy TX" --limit 60 --import --tags "maps,katy,2026-02"

# Enrich an existing contact with Google Maps data
npx tsx /workspace/project/tools/leads/google-maps.ts enrich --contact-id <id>
```

## Website Scraper

Extract emails and phone numbers from company websites:

```bash
# Scrape a single website
npx tsx /workspace/project/tools/leads/website-scraper.ts scrape --url "https://example.com"

# Scrape and update a CRM contact
npx tsx /workspace/project/tools/leads/website-scraper.ts scrape --url "https://example.com" --contact-id <id>

# Batch scrape all Google Maps leads missing emails
npx tsx /workspace/project/tools/leads/website-scraper.ts batch --source google_maps --limit 20
```

## Lead Scoring

Score contacts 0-100 based on title, industry, location, and data quality:

```bash
# Score one contact
npx tsx /workspace/project/tools/crm/lead-score.ts score --contact-id <id>

# Batch score all contacts
npx tsx /workspace/project/tools/crm/lead-score.ts batch --limit 200

# Batch score by source
npx tsx /workspace/project/tools/crm/lead-score.ts batch --source apollo --limit 100

# Show top uncontacted leads
npx tsx /workspace/project/tools/crm/lead-score.ts top --limit 20
```

## Full Lead Generation Workflow

1. **Search** — Find businesses on Google Maps by category + city
2. **Import** — Use `--import` flag to add to CRM automatically
3. **Scrape** — Run website scraper batch to find real email addresses
4. **Score** — Run lead scoring batch to prioritize
5. **Review** — Use `lead-score top` to see best leads
6. **Outreach** — Start with highest-scored uncontacted leads

## Import Apollo Data

```bash
# Directly from the Apollo Google Sheet (no download needed)
npx tsx /workspace/project/tools/crm/import-apollo.ts --sheet "14xhjN63ey_kok8EUyawy63nP8Cvt5IlP" --tags "apollo,2026-02"

# With a specific sheet/tab name
npx tsx /workspace/project/tools/crm/import-apollo.ts --sheet "spreadsheet_id" --range "Sheet2" --tags "apollo,batch2"

# From a CSV file
npx tsx /workspace/project/tools/crm/import-apollo.ts /path/to/export.csv --tags "apollo,batch1"

# Dry run first (preview without importing)
npx tsx /workspace/project/tools/crm/import-apollo.ts --sheet "14xhjN63ey_kok8EUyawy63nP8Cvt5IlP" --dry-run
```

## Notes

- Google Maps gives 1,000 free requests/month (within $200 credit) — enough for 20,000 leads
- Website scraper uses 2-second delays between requests and max 50 sites per batch
- Lead scores: 80+ = hot, 50-79 = warm, 20-49 = cool, <20 = cold
- Scoring config is in `tools/crm/scoring-config.json` — adjust weights as needed
- Always tag imports with source and date for tracking
