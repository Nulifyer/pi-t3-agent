# Agent work state

Read the repository-root `AGENTS.md` first, then use this order:

1. `PLAN.md` for the agreed goal, scope, boundaries, and phases.
2. `DECISIONS.md` for binding choices and unresolved questions.
3. `STATUS.md` for verified project state, current batch or active-task links, and the coordinator's next action.
4. `TESTING.md` for commands and evidence standards.
5. Only the task records relevant to the current work.

## Maintenance rules

- Keep these files short and current. Git owns history.
- Replace stale status. Do not append a chronological diary.
- Put choices future work must preserve in `DECISIONS.md`, never task completion.
- Put stable discoveries and facts under the repository's documentation convention, usually `docs/`.
- Keep exact run results in contracts or evidence artifacts, not `STATUS.md` or `TESTING.md`.
- Preserve user-added sections and notes.
- Resolve structural errors in records required for the current work.
- Keep a simple task in STATUS.md. For independent workstreams, replace Current batch and In progress with Active tasks containing record links and owners. Each task owns its next action.
- Use optional work ledgers for substantial independently resumable outcomes, not one per agent, batch, or commit. Reuse existing trackers.
- Give each writable record one owner and keep project-wide decisions in DECISIONS.md.
- Apply user steering to affected acceptance checks and preserve compatible work.

## Delivery loop

Address one logical result, update its owning records, and run affected checks. When commits are authorized, inspect and stage only that batch, then commit it. Otherwise record the verified uncommitted result and continue within existing authority. Distinguish returned work, verified task output, integration, and project acceptance.
