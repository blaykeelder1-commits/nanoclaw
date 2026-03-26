#!/usr/bin/env npx tsx
/**
 * Google Business Profile Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/gbp/gbp.ts post --summary "Check out our new menu!" [--url https://example.com] [--photo-url https://...] [--topic-type STANDARD|EVENT|OFFER] [--dry-run]
 *   npx tsx tools/gbp/gbp.ts reviews [--limit 10] [--unreplied-only]
 *   npx tsx tools/gbp/gbp.ts reply-review --review-id <id> --comment "Thank you for your feedback!"
 *   npx tsx tools/gbp/gbp.ts insights [--days 30]
 *   npx tsx tools/gbp/gbp.ts update-info [--description "..."] [--hours '{"monday":{"open":"09:00","close":"17:00"}}'] [--category "restaurant"]
 *   npx tsx tools/gbp/gbp.ts questions [--limit 10] [--answer "Yes, we do!"]
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY — JSON string of the service account key
 *   GBP_ACCOUNT_ID            — Google Business Profile account ID
 *   GBP_LOCATION_ID           — Location ID
 */

import { google } from 'googleapis';
import https from 'https';

type Action = 'post' | 'reviews' | 'reply-review' | 'insights' | 'update-info' | 'questions';

const VALID_ACTIONS: Action[] = ['post', 'reviews', 'reply-review', 'insights', 'update-info', 'questions'];

interface Args {
  action: Action;
  // post
  summary?: string;
  url?: string;
  photoUrl?: string;
  topicType?: string;
  dryRun?: boolean;
  // reviews / questions
  limit?: number;
  unrepliedOnly?: boolean;
  // reply-review
  reviewId?: string;
  comment?: string;
  // insights
  days?: number;
  // update-info
  description?: string;
  hours?: string;
  category?: string;
  // questions
  answer?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  if (!VALID_ACTIONS.includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: ${VALID_ACTIONS.join(', ')}`,
      usage: [
        'npx tsx tools/gbp/gbp.ts post --summary "text" [--url <url>] [--photo-url <url>] [--topic-type STANDARD|EVENT|OFFER] [--dry-run]',
        'npx tsx tools/gbp/gbp.ts reviews [--limit 10] [--unreplied-only]',
        'npx tsx tools/gbp/gbp.ts reply-review --review-id <id> --comment "text"',
        'npx tsx tools/gbp/gbp.ts insights [--days 30]',
        'npx tsx tools/gbp/gbp.ts update-info [--description "..."] [--hours \'{"monday":...}\'] [--category "..."]',
        'npx tsx tools/gbp/gbp.ts questions [--limit 10] [--answer "text"]',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--dry-run' || argv[i] === '--unreplied-only') {
      boolFlags.add(argv[i].slice(2));
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return {
    action,
    summary: flags.summary,
    url: flags.url,
    photoUrl: flags['photo-url'],
    topicType: flags['topic-type'] || 'STANDARD',
    dryRun: boolFlags.has('dry-run'),
    limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
    unrepliedOnly: boolFlags.has('unreplied-only'),
    reviewId: flags['review-id'],
    comment: flags.comment,
    days: flags.days ? parseInt(flags.days, 10) : undefined,
    description: flags.description,
    hours: flags.hours,
    category: flags.category,
    answer: flags.answer,
  };
}

function getAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (!keyJson) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable.',
    }));
    process.exit(1);
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({
      status: 'error',
      error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.',
    }));
    process.exit(1);
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/business.manage'],
  });
}

function getEnvIds(): { accountId: string; locationId: string } {
  const accountId = process.env.GBP_ACCOUNT_ID;
  const locationId = process.env.GBP_LOCATION_ID;

  if (!accountId || !locationId) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GBP_ACCOUNT_ID and/or GBP_LOCATION_ID environment variables.',
    }));
    process.exit(1);
  }

  return { accountId, locationId };
}

async function getAccessToken(auth: InstanceType<typeof google.auth.GoogleAuth>): Promise<string> {
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = typeof tokenRes === 'string' ? tokenRes : tokenRes?.token;
  if (!token) {
    throw new Error('Failed to obtain access token from service account.');
  }
  return token;
}

function apiRequest(
  method: string,
  url: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ statusCode: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      res.on('end', () => {
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ statusCode: res.statusCode || 0, data });
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ---------- Actions ----------

async function createPost(auth: InstanceType<typeof google.auth.GoogleAuth>, args: Args) {
  const { accountId, locationId } = getEnvIds();

  if (!args.summary) {
    console.error(JSON.stringify({ status: 'error', error: 'post requires --summary' }));
    process.exit(1);
  }

  const localPost: Record<string, unknown> = {
    languageCode: 'en',
    summary: args.summary,
    topicType: args.topicType,
  };

  if (args.url) {
    localPost.callToAction = {
      actionType: 'LEARN_MORE',
      url: args.url,
    };
  }

  if (args.photoUrl) {
    localPost.media = [
      {
        mediaFormat: 'PHOTO',
        sourceUrl: args.photoUrl,
      },
    ];
  }

  if (args.dryRun) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'post',
      dryRun: true,
      wouldPost: localPost,
      endpoint: `accounts/${accountId}/locations/${locationId}/localPosts`,
    }));
    return;
  }

  const token = await getAccessToken(auth);
  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/localPosts`;

  const res = await apiRequest('POST', url, token, localPost);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'post',
      data: res.data,
    }));
  } else {
    console.error(JSON.stringify({
      status: 'error',
      action: 'post',
      statusCode: res.statusCode,
      error: res.data,
    }));
    process.exit(1);
  }
}

