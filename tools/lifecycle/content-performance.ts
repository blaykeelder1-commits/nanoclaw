#!/usr/bin/env npx tsx
/**
 * Content Performance Template Generator
 * Usage:
 *   npx tsx tools/lifecycle/content-performance.ts --all-groups
 *   npx tsx tools/lifecycle/content-performance.ts --group <folder>
 *
 * Reads content-calendar.md and viral-patterns.md, then writes a
 * content-performance.json template for each group. The scheduled task
 * (running as Andy) fills in actual metrics using read-facebook-insights.ts.
 */

import fs from 'fs';
import path from 'path';
import { resolveGroupDir } from '../shared/group-path.js';

interface PerformanceTemplate {
  generated_at: string;
  analysis_needed: boolean;
  instructions: string;
  content_calendar_found: boolean;
  viral_patterns_found: boolean;
  recent_topics: string[];
  current_patterns: string[];
  template: {
    posts: unknown[];
    top_performing: unknown[];
    worst_performing: unknown[];
    avg_engagement_rate: number;
    winning_patterns: string[];
    recommendations: string[];
  };
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function resolveProjectRoot(): string {
  // In container: /workspace/project; on host: cwd
  if (fs.existsSync('/workspace/project/groups')) {
    return '/workspace/project';
  }
  return process.cwd();
}

function getGroupFolders(root: string, specificGroup?: string): string[] {
  if (specificGroup) return [specificGroup];

  const groupsDir = path.join(root, 'groups');
  if (!fs.existsSync(groupsDir)) return [];

  return fs.readdirSync(groupsDir).filter(name => {
    const fullPath = path.join(groupsDir, name);
    return fs.statSync(fullPath).isDirectory() && name !== 'global';
  });
}

function extractTopics(calendarContent: string): string[] {
  const topics: string[] = [];
  // Look for lines that look like post entries (markdown list items, table rows, headings)
  const lines = calendarContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Match markdown list items with content
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      const topic = trimmed.slice(2).trim();
      if (topic.length > 5 && topic.length < 200) {
        topics.push(topic);
      }
    }
    // Match table rows (skip header separators)
    if (trimmed.startsWith('|') && !trimmed.includes('---')) {
      const cells = trimmed.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        topics.push(cells.join(' | '));
      }
    }
  }
  // Return last 20 entries (most recent)
  return topics.slice(-20);
}

function extractPatterns(patternsContent: string): string[] {
  const patterns: string[] = [];
  const lines = patternsContent.split('\n');
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Look for headings that indicate pattern sections
    if (trimmed.startsWith('#')) {
      inSection = true;
      continue;
    }
    if (inSection && (trimmed.startsWith('- ') || trimmed.startsWith('* '))) {
      const pattern = trimmed.slice(2).trim();
      if (pattern.length > 3) {
        patterns.push(pattern);
      }
    }
  }

  return patterns.slice(0, 30);
}

function processGroup(root: string, folder: string): { written: boolean; stale: boolean } {
  const groupDir = resolveGroupDir(folder);
  if (!fs.existsSync(groupDir)) {
    console.error(`[content-performance] Group directory not found: ${folder}`);
    return { written: false, stale: false };
  }

  const calendarPath = path.join(groupDir, 'content-calendar.md');
  const mainDir = resolveGroupDir('main');
  const patternsPath = path.join(mainDir, 'viral-patterns.md');
  const outputPath = path.join(groupDir, 'content-performance.json');

  // Check for stale existing data
  let stale = false;
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      const generatedAt = new Date(existing.generated_at);
      const hoursSince = (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60);
      // Consider stale if older than 24 hours
      if (hoursSince < 24 && !existing.analysis_needed) {
        console.error(`[content-performance] ${folder}: Recent analysis exists (${Math.round(hoursSince)}h ago), skipping`);
        return { written: false, stale: false };
      }
      if (hoursSince >= 24) {
        stale = true;
      }
    } catch {
      // Corrupted file, regenerate
      stale = true;
    }
  }

  // Read content calendar
  let recentTopics: string[] = [];
  let calendarFound = false;
  if (fs.existsSync(calendarPath)) {
    calendarFound = true;
    try {
      const content = fs.readFileSync(calendarPath, 'utf-8');
      recentTopics = extractTopics(content);
    } catch {
      console.error(`[content-performance] ${folder}: Failed to read content-calendar.md`);
    }
  }

  // Read viral patterns
  let currentPatterns: string[] = [];
  let patternsFound = false;
  if (fs.existsSync(patternsPath)) {
    patternsFound = true;
    try {
      const content = fs.readFileSync(patternsPath, 'utf-8');
      currentPatterns = extractPatterns(content);
    } catch {
      console.error(`[content-performance] ${folder}: Failed to read viral-patterns.md`);
    }
  }

  const output: PerformanceTemplate = {
    generated_at: new Date().toISOString(),
    analysis_needed: true,
    instructions: 'Use read-facebook-insights.ts to pull engagement for all posts in the past 7 days. Then update this file with actual metrics.',
    content_calendar_found: calendarFound,
    viral_patterns_found: patternsFound,
    recent_topics: recentTopics,
    current_patterns: currentPatterns,
    template: {
      posts: [],
      top_performing: [],
      worst_performing: [],
      avg_engagement_rate: 0,
      winning_patterns: [],
      recommendations: [],
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  return { written: true, stale };
}

function main() {
  const args = process.argv.slice(2);
  const allGroups = hasFlag(args, '--all-groups');
  const specificGroup = parseFlag(args, '--group');

  if (!allGroups && !specificGroup) {
    console.error('Usage: content-performance --all-groups | --group <folder>');
    process.exit(1);
  }

  const root = resolveProjectRoot();
  const folders = getGroupFolders(root, specificGroup);

  if (folders.length === 0) {
    console.error('[content-performance] No groups found.');
    process.exit(0);
  }

  let written = 0;
  let skipped = 0;
  let staleCount = 0;

  for (const folder of folders) {
    const result = processGroup(root, folder);
    if (result.written) {
      written++;
      if (result.stale) staleCount++;
      console.error(`[content-performance] ${folder}: Template written`);
    } else {
      skipped++;
    }
  }

  console.error(`[content-performance] Done. Written: ${written}, Skipped: ${skipped}, Stale replaced: ${staleCount}`);
}

main();
