#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build

INSTRUCTION="DO NOT call claimBead. You have a direct assignment from Chair to fix 4 failing tests.

IMPORTANT CONTEXT: You are working in /Users/gjw/dev/scuffy/workspace/ship-rebuild which is a SEPARATE project (Ship rebuild) inside the Scuffy agent's workspace. It has its own git repo, its own package.json, its own tests. Do NOT modify anything outside this directory. Do NOT interact with beads (no createBead, no closeBead, no br commands). Just fix the tests and commit on main.

Run npm run test to see the 4 failures. Here is what I know about them:

BUG A: tests/ui-live-notifications.test.ts — 3 failures

The applyWeeklyPlanApprovalAction function was ALREADY added to src/api/planning.ts (interface + createPlanningApi). But the tests still fail:

Failure 1: 'refreshes dashboard, issues, planning, and team views when issue events arrive' — expected +0 to be 1. The test publishes an issue event and expects counts to update. The event publishing or state refresh pipeline is broken — the live state object gets counts of 0 after events that should increment them. Look at how the test calls the realtime publisher and how the live state object aggregates counts. The wiring between event publish and state refresh is likely broken.

Failure 2: 'subscribes at workspace scope so sprint and person planning events refresh the live state' — expected 'event-1' to be 'event-approval'. The approval action IS firing now (we fixed the function), but the event it produces has the wrong ID. Look at how applyWeeklyPlanApprovalAction generates its event and what ID the test expects. The service probably returns the wrong event identifier.

Failure 3: 'connects the shell entrypoints to live route state and notification summaries' — expected +0 to be 1. Same root cause as failure 1 — counts are 0 because events don't propagate to the shell state.

BUG B: tests/ui-issues-view.test.ts — 1 failure

'applies explicit list filters across state, priority, assignee, sprint, project, and program' — expected ['issue-3'] got []. The test creates an issue with state 'in_review', priority 'urgent', assigneeId 'person-2', sprintId 'sprint-1', projectId 'proj-1', programId 'prog-1'. Then calls buildIssuesListView with those filters against a programView.

The problem: buildIssuesListView in src/ui/issuesView.ts assembles sourceItems from programView arrays (backlogIssues, activeSprintIssues, completedIssues, unprojectedIssues, projectIssues). An issue with state 'in_review' might not be categorized into ANY of those arrays by getProgramIssueView. Check src/services/issues.ts or wherever getProgramIssueView builds its result — it likely has state-based bucketing that doesn't include 'in_review'.

APPROACH: Use grep to find the relevant functions, read targeted line ranges (use offset/limit on readFile — do NOT read entire files), fix the bugs, run npm run test to verify all 128 pass, then git add -A and git commit -m 'Fix 4 failing tests: live notification wiring and issue filter categorization'.

Call escalate when done."

node dist/index.js --headless --workdir workspace/ship-rebuild --role trench --instruction "$INSTRUCTION"
