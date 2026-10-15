# Skill-search benchmark results

## Live service comparison

Start with [Jev disabled vs Jev on 2026-10-14 vs Jev on 2026-10-15](2026-10-15/jev-live/README.md).

All dated live reports are together in `2026-10-15/jev-live/`, in the same JSON format:

| Run | Tuning | Held-out |
|---|---|---|
| Jev on 2026-10-14 | [jev-2026-10-14-tuning.json](2026-10-15/jev-live/jev-2026-10-14-tuning.json) | [jev-2026-10-14-held-out.json](2026-10-15/jev-live/jev-2026-10-14-held-out.json) |
| Jev on 2026-10-15 | [jev-2026-10-15-tuning.json](2026-10-15/jev-live/jev-2026-10-15-tuning.json) | [jev-2026-10-15-held-out.json](2026-10-15/jev-live/jev-2026-10-15-held-out.json) |

Each report contains `keyword` (Jev disabled), `semantic` (Jev enabled), and `comparison` (within-run comparison). [comparison.json](2026-10-15/jev-live/comparison.json) compares Jev on 2026-10-14 versus Jev on 2026-10-15. The original raw reports are preserved byte-for-byte; only their locations/names changed.

## Separate local keyword checks

[Offline keyword-only rerun](2026-10-15/README.md): local search measurements, **not** online service quality evidence.
