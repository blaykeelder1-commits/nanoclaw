#!/usr/bin/env npx tsx
/**
 * Post to LinkedIn Tool for NanoClaw
 * Usage: npx tsx tools/social/post-linkedin.ts --text "post content" [--link "url"] [--visibility "PUBLIC"] [--dry-run]
 *
 * Uses LinkedIn API v2.
 * Auth (preferred, self-healing): LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET + LINKEDIN_REFRESH_TOKEN
 *   → a fresh access token is minted on each run so it never silently expires.
 * Auth (fallback, legacy): LINKEDIN_ACCESS_TOKEN (a static token that expires ~every 60 days).
 * Always required: LINKEDIN_PERSON_URN (format: urn:li:person:XXXXX).
 */

import https from 'https';

interface LinkedInArgs {
  text: string;
  link?: string;
  visibility?: string;
  dryRun?: boolean;
}

function parseArgs(): LinkedInArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  const dryRun = args.includes('--dry-run');

  if (!result.text) {
    console.error('Usage: post-linkedin --text "post content" [--link "url"] [--visibility "PUBLIC"] [--dry-run]');
    process.exit(1);
  }

  return { ...result, dryRun } as unknown as LinkedInArgs;
}

/**
 * Exchange the long-lived refresh token for a fresh access token.
 * Returns the new access token, or throws on failure.
 */
function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        let parsed: { access_token?: string } | null = null;
        try { parsed = JSON.parse(data); } catch { /* non-JSON */ }
        if (res.statusCode === 200 && parsed?.access_token) {
          resolve(parsed.access_token);
        } else {
          reject(new Error(`token refresh failed (HTTP ${res.statusCode}): ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Resolve a usable access token: refresh-token flow if client creds are present,
 * otherwise the static LINKEDIN_ACCESS_TOKEN.
 */
async function resolveAccessToken(): Promise<string | undefined> {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const refreshToken = process.env.LINKEDIN_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    return refreshAccessToken(clientId, clientSecret, refreshToken);
  }
  return process.env.LINKEDIN_ACCESS_TOKEN;
}

async function postToLinkedIn(args: LinkedInArgs): Promise<void> {
  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'dry_run',
      platform: 'linkedin',
      text: args.text,
      link: args.link || null,
      visibility: args.visibility || 'PUBLIC',
      char_count: args.text.length,
      message: 'No post was published. Remove --dry-run to post for real.',
    }));
    return;
  }

  const personUrn = process.env.LINKEDIN_PERSON_URN;
  let accessToken: string | undefined;
  try {
    accessToken = await resolveAccessToken();
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: `LinkedIn token refresh failed: ${(err as Error).message}`,
    }));
    process.exit(1);
  }

  if (!accessToken || !personUrn) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing LinkedIn credentials. Set LINKEDIN_PERSON_URN plus either (LINKEDIN_CLIENT_ID + LINKEDIN_CLIENT_SECRET + LINKEDIN_REFRESH_TOKEN) or a static LINKEDIN_ACCESS_TOKEN.',
    }));
    process.exit(1);
  }

  const body: Record<string, unknown> = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: args.text },
        shareMediaCategory: args.link ? 'ARTICLE' : 'NONE',
        ...(args.link ? {
          media: [{
            status: 'READY',
            originalUrl: args.link,
          }],
        } : {}),
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': args.visibility || 'PUBLIC',
    },
  };

  const postData = JSON.stringify(body);
  const url = 'https://api.linkedin.com/v2/ugcPosts';

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 201) {
          const postId = res.headers['x-restli-id'] || 'unknown';
          console.log(JSON.stringify({
            status: 'success',
            post_id: postId,
            text: args.text.slice(0, 100),
          }));
          resolve();
        } else {
          console.error(JSON.stringify({
            status: 'error',
            statusCode: res.statusCode,
            error: data,
          }));
          process.exit(1);
        }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({ status: 'error', error: err.message }));
      process.exit(1);
    });

    req.write(postData);
    req.end();
  });
}

postToLinkedIn(parseArgs());
