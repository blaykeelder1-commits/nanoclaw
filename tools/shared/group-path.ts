import fs from 'fs';
import path from 'path';

/**
 * Resolve the active group's workspace directory regardless of execution context.
 *
 * Three contexts:
 *   Container mode: /workspace/group/ exists → return it
 *   CLI non-main:   cwd IS the group dir (has CLAUDE.md) → return cwd
 *   CLI main/manual: cwd is project root → return groups/{groupName}/
 *
 * @param groupName - Fallback group name when running from project root (default: 'snak-group')
 */
export function resolveGroupDir(groupName = 'snak-group'): string {
  // Container: /workspace/group is mounted
  if (fs.existsSync('/workspace/group')) return '/workspace/group';

  // CLI non-main: cwd IS the group directory (CLAUDE.md present)
  if (fs.existsSync(path.join(process.cwd(), 'CLAUDE.md'))) return process.cwd();

  // Project root: groups/{name}/ exists
  const fromRoot = path.join(process.cwd(), 'groups', groupName);
  if (fs.existsSync(fromRoot)) return fromRoot;

  // Last resort: return cwd (tools running from unknown location)
  return process.cwd();
}
