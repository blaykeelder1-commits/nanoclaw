---
name: lead-finder
description: Find new business leads using Google Maps, website scraping, and directories. Use when asked to find leads, prospect, or research businesses in a market.
allowed-tools: Bash(npx tsx /workspace/project/tools/leads/google-maps.ts *), Bash(npx tsx /workspace/project/tools/leads/website-scraper.ts *), Bash(npx tsx /workspace/project/tools/crm/lead-score.ts *), Bash(npx tsx /workspace/project/tools/crm/import-apollo.ts *), Bash(npx tsx /workspace/project/tools/crm/query-contacts.ts *)
---

# Lead Finder

Find, import, score, and enrich business leads from multiple sources.

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
