---
name: social-posting
description: Post content to X (Twitter), Facebook, and LinkedIn. Use when asked to post on social media, share content, or manage social presence.
allowed-tools: Bash(npx tsx /workspace/project/tools/social/post-tweet.ts *), Bash(npx tsx /workspace/project/tools/social/post-facebook.ts *), Bash(npx tsx /workspace/project/tools/social/post-linkedin.ts *)
---

# Social Media Posting

## Post to X (Twitter)

```bash
npx tsx /workspace/project/tools/social/post-tweet.ts \
  --text "Your tweet content (max 280 chars)"
```

Options:
- `--text` (required): Tweet content (280 char limit)
- `--reply-to`: Tweet ID to reply to

## Post to Facebook Page

```bash
npx tsx /workspace/project/tools/social/post-facebook.ts \
  --message "Your post content"
```

Options:
- `--message` (required): Post content
- `--link`: URL to include
- `--image`: Image URL to attach

## Post to LinkedIn

```bash
npx tsx /workspace/project/tools/social/post-linkedin.ts \
  --text "Your post content"
```

Options:
- `--text` (required): Post content
- `--link`: URL to share
- `--visibility`: "PUBLIC" (default) or "CONNECTIONS"

## Platform-Specific Guidelines

### X/Twitter
- Max 280 characters
- Use hashtags strategically (2-3 per tweet)
- Best times: 9 AM, 12 PM, 5 PM

### Facebook
- Optimal length: 40-80 characters for engagement
- Include images when possible
- Ask questions to drive engagement

### LinkedIn
- Professional tone
- 1,300 characters is the sweet spot
- Use line breaks for readability
- Post industry insights and thought leadership

## Cross-Platform Posting

When posting the same content across platforms, adapt the message for each:
1. Start with the core message
2. Adjust length for each platform
3. Add platform-specific elements (hashtags for Twitter, professional tone for LinkedIn)
4. Never post identical content across all platforms