async function fetchReviews(auth: InstanceType<typeof google.auth.GoogleAuth>, args: Args) {
  const { accountId, locationId } = getEnvIds();
  const limit = args.limit || 10;
  const token = await getAccessToken(auth);

  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews?pageSize=${limit}`;
  const res = await apiRequest('GET', url, token);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    const data = res.data as { reviews?: Array<Record<string, unknown>>; totalReviewCount?: number; averageRating?: number };
    let reviews = data.reviews || [];

    if (args.unrepliedOnly) {
      reviews = reviews.filter((r) => !r.reviewReply);
    }

    const formatted = reviews.map((r) => ({
      reviewId: r.reviewId || r.name,
      reviewer: (r.reviewer as Record<string, unknown>)?.displayName || 'Anonymous',
      starRating: r.starRating,
      comment: r.comment || '',
      createTime: r.createTime,
      hasReply: !!r.reviewReply,
      replyComment: r.reviewReply ? (r.reviewReply as Record<string, unknown>).comment : null,
      replyTime: r.reviewReply ? (r.reviewReply as Record<string, unknown>).updateTime : null,
    }));

    console.log(JSON.stringify({
      status: 'success',
      action: 'reviews',
      totalReviewCount: data.totalReviewCount,
      averageRating: data.averageRating,
      count: formatted.length,
      unrepliedOnly: args.unrepliedOnly || false,
      reviews: formatted,
    }));
  } else {
    console.error(JSON.stringify({
      status: 'error',
      action: 'reviews',
      statusCode: res.statusCode,
      error: res.data,
    }));
    process.exit(1);
  }
}

async function replyToReview(auth: InstanceType<typeof google.auth.GoogleAuth>, args: Args) {
  const { accountId, locationId } = getEnvIds();

  if (!args.reviewId) {
    console.error(JSON.stringify({ status: 'error', error: 'reply-review requires --review-id' }));
    process.exit(1);
  }
  if (!args.comment) {
    console.error(JSON.stringify({ status: 'error', error: 'reply-review requires --comment' }));
    process.exit(1);
  }

  const token = await getAccessToken(auth);
  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews/${args.reviewId}/reply`;

  const res = await apiRequest('PUT', url, token, { comment: args.comment });

  if (res.statusCode >= 200 && res.statusCode < 300) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'reply-review',
      reviewId: args.reviewId,
      comment: args.comment,
      data: res.data,
    }));
  } else {
    console.error(JSON.stringify({
      status: 'error',
      action: 'reply-review',
      statusCode: res.statusCode,
      error: res.data,
    }));
    process.exit(1);
  }
}

