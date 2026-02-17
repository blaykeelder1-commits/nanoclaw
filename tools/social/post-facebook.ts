#!/usr/bin/env npx tsx
/**
 * Post to Facebook Page Tool for NanoClaw
 * Usage: npx tsx tools/social/post-facebook.ts --message "post content" [--link "url"] [--image "url"]
 *
 * Uses Facebook Graph API v19.0
 * Environment: FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN
 */

import https from 'https';

interface FacebookArgs {
  message: string;
  link?: string;
  image?: string;
}

function parseArgs(): FacebookArgs {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i];
    }
  }

  if (!result.message) {
    console.error('Usage: post-facebook --message "post content" [--link "url"] [--image "url"]');
    process.exit(1);
  }

  return result as unknown as FacebookArgs;
}

async function postToFacebook(args: FacebookArgs): Promise<void> {
  const pageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !accessToken) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing Facebook credentials. Set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN.',
    }));
    process.exit(1);
  }

  // If image is provided, post to /photos endpoint; otherwise /feed
  const isPhoto = !!args.image;
  const endpoint = isPhoto
    ? `/${pageId}/photos`
    : `/${pageId}/feed`;

  const params = new URLSearchParams();
  params.set('access_token', accessToken);

  if (isPhoto) {
    params.set('caption', args.message);
    params.set('url', args.image!);
  } else {
    params.set('message', args.message);
    if (args.link) params.set('link', args.link);
  }

  const postData = params.toString();
  const url = `https://graph.facebook.com/v19.0${endpoint}`;

  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          console.log(JSON.stringify({
            status: 'success',
            post_id: parsed.id || parsed.post_id,
            message: args.message.slice(0, 100),
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

postToFacebook(parseArgs());
