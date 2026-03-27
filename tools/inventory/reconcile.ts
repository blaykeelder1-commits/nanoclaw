#!/usr/bin/env npx tsx
/**
 * Inventory Reconciliation & Unified Decision Engine
 *
 * Cross-references IDDI, Google Sheets (Warehouse Inventory, Sales Performance,
 * Ordering List), and produces a unified inventory picture with reorder
 * recommendations, blacklist tracking, and discrepancy detection.
 *
 * Usage:
 *   npx tsx tools/inventory/reconcile.ts full [--yo-offset 2]
 *   npx tsx tools/inventory/reconcile.ts snapshot [--yo-offset 2]
 *   npx tsx tools/inventory/reconcile.ts blacklist [--yo-offset 2]
 *
 * Environment:
 *   IDDI_BASE_URL, IDDI_EMAIL, IDDI_PASSWORD — IDDI API credentials
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Google service account JSON
 *   GOOGLE_SPREADSHEET_ID — Snak Group inventory spreadsheet
 */

import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { resolveGroupDir } from '../shared/group-path.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlacklistEntry {
  product: string;
  consecutive_red_weeks: number;
  blacklisted_date: string | null;
}

type SalesColor = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
type WarehouseColor = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

interface UnifiedProduct {
  name: string;
  normalized_name: string;
  warehouse_stock: number | null;
  warehouse_color: WarehouseColor;
  sales_weeks: { week: number; units: number | null; color: SalesColor }[];
  iddi_performance: string | null;
  iddi_expiration: string | null;
  iddi_redistribution: string | null;
  blacklist_status: 'active' | 'approaching' | 'blacklisted' | 'coming_off';
  blacklist_consecutive_red: number;
  blacklist_date: string | null;
  reorder_recommendation: 'REORDER' | 'DO_NOT_REORDER';
  reorder_reason: string;
  sources: ('sheets' | 'iddi')[];
}

interface ReconciliationResult {
  timestamp: string;
  yo_offset: number;
  unified_products: UnifiedProduct[];
  reorder_list: UnifiedProduct[];
  blacklist_warnings: UnifiedProduct[];
  blacklist_now: UnifiedProduct[];
  coming_off_blacklist: UnifiedProduct[];
  discrepancies: Discrepancy[];
  summary_stats: SummaryStats;
}

interface Discrepancy {
  type: 'sheets_only' | 'iddi_only' | 'stock_mismatch' | 'priority_conflict';
  product: string;
  detail: string;
}

interface SummaryStats {
  total_products: number;
  reorder_count: number;
  blacklist_warning_count: number;
  blacklist_now_count: number;
  coming_off_count: number;
  discrepancy_count: number;
  total_warehouse_stock: number;
  yo_machines_untracked: number;
}

// ---------------------------------------------------------------------------
// IDDI API (reuses auth pattern from iddi.ts)
// ---------------------------------------------------------------------------

const IDDI_BASE = process.env.IDDI_BASE_URL;
const IDDI_EMAIL = process.env.IDDI_EMAIL;
const IDDI_PASSWORD = process.env.IDDI_PASSWORD;
const TOKEN_FILE = path.join(resolveGroupDir(), 'iddi-token.json');

async function getIddiToken(): Promise<string> {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (cached.expires_at > Date.now()) return cached.token;
    } catch { /* re-auth */ }
  }
  if (!IDDI_BASE || !IDDI_EMAIL || !IDDI_PASSWORD) {
    throw new Error('Missing IDDI env vars');
  }
  const res = await fetch(`${IDDI_BASE}/api/auth/vendor/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: IDDI_EMAIL, password: IDDI_PASSWORD }),
  });
  if (!res.ok) throw new Error(`IDDI auth failed: ${res.status}`);
  const data = await res.json();
  const token = data.token || data.accessToken || data.access_token;
  if (!token) throw new Error('IDDI auth missing token');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expires_at: Date.now() + 23 * 3600000 }));
  return token;
}

async function iddiGet(endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getIddiToken();
  const url = new URL(`${IDDI_BASE}${endpoint}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    const newToken = await getIddiToken();
    res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${newToken}` } });
  }
  if (!res.ok) throw new Error(`IDDI API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

function getSheetsClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
  if (!keyJson || !spreadsheetId) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SPREADSHEET_ID');
  const key = JSON.parse(keyJson);
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId };
}

