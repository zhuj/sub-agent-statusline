# Change Proposal: add-deep-subsession-hierarchy

## Status: superseded

This change is superseded by the TUI-only nested subagent sessions work shipped in `feature/simplification` on the 2026-09-02 design. See:

- Design: `.local/docs/specs/2026-09-02/design/index.md`
- Plan: `.local/docs/specs/2026-09-02/plan/index.md`
- Implementation: commits `65e04bf`..`886990c` on `feature/simplification`

## Original intent

Show every retained descendant subagent of the viewed session as an indented, parent-before-child tree at arbitrary depth in the TUI sidebar.

## Resolution

The deep subsession hierarchy, descendant discovery, projection, rendering, navigation, and persistence were all implemented and merged in the 2026-09-02 design cycle. No further work is needed under this change.

This change directory is retained for traceability only. The empty `specs/subagent-hierarchy/` subdirectory is a placeholder; do not add artifacts here. Use the 2026-09-02 design and plan for current and future deep-hierarchy work.
