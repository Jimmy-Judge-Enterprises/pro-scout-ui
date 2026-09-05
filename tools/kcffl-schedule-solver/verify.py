"""Verification rubric for a KCFFL schedule -- fixes the two audit gaps found in
inspectMe.py's evaluate_schedule(), and adds the Team Summary Table that section 8
of the spec requires but the original script never produced.

Fixes relative to inspectMe.py:

1. GK-03 there only checked each team's TOTAL divisional game count (6 or 8), which
   a team could satisfy while playing one rival four times and another zero times.
   Here we check the exact per-pair count (every divisional pair meets exactly
   twice), which is what "double round-robin" actually means.
2. The rematch-spacing check there silently skipped any pair that didn't meet
   exactly twice (`if len(weeks) == 2`), so a pair that met the wrong number of
   times due to bug #1 was invisible to it. Fixed check #1 makes that state
   unreachable, and this version still flags it explicitly if it ever occurs.
"""
from __future__ import annotations

from collections import defaultdict

from kcffl_schedule_solver import (
    AVOID_LIST,
    BOOKEND_WEEKS,
    DIVISIONS,
    REMATCH_GAP,
    TEAMS,
    division_of,
)


def is_divisional(t1: str, t2: str) -> bool:
    return division_of(t1) == division_of(t2)


# ==============================================================================
# GATEKEEPERS (mandatory pass/fail)
# ==============================================================================
def check_core_validity(schedule) -> tuple[bool, str]:
    for week, games in schedule.items():
        if len(games) != 7:
            return False, f"week {week} has {len(games)} games, not 7"
        seen = [t for g in games for t in (g.home, g.away)]
        if len(set(seen)) != 14 or len(seen) != 14:
            return False, f"week {week} does not have all 14 teams playing exactly once"
    return True, "every week has 7 games, all 14 teams active, no byes"


def check_core_completeness(schedule) -> tuple[bool, str]:
    total = sum(len(games) for games in schedule.values())
    return total == 98, f"{total} total games scheduled (need 98)"


def check_divisional_double_round_robin(schedule) -> tuple[bool, str]:
    """Every divisional pair meets EXACTLY TWICE -- not just the right total count."""
    pair_counts: dict[tuple[str, str], int] = defaultdict(int)
    for games in schedule.values():
        for g in games:
            if is_divisional(g.home, g.away):
                key = tuple(sorted((g.home, g.away)))
                pair_counts[key] += 1

    expected_pairs = set()
    for members in DIVISIONS.values():
        for i in range(len(members)):
            for j in range(i + 1, len(members)):
                expected_pairs.add(tuple(sorted((members[i], members[j]))))

    missing = expected_pairs - set(pair_counts)
    wrong_count = {p: c for p, c in pair_counts.items() if c != 2}
    extra = set(pair_counts) - expected_pairs
    ok = not missing and not wrong_count and not extra
    detail = "every divisional pair meets exactly twice"
    if not ok:
        parts = []
        if missing:
            parts.append(f"never played: {sorted(missing)}")
        if wrong_count:
            parts.append(f"wrong count: {wrong_count}")
        if extra:
            parts.append(f"non-divisional pair flagged divisional: {sorted(extra)}")
        detail = "; ".join(parts)
    return ok, detail


# ==============================================================================
# WEIGHTED METRICS
# ==============================================================================
def score_avoid_list(schedule) -> tuple[float, str]:
    violations = [
        (g.home, g.away) for games in schedule.values() for g in games
        if (g.home, g.away) in AVOID_LIST or (g.away, g.home) in AVOID_LIST
    ]
    return (10.0, "no forbidden pairings") if not violations else (0.0, f"violations: {violations}")


def score_cross_uniqueness(schedule) -> tuple[float, str]:
    pairs = [
        tuple(sorted((g.home, g.away))) for games in schedule.values() for g in games
        if not is_divisional(g.home, g.away)
    ]
    dupes = {p for p in pairs if pairs.count(p) > 1}
    return (5.0, "all cross-division pairings unique") if not dupes else (0.0, f"repeated: {sorted(dupes)}")


def score_bookend_density(schedule) -> tuple[float, str]:
    bookend_total = sum(len(schedule[w]) for w in schedule if w in BOOKEND_WEEKS)
    bookend_div = sum(
        1 for w in schedule if w in BOOKEND_WEEKS
        for g in schedule[w] if is_divisional(g.home, g.away)
    )
    density = bookend_div / bookend_total if bookend_total else 0.0
    ok = density >= 0.60
    return (3.0 if ok else 0.0), f"{density:.1%} of bookend-week games are divisional (need >= 60%)"


def score_rematch_spacing(schedule) -> tuple[float, str]:
    pair_weeks: dict[tuple[str, str], list[int]] = defaultdict(list)
    for week, games in schedule.items():
        for g in games:
            if is_divisional(g.home, g.away):
                pair_weeks[tuple(sorted((g.home, g.away)))].append(week)

    violations = []
    for (t1, t2), weeks_played in pair_weeks.items():
        weeks_played.sort()
        if len(weeks_played) != 2:
            violations.append(f"{t1}-{t2} met {len(weeks_played)} times, not 2")
            continue
        gap = weeks_played[1] - weeks_played[0]
        required = REMATCH_GAP[division_of(t1)]
        if gap < required:
            violations.append(f"{t1}-{t2} gap={gap} (need >= {required})")

    return (2.0, "all divisional rematches sufficiently spaced") if not violations else (0.0, "; ".join(violations))