async function readSheet(range: string): Promise<string[][]> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return (res.data.values || []) as string[][];
}

// ---------------------------------------------------------------------------
// Product Name Normalization & Fuzzy Matching
// ---------------------------------------------------------------------------

const ALIAS_FILE = path.join(resolveGroupDir(), 'product-aliases.json');

function loadAliases(): Record<string, string> {
  if (fs.existsSync(ALIAS_FILE)) {
    try { return JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf-8')); } catch { /* ignore */ }
  }
  return {};
}

function normalizeName(raw: string): string {
  const aliases = loadAliases();
  const lower = raw.trim().toLowerCase();
  if (aliases[lower]) return aliases[lower];

  return lower
    .replace(/\s*[-–—]\s*\d+\s*oz\.?/gi, '')     // "- 20oz"
    .replace(/\s*\(\d+\s*pk\)/gi, '')              // "(12pk)"
    .replace(/\s*\(\d+\s*ct\)/gi, '')              // "(12ct)"
    .replace(/\s*\(\d+\s*pack\)/gi, '')            // "(12 pack)"
    .replace(/\s*\d+\s*oz\.?$/gi, '')              // trailing "20oz"
    .replace(/\s*\d+\s*ml\.?$/gi, '')              // trailing "500ml"
    .replace(/['']/g, "'")                         // normalize quotes
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a: string, b: string): number {
  const tokA = new Set(a.split(/\s+/));
  const tokB = new Set(b.split(/\s+/));
  let overlap = 0;
  for (const t of tokA) if (tokB.has(t)) overlap++;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : overlap / union;
}

function findBestMatch(name: string, candidates: string[]): string | null {
  const norm = normalizeName(name);
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const cn = normalizeName(c);
    if (cn === norm) return c; // exact match
    const score = tokenOverlap(norm, cn);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

function parseColor(raw: string | undefined): SalesColor {
  if (!raw) return 'UNKNOWN';
  const lower = raw.trim().toLowerCase();
  if (lower.includes('green')) return 'GREEN';
  if (lower.includes('yellow')) return 'YELLOW';
  if (lower.includes('red')) return 'RED';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Blacklist State
// ---------------------------------------------------------------------------

const BLACKLIST_FILE = path.join(resolveGroupDir(), 'blacklist-state.json');
const BLACKLIST_MONTHS = 3;

function loadBlacklistState(): BlacklistEntry[] {
  if (fs.existsSync(BLACKLIST_FILE)) {
    try { return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8')); } catch { /* ignore */ }
  }
  return [];
}

function saveBlacklistState(entries: BlacklistEntry[]): void {
  fs.mkdirSync(path.dirname(BLACKLIST_FILE), { recursive: true });
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(entries, null, 2));
}

function isComingOffBlacklist(entry: BlacklistEntry): boolean {
  if (!entry.blacklisted_date) return false;
  const blacklistedAt = new Date(entry.blacklisted_date);
  const eligibleDate = new Date(blacklistedAt);
  eligibleDate.setMonth(eligibleDate.getMonth() + BLACKLIST_MONTHS);
  return new Date() >= eligibleDate;
}

function getBlacklistEligibleDate(entry: BlacklistEntry): string | null {
  if (!entry.blacklisted_date) return null;
  const d = new Date(entry.blacklisted_date);
  d.setMonth(d.getMonth() + BLACKLIST_MONTHS);
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Data Pulling
// ---------------------------------------------------------------------------

interface IddiData {
  inventory: any;
  topProducts: any;
  expiring: any;
}

async function pullIddi(): Promise<IddiData> {
  const [inventory, topProducts, expiring] = await Promise.all([
    iddiGet('/api/vendor/inventory'),
    iddiGet('/api/vendor/top-products', { limit: '100' }),
    iddiGet('/api/vendor/expiring', { days: '30' }),
  ]);
  return { inventory, topProducts, expiring };
}

interface SheetsData {
  warehouseRows: string[][];
  salesRows: string[][];
  orderingRows: string[][];
}

async function pullSheets(): Promise<SheetsData> {
  const [warehouseRows, salesRows, orderingRows] = await Promise.all([
    readSheet('Warehouse Inventory!A:G'),
    readSheet('Sales Performance!A:Z'),
    readSheet('Ordering List!A:Z'),
  ]);
  return { warehouseRows, salesRows, orderingRows };
}

// ---------------------------------------------------------------------------
// Build unified product table
// ---------------------------------------------------------------------------

function buildUnifiedProducts(
  sheetsData: SheetsData,
  iddiData: IddiData,
  yoOffset: number,
): { products: UnifiedProduct[]; discrepancies: Discrepancy[] } {

  const products: Map<string, UnifiedProduct> = new Map();
  const discrepancies: Discrepancy[] = [];

  // --- Parse Warehouse Inventory (skip header row) ---
  const whRows = sheetsData.warehouseRows.slice(1);
  for (const row of whRows) {
    const name = (row[1] || '').trim();
    if (!name) continue;
    const norm = normalizeName(name);
    const stock = parseInt(row[2] || '0', 10) || 0;
    const color = parseColor(row[4]);

    products.set(norm, {
      name,
      normalized_name: norm,
      warehouse_stock: stock,
      warehouse_color: color as WarehouseColor,
      sales_weeks: [],
      iddi_performance: null,
      iddi_expiration: null,
      iddi_redistribution: null,
      blacklist_status: 'active',
      blacklist_consecutive_red: 0,
      blacklist_date: null,
      reorder_recommendation: 'DO_NOT_REORDER',
      reorder_reason: '',
      sources: ['sheets'],
    });
  }

  // --- Parse Sales Performance (skip header) ---
  const spRows = sheetsData.salesRows;
  if (spRows.length > 0) {
    const header = spRows[0];
    // Find week columns — they contain "week" or "wk" in the header
    const weekCols: number[] = [];
    for (let i = 1; i < header.length; i++) {
      const h = (header[i] || '').toLowerCase();
      if (h.includes('week') || h.includes('wk')) weekCols.push(i);
    }

    for (let r = 1; r < spRows.length; r++) {
      const row = spRows[r];
      const name = (row[0] || '').trim();
      if (!name) continue;
      const norm = normalizeName(name);

      const weeks: UnifiedProduct['sales_weeks'] = [];
      for (let w = 0; w < weekCols.length; w++) {
        const cellVal = (row[weekCols[w]] || '').trim();
        // Cell might be "15 (GREEN)" or just "15" or "GREEN" or "15/Green"
        const numMatch = cellVal.match(/(\d+)/);
        const colorMatch = cellVal.match(/(green|yellow|red)/i);
        weeks.push({
          week: w + 1,
          units: numMatch ? parseInt(numMatch[1], 10) : null,
          color: colorMatch ? parseColor(colorMatch[1]) : 'UNKNOWN',
        });
      }

      if (products.has(norm)) {
        products.get(norm)!.sales_weeks = weeks;
      } else {
        // Product in Sales Performance but not Warehouse — try fuzzy match
        const match = findBestMatch(name, Array.from(products.keys()));
        if (match) {
          products.get(match)!.sales_weeks = weeks;
        } else {
          // Genuinely new product — add it
          products.set(norm, {
            name,
            normalized_name: norm,
            warehouse_stock: null,
            warehouse_color: 'UNKNOWN',
            sales_weeks: weeks,
            iddi_performance: null,
            iddi_expiration: null,
            iddi_redistribution: null,
            blacklist_status: 'active',
            blacklist_consecutive_red: 0,
            blacklist_date: null,
            reorder_recommendation: 'DO_NOT_REORDER',
            reorder_reason: '',
            sources: ['sheets'],
          });
        }
      }
    }
  }

  // --- Merge IDDI data ---
  const iddiProducts = extractIddiProducts(iddiData);
  const sheetNames = Array.from(products.keys());

  for (const ip of iddiProducts) {
    const norm = normalizeName(ip.name);
    let target = products.get(norm);
    if (!target) {
      const match = findBestMatch(ip.name, sheetNames);
      if (match) {
        target = products.get(match)!;
      }
    }

    if (target) {
      target.iddi_performance = ip.performance;
      target.iddi_expiration = ip.expiration;
      target.iddi_redistribution = ip.redistribution;
      if (!target.sources.includes('iddi')) target.sources.push('iddi');
    } else {
      // IDDI-only product
      products.set(norm, {
        name: ip.name,
        normalized_name: norm,
        warehouse_stock: null,
        warehouse_color: 'UNKNOWN',
        sales_weeks: [],
        iddi_performance: ip.performance,
        iddi_expiration: ip.expiration,
        iddi_redistribution: ip.redistribution,
        blacklist_status: 'active',
        blacklist_consecutive_red: 0,
        blacklist_date: null,
        reorder_recommendation: 'DO_NOT_REORDER',
        reorder_reason: '',
        sources: ['iddi'],
      });
      discrepancies.push({
        type: 'iddi_only',
        product: ip.name,
        detail: `Found in IDDI but not in Google Sheets. May need to be added to warehouse tracking.`,
      });
    }
  }

  // --- Detect sheets-only products (not in IDDI) ---
  for (const p of products.values()) {
    if (p.sources.length === 1 && p.sources[0] === 'sheets' && iddiProducts.length > 0) {
      discrepancies.push({
        type: 'sheets_only',
        product: p.name,
        detail: `Found in Google Sheets but not in IDDI. May not be tracked in IDDI platform.`,
      });
    }
  }

  // --- Apply blacklist logic ---
  const blacklistState = loadBlacklistState();
  const updatedBlacklist: BlacklistEntry[] = [];

  for (const p of products.values()) {
    const existing = blacklistState.find(b => normalizeName(b.product) === p.normalized_name);

    // Count consecutive red weeks from most recent
    let consecutiveRed = 0;
    if (p.sales_weeks.length > 0) {
      for (let i = p.sales_weeks.length - 1; i >= 0; i--) {
        if (p.sales_weeks[i].color === 'RED') consecutiveRed++;
        else break;
      }
    }

    p.blacklist_consecutive_red = consecutiveRed;

    if (existing?.blacklisted_date) {
      // Already blacklisted — check if coming off
      if (isComingOffBlacklist(existing)) {
        p.blacklist_status = 'coming_off';
        p.blacklist_date = existing.blacklisted_date;
      } else {
        p.blacklist_status = 'blacklisted';
        p.blacklist_date = existing.blacklisted_date;
      }
      updatedBlacklist.push({
        product: p.name,
        consecutive_red_weeks: consecutiveRed,
        blacklisted_date: existing.blacklisted_date,
      });
    } else if (consecutiveRed >= 4) {
      // New blacklist
      const today = new Date().toISOString().split('T')[0];
      p.blacklist_status = 'blacklisted';
      p.blacklist_date = today;
      updatedBlacklist.push({
        product: p.name,
        consecutive_red_weeks: consecutiveRed,
        blacklisted_date: today,
      });
    } else if (consecutiveRed >= 1) {
      p.blacklist_status = 'approaching';
      updatedBlacklist.push({
        product: p.name,
        consecutive_red_weeks: consecutiveRed,
        blacklisted_date: null,
      });
    } else {
      p.blacklist_status = 'active';
      // Keep entry if it was previously tracked
      if (existing) {
        updatedBlacklist.push({
          product: p.name,
          consecutive_red_weeks: 0,
          blacklisted_date: existing.blacklisted_date,
        });
      }
    }

    // --- Apply reorder matrix ---
    applyReorderDecision(p);
  }

  saveBlacklistState(updatedBlacklist);

  return { products: Array.from(products.values()), discrepancies };
}

function applyReorderDecision(p: UnifiedProduct): void {
  // Blacklisted products never get reordered
  if (p.blacklist_status === 'blacklisted') {
    p.reorder_recommendation = 'DO_NOT_REORDER';
    p.reorder_reason = 'Blacklisted — poor sales for 4+ weeks';
    return;
  }

  const wc = p.warehouse_color;
  // Only reorder if warehouse is RED
  if (wc !== 'RED') {
    p.reorder_recommendation = 'DO_NOT_REORDER';
    p.reorder_reason = wc === 'UNKNOWN'
      ? 'No warehouse stock data'
      : `Warehouse ${wc.toLowerCase()} — sufficient stock`;
    return;
  }

  // Warehouse is RED — check sales
  const latestSalesColor = getLatestSalesColor(p);
  if (latestSalesColor === 'GREEN' || latestSalesColor === 'YELLOW') {
    p.reorder_recommendation = 'REORDER';
    p.reorder_reason = `Low stock (RED) + ${latestSalesColor.toLowerCase()} sales`;
  } else {
    p.reorder_recommendation = 'DO_NOT_REORDER';
    p.reorder_reason = 'Low stock but poor sales — not worth restocking';
  }
}

function getLatestSalesColor(p: UnifiedProduct): SalesColor {
  for (let i = p.sales_weeks.length - 1; i >= 0; i--) {
    if (p.sales_weeks[i].color !== 'UNKNOWN') return p.sales_weeks[i].color;
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Extract IDDI product info from raw API responses
// ---------------------------------------------------------------------------

interface IddiProduct {
  name: string;
  performance: string | null;
  expiration: string | null;
  redistribution: string | null;
}

function extractIddiProducts(data: IddiData): IddiProduct[] {
  const map = new Map<string, IddiProduct>();

  // From inventory
  const inv = Array.isArray(data.inventory) ? data.inventory : (data.inventory as any)?.products || (data.inventory as any)?.data || [];
  for (const item of (Array.isArray(inv) ? inv : [])) {
    const name = item.product_name || item.name || item.productName || '';
    if (!name) continue;
    const norm = normalizeName(name);
    if (!map.has(norm)) {
      map.set(norm, { name, performance: null, expiration: null, redistribution: null });
    }
    const entry = map.get(norm)!;
    entry.performance = item.performance || item.status || item.performanceFlag || null;
  }

  // From top products
  const top = Array.isArray(data.topProducts) ? data.topProducts : (data.topProducts as any)?.products || (data.topProducts as any)?.data || [];
  for (const item of (Array.isArray(top) ? top : [])) {
    const name = item.product_name || item.name || item.productName || '';
    if (!name) continue;
    const norm = normalizeName(name);
    if (!map.has(norm)) {
      map.set(norm, { name, performance: null, expiration: null, redistribution: null });
    }
    const entry = map.get(norm)!;
    if (!entry.performance) {
      entry.performance = item.performance || (item.rank ? `rank #${item.rank}` : null);
    }
  }

  // From expiring
  const exp = Array.isArray(data.expiring) ? data.expiring : (data.expiring as any)?.products || (data.expiring as any)?.data || [];
  for (const item of (Array.isArray(exp) ? exp : [])) {
    const name = item.product_name || item.name || item.productName || '';
    if (!name) continue;
    const norm = normalizeName(name);
    if (!map.has(norm)) {
      map.set(norm, { name, performance: null, expiration: null, redistribution: null });
    }
    map.get(norm)!.expiration = item.expiration_date || item.expirationDate || item.expires_at || null;
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function reconcileFull(yoOffset: number): Promise<ReconciliationResult> {
  const [iddiData, sheetsData] = await Promise.all([pullIddi(), pullSheets()]);
  const { products, discrepancies } = buildUnifiedProducts(sheetsData, iddiData, yoOffset);

  const reorder_list = products.filter(p => p.reorder_recommendation === 'REORDER');
  const blacklist_warnings = products.filter(p => p.blacklist_status === 'approaching');
  const blacklist_now = products.filter(p => p.blacklist_status === 'blacklisted' && p.blacklist_date === new Date().toISOString().split('T')[0]);
  const coming_off = products.filter(p => p.blacklist_status === 'coming_off');

  const totalStock = products.reduce((s, p) => s + (p.warehouse_stock || 0), 0);

  return {
    timestamp: new Date().toISOString(),
    yo_offset: yoOffset,
    unified_products: products,
    reorder_list,
    blacklist_warnings,
    blacklist_now,
    coming_off_blacklist: coming_off,
    discrepancies,
    summary_stats: {
      total_products: products.length,
      reorder_count: reorder_list.length,
      blacklist_warning_count: blacklist_warnings.length,
      blacklist_now_count: blacklist_now.length,
      coming_off_count: coming_off.length,
      discrepancy_count: discrepancies.length,
      total_warehouse_stock: totalStock,
      yo_machines_untracked: yoOffset,
    },
  };
}

async function reconcileSnapshot(yoOffset: number): Promise<ReconciliationResult> {
  // Same as full but without the heavy blacklist_now filter on today-only
  const [iddiData, sheetsData] = await Promise.all([pullIddi(), pullSheets()]);
  const { products, discrepancies } = buildUnifiedProducts(sheetsData, iddiData, yoOffset);

  const reorder_list = products.filter(p => p.reorder_recommendation === 'REORDER');
  const blacklist_warnings = products.filter(p => p.blacklist_status === 'approaching');
  const blacklist_now = products.filter(p => p.blacklist_status === 'blacklisted');
  const coming_off = products.filter(p => p.blacklist_status === 'coming_off');

  const totalStock = products.reduce((s, p) => s + (p.warehouse_stock || 0), 0);

  return {
    timestamp: new Date().toISOString(),
    yo_offset: yoOffset,
    unified_products: products,
    reorder_list,
    blacklist_warnings,
    blacklist_now,
    coming_off_blacklist: coming_off,
    discrepancies,
    summary_stats: {
      total_products: products.length,
      reorder_count: reorder_list.length,
      blacklist_warning_count: blacklist_warnings.length,
      blacklist_now_count: blacklist_now.length,
      coming_off_count: coming_off.length,
      discrepancy_count: discrepancies.length,
      total_warehouse_stock: totalStock,
      yo_machines_untracked: yoOffset,
    },
  };
}

async function reconcileBlacklist(yoOffset: number): Promise<Pick<ReconciliationResult, 'timestamp' | 'blacklist_warnings' | 'blacklist_now' | 'coming_off_blacklist' | 'summary_stats'>> {
  const result = await reconcileSnapshot(yoOffset);
  return {
    timestamp: result.timestamp,
    blacklist_warnings: result.blacklist_warnings,
    blacklist_now: result.blacklist_now,
    coming_off_blacklist: result.coming_off_blacklist,
    summary_stats: result.summary_stats,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || !['full', 'snapshot', 'blacklist'].includes(command)) {
    console.error('Commands: full, snapshot, blacklist');
    console.error('  full      — Full cross-source reconciliation');
    console.error('  snapshot  — Quick inventory snapshot');
    console.error('  blacklist — Focused blacklist analysis');
    console.error('Flags: --yo-offset N (default 2)');
    process.exit(1);
  }

  const yoOffset = parseInt(parseFlag(args, '--yo-offset', '2')!, 10);

  try {
    let result: unknown;
    switch (command) {
      case 'full':
        result = await reconcileFull(yoOffset);
        break;
      case 'snapshot':
        result = await reconcileSnapshot(yoOffset);
        break;
      case 'blacklist':
        result = await reconcileBlacklist(yoOffset);
        break;
    }
    console.log(JSON.stringify({ status: 'success', command, ...result as object }));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  }
}

main();
