# Lessons Learned

## 2026-02-25: Non-main groups had no tool access

**Root cause**: `buildVolumeMounts()` only mounted `/workspace/project` for the main group. All skills reference tools at `/workspace/project/tools/...`, so every non-main group (Snak Group, Sheridan Rentals) silently failed on every scheduled task.

**Fix**: Mount `tools/` directory read-only for non-main groups at `/workspace/project/tools`.

**Prevention rule**: When adding a new tool, verify it works from a non-main group container. Test with: `docker exec <container> ls /workspace/project/tools/`.

## 2026-02-25: Docker limits too tight for browser automation

**Root cause**: Containers ran with 512MB RAM and 256 PID limit. Chromium alone needs 200-500MB and spawns 5-10 child processes, competing with the agent runner and Node.js.

**Fix**: Increased to 1024MB RAM and 512 PID limit.

**Prevention rule**: When adding browser-dependent features, always verify Docker resource limits can handle Chromium + agent overhead.

## 2026-02-25: Haiku + $0.05 budget insufficient for complex scheduled tasks

**Root cause**: All scheduled tasks used Haiku with $0.05 budget. Daily briefings require 5-7 tool calls across CRM, Calendar, IDDI, and email. Vending inventory requires login + navigation of 2 platforms. Both exceed Haiku's reasoning depth and budget.

**Fix**: Added per-task `model` and `budget_usd` columns to `scheduled_tasks`. Browser/multi-tool tasks use Sonnet with $0.50 budget; simple CRM queries stay on Haiku.

**Prevention rule**: When creating scheduled tasks, assess complexity. If a task needs >3 tool calls or browser automation, it should use Sonnet. Set model/budget explicitly on the task row.

## 2026-02-25: Google API tools had no actionable error messages

**Root cause**: Google tools caught errors and printed the raw message. When a calendar wasn't shared with the service account or an API wasn't enabled, the agent got a generic 403 with no guidance on how to fix it.

**Fix**: Added status-code-specific hints to all Google tools (sheets, calendar, drive, gmail) that explain the 3 most common causes of 401/403/404 errors.

**Prevention rule**: Every external API tool should catch auth errors and print a hint with the exact steps to fix. The agent inside the container can't debug cloud console issues — it needs clear instructions to relay.
