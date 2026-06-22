# Platform Wiring — Setup Steps

Status as of 2026-06-03. Andy publishes via `tools/social/post-all.ts`, which reports a
per-platform receipt (✅ posted / ❌ not connected / ⏭️ skipped / ⚠️ error). Connecting a
platform = filling its `.env` keys on the VPS, then restarting `nanoclaw`.

**Working today:** Facebook (Snak + Sheridan), LinkedIn, Instantly (cold email).
**Asset pipeline (2026-06-05):** `--asset` on `post-all` pulls a photo/video from the Snak Drive
folder, converts iPhone formats (HEIC→JPEG, MOV/HEVC→MP4), and serves it publicly for FB/IG/TikTok.
**In progress (you):** Instagram (creating the IG Business accounts — see below).
**Not connected:** Instagram, X/Twitter, TikTok, Google Business Profile, Google Ads.

All edits are on the VPS: `ssh nanoclaw`, project at `/home/nanoclaw/nanoclaw`, secrets in `.env`.
After editing `.env`: `sudo systemctl restart nanoclaw`.

---

## Instagram  (needs you: ~10–15 min in Meta Business Suite)

Andy reuses the existing Facebook page token for Instagram, so you do NOT need a separate IG
token IF you (a) link an IG Business account to each FB Page and (b) add IG scopes to the token.

Current blocker (verified): the FB pages have **no linked Instagram Business account**, and the
page token scopes are `pages_show_list, pages_messaging, pages_read_engagement, pages_manage_posts,
public_profile` — **missing `instagram_basic` + `instagram_content_publish`**.

Steps:
1. Ensure each business has an **Instagram Business (or Creator)** account.
2. In **Meta Business Suite** → each Facebook Page → *Linked accounts* → link its Instagram account.
   - Snak FB Page id: `1087111851142531` ("Snak Group")
   - Sheridan FB Page id: `930335943504116` ("Sheridan Trailer Rentals")
3. Regenerate each Page access token **with these scopes added**: `instagram_basic`,
   `instagram_content_publish` (keep `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`).
   Use the same Meta app / Graph API Explorer that produced the current tokens; prefer a
   long-lived token.
4. Send me the two refreshed long-lived page tokens.

What I do once you've done 1–3 and sent the tokens:
- Update `FB_PAGE_ACCESS_TOKEN_SNAK` / `FB_PAGE_ACCESS_TOKEN_SHERIDAN` in `.env`.
- Resolve each IG business-account id automatically:
  `GET /{page-id}?fields=instagram_business_account&access_token={token}`.
- Add `IG_ACCOUNT_ID_SNAK` / `IG_ACCOUNT_ID_SHERIDAN` to `.env` and add a per-group
  `secretOverride` `IG_ACCOUNT_ID → IG_ACCOUNT_ID_<GROUP>` in `registered_groups.container_config`
  (mirrors the existing `FB_PAGE_ACCESS_TOKEN` override). Token auto-falls back to the page token.
- Smoke-test: `post-instagram.ts --dry-run`, then one real post.

`.env` keys: `IG_ACCOUNT_ID_SNAK=`, `IG_ACCOUNT_ID_SHERIDAN=` (token via the FB page token fallback).

---

## Google Business Profile  (needs you: enable 3 APIs + add SA as Manager; possible Google approval wait)

