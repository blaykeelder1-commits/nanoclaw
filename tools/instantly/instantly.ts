#!/usr/bin/env npx tsx
/**
 * Instantly.ai Integration Tool for NanoClaw
 *
 * Commands:
 *   campaigns                              — List all campaigns
 *   campaign-analytics [--id <id>]         — Get campaign analytics (all or one)
 *   create-campaign --name "name"          — Create a new campaign
 *   activate-campaign --id <id>            — Activate a campaign
 *   stop-campaign --id <id>               — Stop/pause a campaign
 *   add-leads --campaign-id <id>           — Push leads from CRM to Instantly campaign
 *     [--source <source>]                  — Filter CRM by source (e.g. google_maps)
 *     [--tag <tag>]                        — Filter CRM by tag
 *     [--min-score <n>]                    — Minimum lead score
 *     [--limit <n>]                        — Max leads to push (default: 50)
 *     [--list-id <id>]                     — Push to list instead of campaign
 *   list-leads --campaign-id <id>          — List leads in a campaign
 *     [--status <status>]                  — Filter by status
 *     [--limit <n>]                        — Max results (default: 50)
 *   sync-replies                           — Pull replies from Instantly, update CRM
 *   accounts                               — List sending accounts
 *   account-vitals --id <id>              — Test account health
 *   warmup --enable --ids <id1,id2>       — Enable warmup for accounts
 *   warmup --disable --ids <id1,id2>      — Disable warmup for accounts
 *
 * Environment:
 *   INSTANTLY_API_KEY — Your Instantly.ai API key (Bearer token)
 */

import Database from 'better-sqlite3';
import { getDbPath } from '../shared/db-path.js';
import fs from 'fs';

// ── Config ──────────────────────────────────────────────────────────

const BASE_URL = 'https://api.instantly.ai/api/v2';
const API_KEY = process.env.INSTANTLY_API_KEY || '';

if (!API_KEY) {
  console.error(JSON.stringify({
    status: 'error',
    error: 'INSTANTLY_API_KEY not set. Get your API key from Instantly → Settings → API.',
  }));
  process.exit(1);
}

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
};

// ── HTTP Helper ─────────────────────────────────────────────────────

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  let url = `${BASE_URL}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += `?${qs}`;
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Instantly API ${method} ${path}: ${resp.status} — ${text}`);
  }

  return resp.json() as T;
}

// ── DB Helper ───────────────────────────────────────────────────────

function getDb(): Database.Database {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('Database not found. Run NanoClaw first.');
  }
  return new Database(dbPath, { readonly: true });
}

// ── Commands ────────────────────────────────────────────────────────

async function listCampaigns(): Promise<void> {
  const data = await api('GET', '/campaigns');
  console.log(JSON.stringify({ status: 'success', campaigns: data }));
}

async function getCampaignAnalytics(id?: string): Promise<void> {
  const params: Record<string, string> = {};
  if (id) params.id = id;
  const data = await api('GET', '/campaigns/analytics', undefined, params);
  console.log(JSON.stringify({ status: 'success', analytics: data }));
}

async function createCampaign(name: string): Promise<void> {
  const data = await api('POST', '/campaigns', {
    name,
    campaign_schedule: {
      schedules: [
        {
          name: 'Weekdays',
          days: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: false, 0: false },
          timezone: 'America/Chicago',
          timing: { from: '09:00', to: '17:00' },
        },
      ],
    },
  });
  console.log(JSON.stringify({ status: 'success', campaign: data }));
}

async function activateCampaign(id: string): Promise<void> {
  const data = await api('POST', `/campaigns/${id}/activate`);
  console.log(JSON.stringify({ status: 'success', result: data }));
}

async function stopCampaign(id: string): Promise<void> {
  const data = await api('POST', `/campaigns/${id}/stop`);
  console.log(JSON.stringify({ status: 'success', result: data }));
}

interface CrmLead {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string | null;
  title: string | null;
  phone: string | null;
  source: string;
  lead_score: number | null;
  tags: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
}

