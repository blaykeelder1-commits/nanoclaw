#!/usr/bin/env npx tsx
/**
 * SEO Audit & Keyword Tracking Tool for NanoClaw
 *
 * Full on-page SEO auditing, keyword rank tracking, structured data validation,
 * and Core Web Vitals checking via PageSpeed Insights.
 *
 * Usage:
 *   npx tsx tools/seo/seo-audit.ts audit --url "https://snakgroup.biz"
 *   npx tsx tools/seo/seo-audit.ts keywords --domain "snakgroup.biz" --keywords "vending Houston,ice machine rental" [--location "Houston, TX"]
 *   npx tsx tools/seo/seo-audit.ts check-schema --url "https://snakgroup.biz"
 *   npx tsx tools/seo/seo-audit.ts check-speed --url "https://snakgroup.biz" [--strategy mobile]
 *
 * Environment variables:
 *   GOOGLE_SEARCH_API_KEY    — Google API key (for keywords & check-speed)
 *   GOOGLE_SEARCH_ENGINE_ID  — Custom Search Engine ID (for keywords)
 */

import https from 'https';
import http from 'http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Args {
  action: string;
  url?: string;
  domain?: string;
  keywords?: string;
  location: string;
  strategy: string;
}

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warning';
  weight: number;
  score: number; // weight if pass, weight*0.5 if warning, 0 if fail
  details: string;
  recommendation?: string;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0];

  const validActions = ['audit', 'keywords', 'check-schema', 'check-speed'];
  if (!validActions.includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: ${validActions.join(', ')}`,
      usage: [
        'npx tsx tools/seo/seo-audit.ts audit --url "https://snakgroup.biz"',
        'npx tsx tools/seo/seo-audit.ts keywords --domain "snakgroup.biz" --keywords "vending Houston,ice machine rental"',
        'npx tsx tools/seo/seo-audit.ts check-schema --url "https://snakgroup.biz"',
        'npx tsx tools/seo/seo-audit.ts check-speed --url "https://snakgroup.biz" [--strategy mobile]',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    url: flags.url,
    domain: flags.domain,
    keywords: flags.keywords,
    location: flags.location || 'Houston, TX',
    strategy: flags.strategy || 'mobile',
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers (node https module, follows redirects, 5s timeout)
// ---------------------------------------------------------------------------

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  responseTimeMs: number;
  finalUrl: string;
}

function httpGet(url: string, redirectsLeft = 3): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw SEO Audit Bot)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 5000,
    }, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308)
          && res.headers.location && redirectsLeft > 0) {
        const redirectUrl = new URL(res.headers.location, url).href;
        res.resume(); // Drain response
        httpGet(redirectUrl, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }

      let body = '';
      res.on('data', (chunk: Buffer) => body += chunk.toString());
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body,
          responseTimeMs: Date.now() - startTime,
          finalUrl: url,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Utility: extract text between tags
// ---------------------------------------------------------------------------

function extractTag(html: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const matches: string[] = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    matches.push(m[1].replace(/<[^>]*>/g, '').trim());
  }
  return matches;
}

function extractMetaContent(html: string, nameOrProperty: string): string | null {
  // Match both name="..." and property="..."
  const patterns = [
    new RegExp(`<meta[^>]*(?:name|property)=["']${nameOrProperty}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${nameOrProperty}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// ACTION: audit
// ---------------------------------------------------------------------------

async function runAudit(url: string) {
  if (!url.startsWith('http')) url = `https://${url}`;
  const parsedUrl = new URL(url);
  const baseOrigin = parsedUrl.origin;

  const checks: CheckResult[] = [];

  // Fetch the page
  let response: HttpResponse;
  try {
    response = await httpGet(url);
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    }));
    return;
  }

  const html = response.body;

  // --- HTTPS Check (weight: 10) ---
  const isHttps = response.finalUrl.startsWith('https://');
  checks.push({
    name: 'HTTPS',
    status: isHttps ? 'pass' : 'fail',
    weight: 10,
    score: isHttps ? 10 : 0,
    details: isHttps ? 'Site is served over HTTPS' : 'Site is NOT served over HTTPS',
    recommendation: isHttps ? undefined : 'Install an SSL certificate and redirect all HTTP traffic to HTTPS',
  });

  // --- Title Tag (weight: 10) ---
  const titles = extractTag(html, 'title');
  const title = titles[0] || '';
  const titleLen = title.length;
  if (!title) {
    checks.push({ name: 'Title Tag', status: 'fail', weight: 10, score: 0, details: 'No <title> tag found', recommendation: 'Add a descriptive title tag between 50-60 characters' });
  } else if (titleLen >= 50 && titleLen <= 60) {
    checks.push({ name: 'Title Tag', status: 'pass', weight: 10, score: 10, details: `Title: "${title}" (${titleLen} chars — optimal)` });
  } else {
    checks.push({ name: 'Title Tag', status: 'warning', weight: 10, score: 5, details: `Title: "${title}" (${titleLen} chars — optimal is 50-60)`, recommendation: titleLen < 50 ? 'Title is too short. Add more descriptive keywords.' : 'Title is too long. Trim to 60 characters to avoid truncation in search results.' });
  }

  // --- Meta Description (weight: 10) ---
  const metaDesc = extractMetaContent(html, 'description');
  if (!metaDesc) {
    checks.push({ name: 'Meta Description', status: 'fail', weight: 10, score: 0, details: 'No meta description found', recommendation: 'Add a meta description tag between 150-160 characters with target keywords' });
  } else if (metaDesc.length >= 150 && metaDesc.length <= 160) {
    checks.push({ name: 'Meta Description', status: 'pass', weight: 10, score: 10, details: `Meta description: "${metaDesc.substring(0, 80)}..." (${metaDesc.length} chars — optimal)` });
  } else {
    checks.push({ name: 'Meta Description', status: 'warning', weight: 10, score: 5, details: `Meta description: "${metaDesc.substring(0, 80)}..." (${metaDesc.length} chars — optimal is 150-160)`, recommendation: metaDesc.length < 150 ? 'Meta description is too short. Expand with relevant keywords and a call to action.' : 'Meta description is too long. Trim to 160 characters to avoid truncation.' });
  }

  // --- H1 Tag (weight: 8) ---
  const h1s = extractTag(html, 'h1');
  if (h1s.length === 0) {
    checks.push({ name: 'H1 Tag', status: 'fail', weight: 8, score: 0, details: 'No H1 tag found', recommendation: 'Add exactly one H1 tag containing your primary keyword' });
  } else if (h1s.length === 1) {
    checks.push({ name: 'H1 Tag', status: 'pass', weight: 8, score: 8, details: `H1: "${h1s[0]}" (exactly one — good)` });
  } else {
    checks.push({ name: 'H1 Tag', status: 'warning', weight: 8, score: 4, details: `Found ${h1s.length} H1 tags (should be exactly one)`, recommendation: 'Use only one H1 tag per page. Demote extras to H2.' });
  }

  // --- Heading Hierarchy (weight: 5) ---
  const headingRegex = /<(h[1-6])[^>]*>/gi;
  const headingLevels: number[] = [];
  let hm;
  while ((hm = headingRegex.exec(html)) !== null) {
    headingLevels.push(parseInt(hm[1][1]));
  }
  let hierarchyOk = true;
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] > headingLevels[i - 1] + 1) {
      hierarchyOk = false;
      break;
    }
  }
  if (headingLevels.length === 0) {
    checks.push({ name: 'Heading Hierarchy', status: 'fail', weight: 5, score: 0, details: 'No heading tags found', recommendation: 'Add a proper heading structure (H1 > H2 > H3)' });
  } else if (hierarchyOk) {
    checks.push({ name: 'Heading Hierarchy', status: 'pass', weight: 5, score: 5, details: `Proper heading hierarchy (${headingLevels.length} headings found)` });
  } else {
    checks.push({ name: 'Heading Hierarchy', status: 'warning', weight: 5, score: 2.5, details: `Heading hierarchy has gaps (e.g., H1 then H3 without H2)`, recommendation: 'Fix heading structure so levels don\'t skip (e.g., H1 > H2 > H3, not H1 > H3)' });
  }

  // --- Image Alt Text (weight: 7) ---
  const imgRegex = /<img[^>]*>/gi;
  const imgs: string[] = [];
  let im;
  while ((im = imgRegex.exec(html)) !== null) {
    imgs.push(im[0]);
  }
  const imgsWithAlt = imgs.filter(tag => /alt=["'][^"']+["']/i.test(tag));
  const totalImgs = imgs.length;
  const altPercent = totalImgs === 0 ? 100 : Math.round((imgsWithAlt.length / totalImgs) * 100);
  if (totalImgs === 0) {
    checks.push({ name: 'Image Alt Text', status: 'pass', weight: 7, score: 7, details: 'No images found on page (N/A)' });
  } else if (altPercent >= 90) {
    checks.push({ name: 'Image Alt Text', status: 'pass', weight: 7, score: 7, details: `${imgsWithAlt.length}/${totalImgs} images have alt text (${altPercent}%)` });
  } else if (altPercent >= 50) {
    checks.push({ name: 'Image Alt Text', status: 'warning', weight: 7, score: 3.5, details: `${imgsWithAlt.length}/${totalImgs} images have alt text (${altPercent}%)`, recommendation: 'Add descriptive alt text to all images for accessibility and SEO' });
  } else {
    checks.push({ name: 'Image Alt Text', status: 'fail', weight: 7, score: 0, details: `Only ${imgsWithAlt.length}/${totalImgs} images have alt text (${altPercent}%)`, recommendation: 'Most images are missing alt text. Add descriptive alt attributes to every image.' });
  }

  // --- Canonical URL (weight: 7) ---
  const canonicalMatch = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)
    || html.match(/<link[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  if (canonicalMatch) {
    checks.push({ name: 'Canonical URL', status: 'pass', weight: 7, score: 7, details: `Canonical URL: ${canonicalMatch[1]}` });
  } else {
    checks.push({ name: 'Canonical URL', status: 'fail', weight: 7, score: 0, details: 'No canonical URL tag found', recommendation: 'Add <link rel="canonical" href="..."> to prevent duplicate content issues' });
  }

  // --- Mobile Viewport (weight: 8) ---
  const viewportMatch = html.match(/<meta[^>]*name=["']viewport["'][^>]*>/i);
  if (viewportMatch) {
    checks.push({ name: 'Mobile Viewport', status: 'pass', weight: 8, score: 8, details: 'Viewport meta tag found' });
  } else {
    checks.push({ name: 'Mobile Viewport', status: 'fail', weight: 8, score: 0, details: 'No viewport meta tag found', recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> for mobile-friendliness' });
  }

  // --- Schema Markup (weight: 10) ---
  const schemaBlocks = extractJsonLd(html);
  const schemaTypes = schemaBlocks.map(b => b['@type']).flat().filter(Boolean);
  const hasLocalBusiness = schemaTypes.some(t => typeof t === 'string' && (t === 'LocalBusiness' || t.endsWith('LocalBusiness')));
  const hasOrganization = schemaTypes.some(t => typeof t === 'string' && (t === 'Organization' || t.endsWith('Organization')));
  if (hasLocalBusiness || hasOrganization) {
    checks.push({ name: 'Schema Markup', status: 'pass', weight: 10, score: 10, details: `Found schema types: ${schemaTypes.join(', ')}` });
  } else if (schemaBlocks.length > 0) {
    checks.push({ name: 'Schema Markup', status: 'warning', weight: 10, score: 5, details: `Found schema but no LocalBusiness or Organization type (found: ${schemaTypes.join(', ')})`, recommendation: 'Add LocalBusiness or Organization structured data for better local SEO' });
  } else {
    checks.push({ name: 'Schema Markup', status: 'fail', weight: 10, score: 0, details: 'No JSON-LD structured data found', recommendation: 'Add LocalBusiness schema markup with name, address, phone, hours, and geo coordinates' });
  }

  // --- Open Graph Tags (weight: 5) ---
  const ogTitle = extractMetaContent(html, 'og:title');
  const ogDesc = extractMetaContent(html, 'og:description');
  const ogImage = extractMetaContent(html, 'og:image');
  const ogPresent = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
  if (ogPresent === 3) {
    checks.push({ name: 'Open Graph Tags', status: 'pass', weight: 5, score: 5, details: `og:title, og:description, og:image all present` });
  } else if (ogPresent > 0) {
    const missing = [];
    if (!ogTitle) missing.push('og:title');
    if (!ogDesc) missing.push('og:description');
    if (!ogImage) missing.push('og:image');
    checks.push({ name: 'Open Graph Tags', status: 'warning', weight: 5, score: 2.5, details: `Missing OG tags: ${missing.join(', ')}`, recommendation: `Add the missing Open Graph tags for better social media sharing` });
  } else {
    checks.push({ name: 'Open Graph Tags', status: 'fail', weight: 5, score: 0, details: 'No Open Graph tags found', recommendation: 'Add og:title, og:description, and og:image meta tags for social media sharing' });
  }

  // --- Page Speed Indicator (weight: 7) ---
  const responseTime = response.responseTimeMs;
  if (responseTime < 1000) {
    checks.push({ name: 'Page Speed (Response Time)', status: 'pass', weight: 7, score: 7, details: `Server response time: ${responseTime}ms (fast)` });
  } else if (responseTime < 3000) {
    checks.push({ name: 'Page Speed (Response Time)', status: 'warning', weight: 7, score: 3.5, details: `Server response time: ${responseTime}ms (moderate)`, recommendation: 'Server response time is moderate. Consider server-side caching, CDN, or upgrading hosting.' });
  } else {
    checks.push({ name: 'Page Speed (Response Time)', status: 'fail', weight: 7, score: 0, details: `Server response time: ${responseTime}ms (slow)`, recommendation: 'Server response time is very slow. Investigate server performance, enable caching, use a CDN.' });
  }

  // --- robots.txt (weight: 5) ---
  try {
    const robotsResp = await httpGet(`${baseOrigin}/robots.txt`);
    if (robotsResp.statusCode === 200 && robotsResp.body.length > 0) {
      checks.push({ name: 'robots.txt', status: 'pass', weight: 5, score: 5, details: 'robots.txt exists and is accessible' });
    } else {
      checks.push({ name: 'robots.txt', status: 'fail', weight: 5, score: 0, details: `robots.txt returned HTTP ${robotsResp.statusCode}`, recommendation: 'Create a robots.txt file at the site root with crawl directives' });
    }
  } catch {
    checks.push({ name: 'robots.txt', status: 'fail', weight: 5, score: 0, details: 'Failed to fetch robots.txt', recommendation: 'Create a robots.txt file at the site root' });
  }

  // --- sitemap.xml (weight: 8) ---
  try {
    const sitemapResp = await httpGet(`${baseOrigin}/sitemap.xml`);
    if (sitemapResp.statusCode === 200 && sitemapResp.body.includes('<urlset') || sitemapResp.body.includes('<sitemapindex')) {
      checks.push({ name: 'sitemap.xml', status: 'pass', weight: 8, score: 8, details: 'sitemap.xml exists and contains valid XML' });
    } else {
      checks.push({ name: 'sitemap.xml', status: 'fail', weight: 8, score: 0, details: `sitemap.xml returned HTTP ${sitemapResp.statusCode} or invalid content`, recommendation: 'Create an XML sitemap listing all important pages and submit it to Google Search Console' });
    }
  } catch {
    checks.push({ name: 'sitemap.xml', status: 'fail', weight: 8, score: 0, details: 'Failed to fetch sitemap.xml', recommendation: 'Create an XML sitemap and submit to Google Search Console' });
  }

  // --- Calculate overall score ---
  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const totalScore = checks.reduce((sum, c) => sum + c.score, 0);
  const overallScore = Math.round((totalScore / totalWeight) * 100);

  // Build recommendations list (only for non-pass checks)
  const recommendations = checks
    .filter(c => c.status !== 'pass' && c.recommendation)
    .sort((a, b) => b.weight - a.weight)
    .map(c => ({ check: c.name, priority: c.weight >= 8 ? 'high' : c.weight >= 5 ? 'medium' : 'low', recommendation: c.recommendation }));

  console.log(JSON.stringify({
    status: 'success',
    action: 'audit',
    url: response.finalUrl,
    overallScore,
    scoreBreakdown: { earned: Math.round(totalScore * 10) / 10, possible: totalWeight },
    checks: checks.map(c => ({ name: c.name, status: c.status, details: c.details })),
    recommendations,
    meta: {
      responseTimeMs: response.responseTimeMs,
      statusCode: response.statusCode,
      checkedAt: new Date().toISOString(),
    },
  }));
}

// ---------------------------------------------------------------------------
// ACTION: keywords
// ---------------------------------------------------------------------------

async function runKeywords(domain: string, keywords: string[], location: string) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !cx) {
    console.log(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_ENGINE_ID environment variables',
    }));
    return;
  }

  const results: Array<{
    keyword: string;
    position: number | string;
    url: string | null;
    title: string | null;
  }> = [];

  for (const keyword of keywords) {
    const trimmedKeyword = keyword.trim();
    if (!trimmedKeyword) continue;

    try {
      const query = encodeURIComponent(trimmedKeyword);
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${query}&gl=us&num=10`;

      const resp = await httpGet(searchUrl);
      const data = JSON.parse(resp.body);

      if (data.error) {
        results.push({ keyword: trimmedKeyword, position: 'error', url: null, title: data.error.message });
        continue;
      }

      const items: Array<{ link: string; title: string; displayLink: string }> = data.items || [];

      // Find the domain in results
      let found = false;
      for (let i = 0; i < items.length; i++) {
        const itemDomain = items[i].displayLink?.replace(/^www\./, '');
        const targetDomain = domain.replace(/^www\./, '');
        if (itemDomain === targetDomain || items[i].link?.includes(domain)) {
          results.push({
            keyword: trimmedKeyword,
            position: i + 1,
            url: items[i].link,
            title: items[i].title,
          });
          found = true;
          break;
        }
      }

      if (!found) {
        results.push({ keyword: trimmedKeyword, position: '>10', url: null, title: null });
      }

      // Rate limit between requests
      if (keywords.indexOf(keyword) < keywords.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (err) {
      results.push({ keyword: trimmedKeyword, position: 'error', url: null, title: err instanceof Error ? err.message : String(err) });
    }
  }

  const ranked = results.filter(r => typeof r.position === 'number');
  const avgPosition = ranked.length > 0
    ? Math.round((ranked.reduce((s, r) => s + (r.position as number), 0) / ranked.length) * 10) / 10
    : null;

  console.log(JSON.stringify({
    status: 'success',
    action: 'keywords',
    domain,
    location,
    totalKeywords: results.length,
    inTop10: ranked.length,
    averagePosition: avgPosition,
    results,
    checkedAt: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// ACTION: check-schema
// ---------------------------------------------------------------------------

function extractJsonLd(html: string): Record<string, unknown>[] {
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks: Record<string, unknown>[] = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) {
        blocks.push(...parsed);
      } else {
        blocks.push(parsed);
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  return blocks;
}

async function runCheckSchema(url: string) {
  if (!url.startsWith('http')) url = `https://${url}`;

  let response: HttpResponse;
  try {
    response = await httpGet(url);
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
    }));
    return;
  }

  const schemas = extractJsonLd(response.body);
  const findings: Array<{ type: string; data: Record<string, unknown>; missingFields: string[]; status: string }> = [];
  const recommendations: string[] = [];

  // Check for LocalBusiness
  const localBusinessRequiredFields = ['name', 'address', 'telephone', 'openingHoursSpecification', 'geo', 'url', 'image'];
  const localBusiness = schemas.find(s => {
    const t = s['@type'];
    return t === 'LocalBusiness' || (Array.isArray(t) && t.includes('LocalBusiness'))
      || (typeof t === 'string' && t.endsWith('LocalBusiness'));
  });

  if (localBusiness) {
    const missing = localBusinessRequiredFields.filter(f => !localBusiness[f]);
    findings.push({
      type: 'LocalBusiness',
      data: localBusiness,
      missingFields: missing,
      status: missing.length === 0 ? 'complete' : 'incomplete',
    });
    if (missing.length > 0) {
      recommendations.push(`LocalBusiness schema is missing: ${missing.join(', ')}`);
    }
  } else {
    recommendations.push('No LocalBusiness schema found. This is critical for local SEO — add one with name, address, phone, hours, geo, url, and image.');
  }

  // Check for Organization
  const organization = schemas.find(s => {
    const t = s['@type'];
    return t === 'Organization' || (Array.isArray(t) && t.includes('Organization'));
  });

  if (organization) {
    const orgFields = ['name', 'url', 'logo'];
    const missing = orgFields.filter(f => !organization[f]);
    findings.push({
      type: 'Organization',
      data: organization,
      missingFields: missing,
      status: missing.length === 0 ? 'complete' : 'incomplete',
    });
    if (missing.length > 0) {
      recommendations.push(`Organization schema is missing: ${missing.join(', ')}`);
    }
  } else {
    recommendations.push('No Organization schema found. Consider adding one with name, url, and logo.');
  }

  // Check for Service schemas
  const services = schemas.filter(s => {
    const t = s['@type'];
    return t === 'Service' || (Array.isArray(t) && t.includes('Service'));
  });

  if (services.length > 0) {
    for (const svc of services) {
      const serviceFields = ['name', 'description', 'provider'];
      const missing = serviceFields.filter(f => !svc[f]);
      findings.push({
        type: 'Service',
        data: svc,
        missingFields: missing,
        status: missing.length === 0 ? 'complete' : 'incomplete',
      });
    }
  } else {
    recommendations.push('No Service schema found. If you offer services, add Service structured data.');
  }

  // List all other schema types found
  const otherSchemas = schemas.filter(s => {
    const t = s['@type'];
    return !['LocalBusiness', 'Organization', 'Service'].includes(t as string);
  });

  console.log(JSON.stringify({
    status: 'success',
    action: 'check-schema',
    url,
    totalSchemasFound: schemas.length,
    findings,
    otherSchemaTypes: otherSchemas.map(s => s['@type']).filter(Boolean),
    recommendations,
    checkedAt: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// ACTION: check-speed
// ---------------------------------------------------------------------------

async function runCheckSpeed(url: string, strategy: string) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;

  if (!apiKey) {
    console.log(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SEARCH_API_KEY environment variable',
    }));
    return;
  }

  if (!url.startsWith('http')) url = `https://${url}`;
  const encodedUrl = encodeURIComponent(url);
  const psiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodedUrl}&strategy=${strategy}&key=${apiKey}`;

  let resp: HttpResponse;
  try {
    resp = await httpGet(psiUrl);
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Failed to reach PageSpeed Insights API: ${err instanceof Error ? err.message : String(err)}`,
    }));
    return;
  }

  const data = JSON.parse(resp.body);

  if (data.error) {
    console.log(JSON.stringify({
      status: 'error',
      error: data.error.message || 'PageSpeed Insights API error',
      details: data.error,
    }));
    return;
  }

  const lighthouse = data.lighthouseResult;
  if (!lighthouse) {
    console.log(JSON.stringify({
      status: 'error',
      error: 'No Lighthouse results in API response',
    }));
    return;
  }

  const performanceScore = Math.round((lighthouse.categories?.performance?.score || 0) * 100);

  // Extract Core Web Vitals
  const audits = lighthouse.audits || {};

  function getMetric(auditKey: string): { value: string; numericValue: number; rating: string } | null {
    const audit = audits[auditKey];
    if (!audit) return null;
    const rating = audit.score === null ? 'unknown'
      : audit.score >= 0.9 ? 'good'
      : audit.score >= 0.5 ? 'needs-improvement'
      : 'poor';
    return {
      value: audit.displayValue || String(audit.numericValue),
      numericValue: audit.numericValue || 0,
      rating,
    };
  }

  const metrics = {
    LCP: getMetric('largest-contentful-paint'),
    INP: getMetric('interaction-to-next-paint') || getMetric('max-potential-fid'),
    CLS: getMetric('cumulative-layout-shift'),
    FCP: getMetric('first-contentful-paint'),
    TTFB: getMetric('server-response-time'),
  };

  // Extract top opportunities
  const opportunities: Array<{ title: string; savings: string }> = [];
  const opportunityAudits = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'modern-image-formats',
    'offscreen-images',
    'efficiently-encode-images',
    'uses-text-compression',
    'uses-responsive-images',
    'server-response-time',
    'redirects',
    'uses-rel-preconnect',
    'uses-long-cache-ttl',
    'total-byte-weight',
  ];

  for (const key of opportunityAudits) {
    const audit = audits[key];
    if (audit && audit.score !== null && audit.score < 0.9 && audit.details?.overallSavingsMs) {
      opportunities.push({
        title: audit.title,
        savings: `${Math.round(audit.details.overallSavingsMs)}ms`,
      });
    }
  }

  opportunities.sort((a, b) => parseInt(b.savings) - parseInt(a.savings));

  console.log(JSON.stringify({
    status: 'success',
    action: 'check-speed',
    url,
    strategy,
    performanceScore,
    metrics,
    topOpportunities: opportunities.slice(0, 5),
    checkedAt: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  try {
    switch (args.action) {
      case 'audit':
        if (!args.url) {
          console.error(JSON.stringify({ status: 'error', error: 'audit requires --url' }));
          process.exit(1);
        }
        await runAudit(args.url);
        break;

      case 'keywords':
        if (!args.domain) {
          console.error(JSON.stringify({ status: 'error', error: 'keywords requires --domain' }));
          process.exit(1);
        }
        if (!args.keywords) {
          console.error(JSON.stringify({ status: 'error', error: 'keywords requires --keywords (comma-separated)' }));
          process.exit(1);
        }
        await runKeywords(args.domain, args.keywords.split(','), args.location);
        break;

      case 'check-schema':
        if (!args.url) {
          console.error(JSON.stringify({ status: 'error', error: 'check-schema requires --url' }));
          process.exit(1);
        }
        await runCheckSchema(args.url);
        break;

      case 'check-speed':
        if (!args.url) {
          console.error(JSON.stringify({ status: 'error', error: 'check-speed requires --url' }));
          process.exit(1);
        }
        await runCheckSpeed(args.url, args.strategy);
        break;
    }
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
