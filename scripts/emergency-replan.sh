#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
npm run build

INSTRUCTION="DO NOT call claimBead. You have a direct assignment from Chair. Three tasks IN ORDER:

TASK 1: FIX TWO SPECIFIC TEST BUGS.

Bug A: tests/ui-live-notifications.test.ts fails with 'api.applyWeeklyPlanApprovalAction is not a function'. Root cause: src/api/planning.ts createPlanningApi() returns an object that does NOT include applyWeeklyPlanApprovalAction, even though the method exists on PlanningService at src/services/planning.ts:106. Fix: add applyWeeklyPlanApprovalAction to the PlanningApi interface and wire it in createPlanningApi's return object. This will fix 3 of the 4 failing tests (the other 2 fail because counts are 0 since the approval action never fires).

Bug B: tests/ui-issues-view.test.ts 'applies explicit list filters' fails with expected ['issue-3'] but got []. Root cause: buildIssuesListView in src/ui/issuesView.ts assembles sourceItems from programView arrays (backlogIssues, activeSprintIssues, completedIssues, etc). An issue with state 'in_review' may not appear in any of those arrays. Check how getProgramIssueView categorizes issues and make sure in_review issues are included.

After fixing both, run npm run test and confirm all 128 tests pass. Commit on main.

TASK 2: REPLAN ALL REMAINING BEADS SMALLER. Run br list to see all open beads. For every open bead that involves more than one deliverable, use createBead to split it into 2-3 smaller pieces and closeBead to close the original. Target under 25 tool calls per bead. Call escalate when done."

node dist/index.js --headless --workdir workspace/ship-rebuild --role trench --instruction "$INSTRUCTION"
