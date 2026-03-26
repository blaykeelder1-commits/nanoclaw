-- Seed Quo (OpenPhone) SMS groups for both businesses
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/seed-quo-groups.sql
--
-- This registers the Quo SMS phone lines as groups with requiresTrigger=0
-- so inbound SMS messages are processed without needing an @Andy trigger.

-- ============================================================
-- 1. Register Quo SMS groups (requiresTrigger = false)
-- ============================================================

-- Snak Group SMS line
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
SELECT
  'quo:+16822551033',
  'Snak Group SMS',
  'snak-group',
  '@Andy',
  datetime('now'),
  -- Inherit container_config from existing snak-group registration if present
  COALESCE(
    (SELECT container_config FROM registered_groups WHERE folder = 'snak-group' LIMIT 1),
    '{}'
  ),
  0;

-- Sheridan Rentals SMS line
INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
SELECT
  'quo:+18175871460',
  'Sheridan Rentals SMS',
  'sheridan-rentals',
  '@Andy',
  datetime('now'),
  COALESCE(
    (SELECT container_config FROM registered_groups WHERE folder = 'sheridan-rentals' LIMIT 1),
    '{}'
  ),
  0;

-- ============================================================
-- 2. Ensure existing WhatsApp groups also have correct config
-- ============================================================

-- Update any existing snak-group registrations to include social scopes
UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.extraSecretScopes', json('["social","quo"]'),
  '$.secretOverrides', json('{"FB_PAGE_ID":"FB_PAGE_ID_SNAK","FB_PAGE_ACCESS_TOKEN":"FB_PAGE_ACCESS_TOKEN_SNAK"}')
) WHERE folder = 'snak-group';

-- Update any existing sheridan-rentals registrations to include social scopes
UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.extraSecretScopes', json('["social","quo"]'),
  '$.secretOverrides', json('{"FB_PAGE_ID":"FB_PAGE_ID_SHERIDAN","FB_PAGE_ACCESS_TOKEN":"FB_PAGE_ACCESS_TOKEN_SHERIDAN"}')
) WHERE folder = 'sheridan-rentals';