GBP = your Google Maps + Google Search business listing (local-intent SEO: "vending near me",
"trailer rental near me"). The tool (`tools/gbp/gbp.ts`) and skill are already built and complete
(post, reviews, reply-review, insights, update-info, Q&A). This is **unblocking credentials, not
building.** Auth is the **service account** `nanoclaw@nanoclaw-sheets.iam.gserviceaccount.com`
(project `nanoclaw-sheets` #`318247064142`, scope `business.manage`) — the same "grant the SA
access" model as the Drive asset folder.

Status 2026-06-05 (updated): APIs **enabled** ✅ (the `403 SERVICE_DISABLED` is gone). New blocker
surfaced — `429 RESOURCE_EXHAUSTED` with `quota_limit_value: "0"`. **This is Google's access gate:
a brand-new project gets a 0/min GBP quota until you submit the Business Profile API access-request
form and Google approves the project.** It is NOT a transient rate limit (a temporary one reports
your real limit, not 0) and NOT fixable from our side — it requires the form + approval (often a
few days to ~2 weeks). The SA authenticates fine; secret plumbing is staged (`GBP_ACCOUNT_ID`,
`GBP_LOCATION_ID_SNAK`, `GBP_LOCATION_ID_SHERIDAN` in `SECRETS_GOOGLE`). Nothing else can move until
the quota is granted.

**ACTION (you): submit the access-request form** → https://support.google.com/business/contact/api_default
- GCP project number: `318247064142`  ·  project ID: `nanoclaw-sheets`
- Use a business email; describe the use (manage posts/reviews/insights for your own verified
  Business Profiles — Snak Group + Sheridan Trailer Rentals).
- After approval the quota flips from 0 to a default (~300/min) and all GBP calls start working.

### Your steps

**1. Enable these 3 APIs** in Google Cloud Console → project **nanoclaw-sheets** (`318247064142`).
   Open each link, confirm the project selector reads `nanoclaw-sheets`, click **Enable**:
   - My Business Account Management API
     https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com?project=318247064142
   - My Business Business Information API
     https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com?project=318247064142
   - Business Profile Performance API (powers `insights`)
     https://console.cloud.google.com/apis/library/businessprofileperformance.googleapis.com?project=318247064142
   - ⚠️ Google gates the Business Profile APIs behind a one-time access-request form. If **Enable**
     works immediately, you're done. If it routes you to a request form, submit it
     (https://developers.google.com/my-business/content/prereqs → "Request access") and we wait for
     approval (often a few days). Tell me which path you got.

**2. Add the service account as a Manager** on each Google Business Profile.
   In the Business Profile Manager (https://business.google.com/) → pick the business →
   **Settings → People and access → Add** → paste the SA email → role **Manager** → invite:
   - SA email: `nanoclaw@nanoclaw-sheets.iam.gserviceaccount.com`
   - **Sheridan Trailer Rentals** — confirmed live/verified, CID `17086387066189926116`
   - **Snak Group** — CID `8865076510470628711`. ⚠️ First confirm this profile actually exists and
     is **claimed + verified**. If Snak has no profile yet, that's a separate "create & verify"
     step (like the IG accounts) before the SA can be added.
   - Note: a service account can't "accept" an email invite, but Business Profile grants SA/Manager
     access immediately on add — no acceptance needed.

**3. Ping me** once the APIs are enabled and the SA is added (per profile is fine — I can wire
   Sheridan first if Snak's profile isn't ready).

### What I do next (autonomous, ~5 min once unblocked)
- List `accounts/*` + `accounts/*/locations/*` with the SA token → capture the real resource IDs.
- Fill `.env`: `GBP_ACCOUNT_ID`, `GBP_LOCATION_ID_SNAK`, `GBP_LOCATION_ID_SHERIDAN`; one
  `systemctl restart nanoclaw` to load the new keys.
- Smoke-test per profile: pull reviews + publish one real photo post (`gbp.ts post --photo-url`,
  fed by a `prepare-asset` public URL), selecting the business via `GBP_BUSINESS=SNAK|SHERIDAN`.
- Report the result; then optionally fold GBP into the `post-all` receipt so one approved update
  can hit social + the Google listing together.

`.env` keys (I fill these): `GBP_ACCOUNT_ID=`, `GBP_LOCATION_ID_SNAK=`, `GBP_LOCATION_ID_SHERIDAN=`.

---

## LinkedIn  (WORKING as of 2026-06-03 — token expires ~2026-08-02)

Live-verified. App "Snak Group" (client id `862jihwphb3595`). Posting member is Blayke Elder,
`LINKEDIN_PERSON_URN=urn:li:person:8Tg2YJxvL1` (resolved via `/v2/userinfo` `sub`; the old
`urn:li:person:808147689` was a stale/legacy id and caused 403s).

**Renew when it expires (~every 2 months):** LinkedIn's token generator does NOT issue a refresh
token, so this is manual until the app is approved for programmatic refresh tokens.
1. https://www.linkedin.com/developers/tools/oauth/token-generator → app **Snak Group** →
   scopes **openid + profile + w_member_social** → Request access token → authorize.
2. Send me the new access token; I replace `LINKEDIN_ACCESS_TOKEN` in `.env`. (URN stays the same.)

**To make it never expire (optional, durable):** get the app approved for refresh tokens, then
provide `LINKEDIN_REFRESH_TOKEN` — `post-linkedin.ts` already auto-refreshes when client id/secret
+ refresh token are all present (`LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` are already stored).

---

## X / Twitter  (needs you: X developer app)

Posting uses **OAuth 1.0a user context** (`post-tweet.ts`), so you need 4 keys (the bearer token
is read-only and not enough to post).

Steps:
1. Create/confirm an **X developer app** with **Read+Write** permission for each business account.
2. From the app's *Keys and tokens*, generate: API Key, API Secret, Access Token, Access Secret.
3. Send them to me.

`.env` keys (one set; if both businesses need separate accounts, we'll add per-group overrides):
```
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
TWITTER_BEARER_TOKEN=    # optional, for reads
```

---

## TikTok  (needs you: TikTok for Developers + Content Publishing API approval)

Steps:
1. Create a **TikTok for Developers** app; apply for the **Content Posting API** (review required).
2. Complete OAuth for each business account; obtain an access token.
3. Send the token(s).

`.env` keys:
```
TIKTOK_ACCESS_TOKEN=
TIKTOK_OPEN_ID=          # optional
```
Note: TikTok posts require a **public video URL** (`post-all --video <url>`); text/image-only is skipped.

---

## Google Ads  (needs you: developer token + OAuth; heaviest setup)

Not posting — paid search to capture "trailer rental Houston" / "vending Houston" intent.

Steps:
1. In a **Google Ads manager (MCC) account**, request a **Developer Token** (basic access).
2. Create OAuth client credentials (Client ID + Secret) and generate a **refresh token** for the
   account that manages the Ads accounts.
3. Get each business's **Customer ID**.
4. Send all five values.

`.env` keys:
```
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=
GOOGLE_ADS_CUSTOMER_ID=
```

---

## After any platform is wired

```bash
ssh nanoclaw
cd /home/nanoclaw/nanoclaw
# edit .env, then:
sudo systemctl restart nanoclaw
# verify (group-resolved env): the receipt should flip ❌ → ✅ for the platform
npx tsx tools/social/post-all.ts --group snak --message "test" --image <url> --dry-run
```
