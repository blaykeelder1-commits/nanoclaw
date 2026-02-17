#!/usr/bin/env npx tsx
/**
 * Post to LinkedIn Tool for NanoClaw
 * Usage: npx tsx tools/social/post-linkedin.ts --text "post content" [--link "url"] [--visibility "PUBLIC"]
 *
 * Uses LinkedIn API v2
 * Environment: LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN (format: urn:li:person:XXXXX)
 */

import https from 'https';

interface LinkedInArgs {
  text: string;
  link?: string;
  visibility?: string;
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

  if (!result.text) {
    console.error('Usage: post-linkedin --text "post content" [--link "url"] [--visibility "PUBLIC"]');
    process.exit(1);
  }

  return result as unknown as LinkedInArgs;
}

async function postToLinkedIn(args: LinkedInArgs): Promise<void> {
  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  const personUrn = process.env.LINKEDIN_PERSON_URN;

  if (!accessToken || !personUrn) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing LinkedIn credentials. Set LINKEDIN_ACCESS_TOKEN and LINKEDIN_PERSON_URN.',
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
