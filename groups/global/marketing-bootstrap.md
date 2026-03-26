# Marketing System Bootstrap

> One-time setup guide for the new marketing, SEO, and online presence tools.
> Run these steps after deploying the updated code.

## Step 1: Run Migration Script

From the NanoClaw project root on the VPS:
```bash
npx tsx scripts/add-marketing-scopes.ts
```
This adds `gbp`, `ads`, `seo`, `tiktok` secret scopes to snak-group and sheridan-rentals.

## Step 2: Add New Environment Variables to .env

On the VPS, add these to `/home/nanoclaw/nanoclaw/.env`:

### Google Business Profile (needed for GBP tool)
```
GBP_ACCOUNT_ID=<from business.google.com>
GBP_LOCATION_ID_SNAK=<snak group location ID>
GBP_LOCATION_ID_SHERIDAN=<sheridan rentals location ID>
```

### SEO / Search (needed for keyword tracking)
```
GOOGLE_SEARCH_API_KEY=<Google Custom Search API key>
GOOGLE_SEARCH_ENGINE_ID=<Custom Search Engine ID>
```

### Google Ads (build tool first, apply for token)
```
GOOGLE_ADS_CUSTOMER_ID=<without dashes>
GOOGLE_ADS_DEVELOPER_TOKEN=<from Google Ads API Center>
GOOGLE_ADS_REFRESH_TOKEN=<OAuth2 refresh token>
GOOGLE_ADS_CLIENT_ID=<OAuth2 client ID>
GOOGLE_ADS_CLIENT_SECRET=<OAuth2 client secret>
```

### TikTok (needed for TikTok posting)
```
TIKTOK_ACCESS_TOKEN=<from developers.tiktok.com>
```

## Step 3: Populate Asset Catalogs (Andy Does This)

Once running, Andy should:

1. **List Google Drive photos**:
   ```bash
   npx tsx tools/drive/drive.ts list
   npx tsx tools/drive/drive.ts search --name "snak" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "vending" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "coffee" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "cooler" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "sheridan" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "trailer" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "rv" --mime "image/jpeg"
   npx tsx tools/drive/drive.ts search --name "hauler" --mime "image/jpeg"
   ```

2. **Populate asset-catalog.md** for both groups with the discovered file IDs

3. **Discover Instagram locations**:
   ```bash
   npx tsx tools/social/post-instagram.ts --search-location "Houston, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Tomball, TX"
   npx tsx tools/social/post-instagram.ts --search-location "The Woodlands, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Katy, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Cypress, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Sugar Land, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Spring, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Magnolia, TX"
   npx tsx tools/social/post-instagram.ts --search-location "Conroe, TX"
   ```

4. **Update houston-places.md** with the discovered Instagram location IDs

## Step 4: Initialize Directory Listings (Andy Does This)

```bash
npx tsx tools/seo/directory-manager.ts init --business "snak-group"
npx tsx tools/seo/directory-manager.ts init --business "sheridan-rentals"
```

## Step 5: Run First SEO Audit (Andy Does This)

```bash
npx tsx tools/seo/seo-audit.ts audit --url "https://snakgroup.biz"
npx tsx tools/seo/seo-audit.ts audit --url "https://sheridantrailerrentals.us"
npx tsx tools/seo/seo-audit.ts check-speed --url "https://snakgroup.biz" --strategy mobile
npx tsx tools/seo/seo-audit.ts check-speed --url "https://sheridantrailerrentals.us" --strategy mobile
npx tsx tools/seo/seo-audit.ts check-schema --url "https://snakgroup.biz"
npx tsx tools/seo/seo-audit.ts check-schema --url "https://sheridantrailerrentals.us"
```

Update `seo-assets.md` for both groups with results.

## Step 6: Create First Marketplace Listings (Andy — Sheridan Only)

```bash
npx tsx tools/social/fb-marketplace.ts create-listing \
  --title "RV Camper Rental - $150/night - Tomball TX" \
  --price 150 \
  --description "36ft RV camper for rent..." \
  --category CAMPING \
  --location "Tomball, TX" \
  --dry-run
```

If Commerce API isn't available, use agent-browser to post manually.

## Step 7: Verify Scheduled Tasks

Confirm these tasks are registered and scheduled:
- `snak-fb-posts-weekly` — Sunday 6 PM CT
- `snak-fb-post-daily` — Weekdays 9 AM CT
- `snak-fb-review-weekly` — Saturday 10 AM CT
- `sheridan-fb-posts-weekly` — Sunday 6 PM CT
- `sheridan-fb-post-daily` — Weekdays 9 AM CT
- `sheridan-fb-review-weekly` — Saturday 10 AM CT

## After Bootstrap

Once everything is set up, the weekly cycle runs automatically:
- **Sunday 6 PM**: Generate posts (Facebook + Instagram + TikTok + GBP) → owner approval
- **Weekdays 9 AM**: Post approved content across all platforms
- **Saturday 10 AM**: Performance review across all platforms
- **Monthly 1st**: SEO audit + keyword check + directory report
- **Mon/Thu 10 AM**: GBP review responses
- **Monday 7 AM**: Marketplace listing renewal (Sheridan)
- **Monday 9 AM**: Google Ads weekly review
