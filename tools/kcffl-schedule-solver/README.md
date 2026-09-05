# KCFFL 2025 schedule solver

A standalone utility, unrelated to the rest of this repository's Node/JS site
and boundary-gate code (see the root `CLAUDE.md`'s "Where code is allowed to
live" — none of that applies here). It is not wired into `.github/workflows/checks.yml`
and does not touch `data/`, `contracts/`, or `src/`.

## What it does

Builds a 14-week, 14-team, 3-division fantasy league schedule (double
round-robin within each division, single cross-division matchups, an
opponent-avoid list, rematch spacing, bookend-week density, and home/away
balance) as a real two-stage constraint solve (Google OR-Tools CP-SAT),
replacing an earlier random-restart generator that could never structurally
guarantee those season-wide requirements (see the module docstring in
`kcffl_schedule_solver.py` for exactly why).

## Running it

```sh
pip install ortools
python3 kcffl_schedule_solver.py
```

Solves deterministically in a few seconds and prints the weekly schedule, a
team summary table, and a rubric report (20.0/20.0 on the current league
configuration defined at the top of the module).