def score_home_away_balance(schedule) -> tuple[float, str]:
    """Weight is 0 in the spec's rubric, but still worth reporting for real."""
    home_count = {t: 0 for t in TEAMS}
    away_count = {t: 0 for t in TEAMS}
    for games in schedule.values():
        for g in games:
            home_count[g.home] += 1
            away_count[g.away] += 1
    out_of_range = {t: home_count[t] for t in TEAMS if abs(home_count[t] - 7) > 1}
    detail = (
        "all teams within 7 +/- 1 home games"
        if not out_of_range else f"out of range: {out_of_range}"
    )
    return 0.0, detail  # weight 0 per spec -- reported, not scored


GATEKEEPERS = [
    ("Core Validity (7 games/wk, 14 active, no byes)", check_core_validity),
    ("Core Completeness (98 total games)", check_core_completeness),
    ("Divisional Double Round-Robin (every pair exactly twice)", check_divisional_double_round_robin),
]

WEIGHTED_METRICS = [
    ("Avoid-List Compliance", score_avoid_list),
    ("Non-Divisional Uniqueness", score_cross_uniqueness),
    ("Rematch Spacing (>= 4 weeks)", score_rematch_spacing),
    ("Bookend Density (>= 60%)", score_bookend_density),
    ("Home/Away Balance (7 +/- 1, weight 0)", score_home_away_balance),
]


def evaluate(schedule) -> dict:
    gate_results = {name: fn(schedule) for name, fn in GATEKEEPERS}
    all_gates_pass = all(ok for ok, _ in gate_results.values())

    metric_results = {name: fn(schedule) for name, fn in WEIGHTED_METRICS}
    total_score = sum(pts for pts, _ in metric_results.values())

    status = "VALIDATED MASTER SCHEDULE" if all_gates_pass and total_score >= 15.0 else "REJECTED"
    return {
        "gatekeepers": gate_results,
        "metrics": metric_results,
        "total_score": total_score,
        "status": status,
    }


# ==============================================================================
# OUTPUT 1: WEEKLY SCHEDULE TABLE
# ==============================================================================
def print_weekly_schedule(schedule) -> None:
    print("=" * 80)
    print("KCFFL 2025 MASTER WEEKLY SCHEDULE".center(80))
    print("=" * 80)
    for week in sorted(schedule):
        games = ", ".join(f"{g.away} @ {g.home}" for g in schedule[week])
        tag = "" if week in BOOKEND_WEEKS else "  [buffer]"
        print(f"Week {week:>2} | {games}{tag}")


# ==============================================================================
# OUTPUT 2: TEAM SUMMARY TABLE  (missing from inspectMe.py entirely)
# ==============================================================================
def print_team_summary(schedule) -> None:
    div_games = {t: 0 for t in TEAMS}
    nondiv_games = {t: 0 for t in TEAMS}
    home = {t: 0 for t in TEAMS}
    away = {t: 0 for t in TEAMS}
    opponents_played: dict[str, set[str]] = defaultdict(set)

    for games in schedule.values():
        for g in games:
            home[g.home] += 1
            away[g.away] += 1
            opponents_played[g.home].add(g.away)
            opponents_played[g.away].add(g.home)
            if is_divisional(g.home, g.away):
                div_games[g.home] += 1
                div_games[g.away] += 1
            else:
                nondiv_games[g.home] += 1
                nondiv_games[g.away] += 1

    print()
    print("=" * 96)
    print("TEAM SUMMARY TABLE".center(96))
    print("=" * 96)
    header = f"{'Team':<6}{'Div':>5}{'NonDiv':>8}{'Total':>7}{'Home':>6}{'Away':>6}   Opponents Not Played"
    print(header)
    print("-" * 96)
    for t in TEAMS:
        not_played = sorted(set(TEAMS) - {t} - opponents_played[t])
        total = div_games[t] + nondiv_games[t]
        print(
            f"{t:<6}{div_games[t]:>5}{nondiv_games[t]:>8}{total:>7}{home[t]:>6}{away[t]:>6}   "
            f"{', '.join(not_played) if not_played else '(none)'}"
        )


# ==============================================================================
# OUTPUT 3: RUBRIC EVALUATION REPORT
# ==============================================================================
def print_rubric_report(result: dict) -> None:
    print()
    print("=" * 80)
    print("RUBRIC EVALUATION REPORT".center(80))
    print("=" * 80)
    print("GATEKEEPERS (mandatory):")
    for name, (ok, detail) in result["gatekeepers"].items():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
        print(f"         {detail}")
    print()
    print("WEIGHTED METRICS:")
    for name, (pts, detail) in result["metrics"].items():
        print(f"  {pts:>5.1f} pts  {name}")
        print(f"             {detail}")
    print("-" * 80)
    print(f"TOTAL SCORE: {result['total_score']:.1f} (threshold: 15.0)")
    print(f"STATUS: {result['status']}")
    print("=" * 80)


def print_full_report(schedule) -> None:
    print_weekly_schedule(schedule)
    print_team_summary(schedule)
    result = evaluate(schedule)
    print_rubric_report(result)
