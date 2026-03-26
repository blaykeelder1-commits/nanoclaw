---
name: seo
description: SEO auditing, keyword tracking, page speed monitoring, and business directory management. Use for monthly SEO audits, keyword ranking checks, schema validation, Core Web Vitals, and NAP consistency across directories.
allowed-tools: Bash(npx tsx /workspace/project/tools/seo/seo-audit.ts *), Bash(npx tsx /workspace/project/tools/seo/directory-manager.ts *)
---

# SEO Management

## Site Audit

Run a full on-page SEO audit:

```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts audit --url "https://snakgroup.biz"
npx tsx /workspace/project/tools/seo/seo-audit.ts audit --url "https://sheridantrailerrentals.us"
```

Returns a scored report (0-100) checking: title tag, meta description, H1, image alt text, canonical URL, robots.txt, sitemap.xml, HTTPS, mobile viewport, schema markup, Open Graph tags, and page response time.

## Keyword Ranking

Track where the business ranks for target keywords:

```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts keywords \
  --domain "snakgroup.biz" \
  --keywords "vending machine houston,office coffee service houston,smart cooler houston" \
  --location "Houston, TX"
```

Returns: keyword, current position (1-10 or >10), URL that ranked, result title.

## Schema Validation

Check structured data on a page:

```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts check-schema --url "https://snakgroup.biz"
```

Validates LocalBusiness, Organization, and Service schemas. Reports missing required fields.

## Page Speed (Core Web Vitals)

```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts check-speed \
  --url "https://snakgroup.biz" \
  --strategy mobile
```

Returns: Performance score, LCP, INP, CLS, FCP, TTFB with ratings and improvement opportunities.

---

## Directory Listing Management

### Initialize Directories

First-time setup — populates all tracked directories with claim URLs:

```bash
npx tsx /workspace/project/tools/seo/directory-manager.ts init --business "snak-group"
npx tsx /workspace/project/tools/seo/directory-manager.ts init --business "sheridan-rentals"
```

### Check a Specific Directory

```bash
npx tsx /workspace/project/tools/seo/directory-manager.ts check \
  --business "snak-group" \
  --directory "yelp"
```

### Generate Full Report

```bash
npx tsx /workspace/project/tools/seo/directory-manager.ts report --business "snak-group"
```

Returns status of all directories: claimed/verified/unclaimed, URLs, NAP consistency, last checked date.

### Update Listing Status

After manually claiming or verifying a listing:

```bash
npx tsx /workspace/project/tools/seo/directory-manager.ts update \
  --business "snak-group" \
  --directory "yelp" \
  --status "claimed" \
  --url "https://yelp.com/biz/snak-group-houston"
```

---

## Monthly SEO Audit Workflow

Run on the 1st of each month for both businesses:

### Step 1: Full Site Audit
```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts audit --url "https://snakgroup.biz"
npx tsx /workspace/project/tools/seo/seo-audit.ts audit --url "https://sheridantrailerrentals.us"
```

### Step 2: Keyword Rankings
Read `keyword-strategy.md` for target keywords, then:
```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts keywords \
  --domain "snakgroup.biz" \
  --keywords "<from keyword-strategy.md>"
```

### Step 3: Core Web Vitals
```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts check-speed --url "https://snakgroup.biz" --strategy mobile
npx tsx /workspace/project/tools/seo/seo-audit.ts check-speed --url "https://snakgroup.biz" --strategy desktop
```

### Step 4: Schema Check
```bash
npx tsx /workspace/project/tools/seo/seo-audit.ts check-schema --url "https://snakgroup.biz"
```

### Step 5: Directory Consistency
```bash
npx tsx /workspace/project/tools/seo/directory-manager.ts report --business "snak-group"
```

### Step 6: Compare & Report
- Compare scores to previous month's results in `seo-assets.md`
- Update `seo-assets.md` with latest scores and rankings
- Email owner a summary with: overall score change, keyword movement, action items
- If any directory is unclaimed, include the claim URL in the report

---

## Local SEO Checklist

Check these factors for local search ranking:

### Google Business Profile
- [ ] Profile 100% complete (description, hours, categories, photos, services)
- [ ] Posts published 2-3x per week
- [ ] Reviews responded to within 48 hours
- [ ] Q&A section monitored and answered
- [ ] Photos updated monthly (min 10 photos)

### Citations & Directories
- [ ] NAP consistent across all directories (exact same name, address, phone)
- [ ] Listed on top 10 directories (Google, Apple Maps, Bing, Yelp, BBB, Yellow Pages, Angi, Thumbtack, Facebook, industry-specific)
- [ ] All listings claimed and verified

### On-Page SEO
- [ ] LocalBusiness schema markup on homepage
- [ ] City + service keywords in title tags (e.g., "Vending Machine Houston | Snak Group")
- [ ] City + service keywords in H1 (e.g., "Premium Vending Solutions in Houston, TX")
- [ ] Meta description includes location and primary service
- [ ] Location pages for key service areas (if applicable)
- [ ] NAP in website footer
- [ ] Google Maps embed on contact page

### Reviews
- [ ] Actively requesting reviews from satisfied customers (14-21 days post-sale)
- [ ] 4.5+ star average maintained
- [ ] Minimum 10 reviews (more = better)
- [ ] Recent reviews (within last 30 days)

### Content
- [ ] Blog posts targeting local keywords (monthly)
- [ ] Content includes geographic terms naturally
- [ ] Internal linking between service pages and location pages