async function addLeads(opts: {
  campaignId?: string;
  listId?: string;
  source?: string;
  tag?: string;
  minScore?: number;
  limit: number;
}): Promise<void> {
  if (!opts.campaignId && !opts.listId) {
    throw new Error('Either --campaign-id or --list-id is required');
  }

  const db = getDb();

  // Build query to pull leads from CRM
  const conditions: string[] = [];
  const params: unknown[] = [];

  // Exclude placeholder SMS emails — only push real email addresses
  conditions.push("email NOT LIKE '%@sms.nanoclaw'");

  if (opts.source) {
    conditions.push('source = ?');
    params.push(opts.source);
  }
  if (opts.tag) {
    conditions.push('tags LIKE ?');
    params.push(`%${opts.tag}%`);
  }
  if (opts.minScore !== undefined) {
    conditions.push('lead_score >= ?');
    params.push(opts.minScore);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, email, first_name, last_name, company, title, phone, source, lead_score, tags, website, city, state, industry
               FROM contacts ${where}
               ORDER BY lead_score DESC, updated_at DESC
               LIMIT ?`;
  params.push(opts.limit);

  const leads = db.prepare(sql).all(...params) as CrmLead[];

  if (leads.length === 0) {
    console.log(JSON.stringify({ status: 'success', message: 'No matching leads found in CRM', pushed: 0 }));
    return;
  }

  // Transform CRM leads to Instantly format
  const instantlyLeads = leads.map((lead) => ({
    email: lead.email,
    first_name: lead.first_name,
    last_name: lead.last_name,
    company_name: lead.company || undefined,
    phone: lead.phone || undefined,
    website: lead.website || undefined,
    custom_variables: {
      crm_id: lead.id,
      crm_source: lead.source,
      lead_score: lead.lead_score?.toString() || '0',
      title: lead.title || '',
      city: lead.city || '',
      state: lead.state || '',
      industry: lead.industry || '',
    },
  }));

  // Push in batches of 100 (Instantly API recommends reasonable batch sizes)
  const batchSize = 100;
  let totalPushed = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (let i = 0; i < instantlyLeads.length; i += batchSize) {
    const batch = instantlyLeads.slice(i, i + batchSize);
    try {
      const body: Record<string, unknown> = {
        leads: batch,
        skip_if_in_workspace: true,
      };
      if (opts.campaignId) body.campaign_id = opts.campaignId;
      if (opts.listId) body.list_id = opts.listId;

      const result = await api<{ uploaded: number; skipped?: number; errors?: unknown[] }>(
        'POST', '/leads/add', body,
      );
      totalPushed += result.uploaded || batch.length;
      totalSkipped += result.skipped || 0;
    } catch (err) {
      errors.push(`Batch ${i / batchSize + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(JSON.stringify({
    status: errors.length === 0 ? 'success' : 'partial',
    total_from_crm: leads.length,
    pushed: totalPushed,
    skipped: totalSkipped,
    errors: errors.length > 0 ? errors : undefined,
  }));
}

async function listLeads(campaignId: string, status?: string, limit = 50): Promise<void> {
  const body: Record<string, unknown> = { campaign_id: campaignId, limit };
  if (status) body.lead_status = status;

  const data = await api('POST', '/leads/list', body);
  console.log(JSON.stringify({ status: 'success', leads: data }));
}

async function syncReplies(): Promise<void> {
  // Get all campaigns first
  const campaigns = await api<{ items?: Array<{ id: string; name: string }> }>('GET', '/campaigns');
  const campaignList = campaigns.items || [];

  if (campaignList.length === 0) {
    console.log(JSON.stringify({ status: 'success', message: 'No campaigns found', synced: 0 }));
    return;
  }

  const dbPath = getDbPath();
  const db = new Database(dbPath);

  let totalSynced = 0;
  const updates: Array<{ email: string; campaign: string; interest_status: string }> = [];

  for (const campaign of campaignList) {
    // Get leads that have replied
    try {
      const data = await api<{ items?: Array<{ email: string; lead_status?: string; interest_status?: string }> }>(
        'POST', '/leads/list',
        { campaign_id: campaign.id, lead_status: 'replied', limit: 100 },
      );

      const items = data.items || [];
      for (const lead of items) {
        if (!lead.email) continue;

        // Update CRM contact if exists
        const contact = db.prepare(
          'SELECT id FROM contacts WHERE email = ?',
        ).get(lead.email) as { id: string } | undefined;

        if (contact) {
          // Check if there's an open deal for this contact
          const deal = db.prepare(
            "SELECT id, stage FROM deals WHERE contact_id = ? AND stage NOT IN ('closed_won', 'closed_lost') ORDER BY created_at DESC LIMIT 1",
          ).get(contact.id) as { id: string; stage: string } | undefined;

          if (deal && deal.stage !== 'qualified') {
            // Move to qualified — they replied
            const now = new Date().toISOString();
            db.prepare('UPDATE deals SET stage = ?, updated_at = ? WHERE id = ?')
              .run('qualified', now, deal.id);
            db.prepare(
              'INSERT INTO deal_stage_log (deal_id, from_stage, to_stage, changed_at, note) VALUES (?, ?, ?, ?, ?)',
            ).run(deal.id, deal.stage, 'qualified', now, 'Auto-updated: lead replied via Instantly campaign');
          }

          // Log the reply in outreach
          const existing = db.prepare(
            "SELECT 1 FROM outreach_log WHERE contact_id = ? AND status = 'replied' AND campaign_id = ?",
          ).get(contact.id, campaign.id);

          if (!existing) {
            db.prepare(
              `INSERT INTO outreach_log (contact_id, campaign_id, type, subject, body, status, sent_at, response_at)
               VALUES (?, ?, 'email', 'Instantly campaign reply', NULL, 'replied', ?, ?)`,
            ).run(contact.id, campaign.id, new Date().toISOString(), new Date().toISOString());
          }

          updates.push({
            email: lead.email,
            campaign: campaign.name,
            interest_status: lead.interest_status || 'unknown',
          });
          totalSynced++;
        }
      }
    } catch (err) {
      // Skip campaigns with errors
    }
  }

  db.close();

  console.log(JSON.stringify({
    status: 'success',
    synced: totalSynced,
    updates,
  }));
}

async function listAccounts(): Promise<void> {
  const data = await api('GET', '/accounts');
  console.log(JSON.stringify({ status: 'success', accounts: data }));
}

async function testVitals(id: string): Promise<void> {
  const data = await api('GET', `/accounts/${id}/test-vitals`);
  console.log(JSON.stringify({ status: 'success', vitals: data }));
}

async function warmup(enable: boolean, ids: string[]): Promise<void> {
  const endpoint = enable ? '/accounts/warmup/enable' : '/accounts/warmup/disable';
  const data = await api('POST', endpoint, { account_ids: ids });
  console.log(JSON.stringify({ status: 'success', result: data }));
}

// ── CLI Parser ──────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'campaigns':
        await listCampaigns();
        break;

      case 'campaign-analytics':
        await getCampaignAnalytics(flag(args, 'id'));
        break;

      case 'create-campaign': {
        const name = flag(args, 'name');
        if (!name) throw new Error('--name required');
        await createCampaign(name);
        break;
      }

      case 'activate-campaign': {
        const id = flag(args, 'id');
        if (!id) throw new Error('--id required');
        await activateCampaign(id);
        break;
      }

      case 'stop-campaign': {
        const id = flag(args, 'id');
        if (!id) throw new Error('--id required');
        await stopCampaign(id);
        break;
      }

      case 'add-leads':
        await addLeads({
          campaignId: flag(args, 'campaign-id'),
          listId: flag(args, 'list-id'),
          source: flag(args, 'source'),
          tag: flag(args, 'tag'),
          minScore: flag(args, 'min-score') ? parseInt(flag(args, 'min-score')!, 10) : undefined,
          limit: parseInt(flag(args, 'limit') || '50', 10),
        });
        break;

      case 'list-leads': {
        const campaignId = flag(args, 'campaign-id');
        if (!campaignId) throw new Error('--campaign-id required');
        await listLeads(campaignId, flag(args, 'status'), parseInt(flag(args, 'limit') || '50', 10));
        break;
      }

      case 'sync-replies':
        await syncReplies();
        break;

      case 'accounts':
        await listAccounts();
        break;

      case 'account-vitals': {
        const id = flag(args, 'id');
        if (!id) throw new Error('--id required');
        await testVitals(id);
        break;
      }

      case 'warmup': {
        const ids = flag(args, 'ids')?.split(',') || [];
        if (ids.length === 0) throw new Error('--ids required (comma-separated account IDs)');
        await warmup(hasFlag(args, 'enable'), ids);
        break;
      }

      default:
        console.error(JSON.stringify({
          status: 'error',
          error: `Unknown command: ${command}`,
          commands: [
            'campaigns', 'campaign-analytics', 'create-campaign',
            'activate-campaign', 'stop-campaign',
            'add-leads', 'list-leads', 'sync-replies',
            'accounts', 'account-vitals', 'warmup',
          ],
        }));
        process.exit(1);
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