async function fetchInsights(auth: InstanceType<typeof google.auth.GoogleAuth>, args: Args) {
  const { locationId } = getEnvIds();
  const days = args.days || 30;
  const token = await getAccessToken(auth);

  // Use the Business Profile Performance API
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const formatDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Fetch daily metrics using the Business Profile Performance API
  const metrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'CALL_CLICKS',
    'WEBSITE_CLICKS',
    'BUSINESS_DIRECTION_REQUESTS',
  ];

  const url = `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:getDailyMetricsTimeSeries`
    + `?dailyMetric=${metrics.join('&dailyMetric=')}`
    + `&dailyRange.startDate.year=${startDate.getFullYear()}&dailyRange.startDate.month=${startDate.getMonth() + 1}&dailyRange.startDate.day=${startDate.getDate()}`
    + `&dailyRange.endDate.year=${endDate.getFullYear()}&dailyRange.endDate.month=${endDate.getMonth() + 1}&dailyRange.endDate.day=${endDate.getDate()}`;

  const res = await apiRequest('GET', url, token);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    const data = res.data as { timeSeries?: Array<Record<string, unknown>> };
    const timeSeries = data.timeSeries || [];

    // Aggregate totals per metric
    const totals: Record<string, number> = {};
    for (const series of timeSeries) {
      const metric = series.dailyMetric as string;
      const points = (series.dailyMetricTimeSeries as Record<string, unknown>)?.timeSeries as Record<string, unknown> | undefined;
      const dataPoints = (points?.dailyValues || []) as Array<Record<string, unknown>>;
      let sum = 0;
      for (const dp of dataPoints) {
        sum += (dp.value as number) || 0;
      }
      totals[metric] = sum;
    }

    const searchViews = (totals['BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'] || 0) + (totals['BUSINESS_IMPRESSIONS_MOBILE_SEARCH'] || 0);
    const mapViews = (totals['BUSINESS_IMPRESSIONS_DESKTOP_MAPS'] || 0) + (totals['BUSINESS_IMPRESSIONS_MOBILE_MAPS'] || 0);

    console.log(JSON.stringify({
      status: 'success',
      action: 'insights',
      period: {
        startDate: formatDate(startDate),
        endDate: formatDate(endDate),
        days,
      },
      metrics: {
        searchViews,
        mapViews,
        websiteClicks: totals['WEBSITE_CLICKS'] || 0,
        phoneCalls: totals['CALL_CLICKS'] || 0,
        directionRequests: totals['BUSINESS_DIRECTION_REQUESTS'] || 0,
      },
      rawTimeSeries: timeSeries,
    }));
  } else {
    console.error(JSON.stringify({
      status: 'error',
      action: 'insights',
      statusCode: res.statusCode,
      error: res.data,
    }));
    process.exit(1);
  }
}

async function updateInfo(auth: InstanceType<typeof google.auth.GoogleAuth>, args: Args) {
  const { locationId } = getEnvIds();

  const updateMask: string[] = [];
  const locationUpdate: Record<string, unknown> = {};

  if (args.description) {
    locationUpdate.profile = { description: args.description };
    updateMask.push('profile.description');
  }

  if (args.category) {
    locationUpdate.primaryCategory = { displayName: args.category };
    updateMask.push('primaryCategory');
  }

  if (args.hours) {
    let hoursObj: Record<string, { open: string; close: string }>;
    try {
      hoursObj = JSON.parse(args.hours);
    } catch {
      console.error(JSON.stringify({ status: 'error', error: '--hours must be a valid JSON string' }));
      process.exit(1);
    }

    const periods: Array<Record<string, unknown>> = [];
    const dayMap: Record<string, string> = {
      monday: 'MONDAY',
      tuesday: 'TUESDAY',
      wednesday: 'WEDNESDAY',
      thursday: 'THURSDAY',
      friday: 'FRIDAY',
      saturday: 'SATURDAY',
      sunday: 'SUNDAY',
    };

    for (const [day, times] of Object.entries(hoursObj)) {
      const gbpDay = dayMap[day.toLowerCase()];
      if (!gbpDay) continue;
      periods.push({
        openDay: gbpDay,
        openTime: { hours: parseInt(times.open.split(':')[0]), minutes: parseInt(times.open.split(':')[1]) },
        closeDay: gbpDay,
        closeTime: { hours: parseInt(times.close.split(':')[0]), minutes: parseInt(times.close.split(':')[1]) },
      });
    }

    locationUpdate.regularHours = { periods };
    updateMask.push('regularHours');
  }

  if (updateMask.length === 0) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'update-info requires at least one of: --description, --hours, --category',
    }));
    process.exit(1);
  }

  const token = await getAccessToken(auth);

  // Use the My Business Business Information API v1
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/locations/${locationId}?updateMask=${updateMask.join(',')}`;

  const res = await apiRequest('PATCH', url, token, locationUpdate);

  if (res.statusCode >= 200 && res.statusCode < 300) {
    console.log(JSON.stringify({
      status: 'success',
      action: 'update-info',
      updatedFields: updateMask,
      data: res.data,
    }));
  } else {
    console.error(JSON.stringify({
      status: 'error',
      action: 'update-info',
      statusCode: res.statusCode,
      error: res.data,
    }));
    process.exit(1);
  }
}

async function handleQuestions(auth: InstanceType<typeof google.auth.GoogleAuth>, args: Args) {
  const { accountId, locationId } = getEnvIds();
  const limit = args.limit || 10;
  const token = await getAccessToken(auth);

  const url = `https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/questions?pageSize=${limit}`;
  const res = await apiRequest('GET', url, token);

  if (res.statusCode < 200 || res.statusCode >= 300) {
    console.error(JSON.stringify({
      status: 'error',
      action: 'questions',
      statusCode: res.statusCode,
      error: res.data,
    }));
    process.exit(1);
  }

  const data = res.data as { questions?: Array<Record<string, unknown>>; totalSize?: number };
  const questions = data.questions || [];

  // If --answer is provided, find the latest unanswered question and answer it
  if (args.answer) {
    const unanswered = questions.find(
      (q) => !q.topAnswers || (q.topAnswers as Array<unknown>).length === 0,
    );

    if (!unanswered) {
      console.log(JSON.stringify({
        status: 'success',
        action: 'questions',
        message: 'No unanswered questions found.',
        totalQuestions: data.totalSize || questions.length,
      }));
      return;
    }

    const questionName = unanswered.name as string;
    const answerUrl = `https://mybusiness.googleapis.com/v4/${questionName}/answers`;
    const answerRes = await apiRequest('POST', answerUrl, token, { text: args.answer });

    if (answerRes.statusCode >= 200 && answerRes.statusCode < 300) {
      console.log(JSON.stringify({
        status: 'success',
        action: 'questions',
        answered: true,
        questionText: unanswered.text,
        answerText: args.answer,
        data: answerRes.data,
      }));
    } else {
      console.error(JSON.stringify({
        status: 'error',
        action: 'questions',
        statusCode: answerRes.statusCode,
        error: answerRes.data,
      }));
      process.exit(1);
    }
    return;
  }

  // Otherwise, list questions
  const formatted = questions.map((q) => ({
    questionId: q.name,
    text: q.text,
    createTime: q.createTime,
    updateTime: q.updateTime,
    author: (q.author as Record<string, unknown>)?.displayName || 'Anonymous',
    upvoteCount: q.upvoteCount || 0,
    totalAnswers: q.totalAnswerCount || 0,
    topAnswers: ((q.topAnswers || []) as Array<Record<string, unknown>>).map((a) => ({
      text: a.text,
      author: (a.author as Record<string, unknown>)?.displayName || 'Owner',
      createTime: a.createTime,
    })),
  }));

  console.log(JSON.stringify({
    status: 'success',
    action: 'questions',
    totalQuestions: data.totalSize || questions.length,
    count: formatted.length,
    questions: formatted,
  }));
}

// ---------- Main ----------

async function main() {
  const args = parseArgs();
  const auth = getAuth();

  try {
    switch (args.action) {
      case 'post':
        await createPost(auth, args);
        break;

      case 'reviews':
        await fetchReviews(auth, args);
        break;

      case 'reply-review':
        await replyToReview(auth, args);
        break;

      case 'insights':
        await fetchInsights(auth, args);
        break;

      case 'update-info':
        await updateInfo(auth, args);
        break;

      case 'questions':
        await handleQuestions(auth, args);
        break;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { code?: number })?.code;
    if (statusCode === 401 || statusCode === 403) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: `Google API returned ${statusCode}. Verify: (1) Business Profile APIs are enabled in Google Cloud Console, (2) The service account has the correct permissions, (3) GBP_ACCOUNT_ID and GBP_LOCATION_ID are correct.`,
      }));
    } else if (statusCode === 404) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: 'Resource not found. Check GBP_ACCOUNT_ID, GBP_LOCATION_ID, and any resource IDs passed as flags.',
      }));
    } else {
      console.error(JSON.stringify({ status: 'error', error }));
    }
    process.exit(1);
  }
}

main();
