#!/usr/bin/env python3
"""KCFFL 2025 schedule solver -- a real constraint solve, not generate-and-test.

Replaces the random-restart generator in inspectMe.py, whose fundamental flaw was
never consuming its candidate game pools: div_games/cross_games were re-copied in
full every week, so nothing in the algorithm could ever guarantee "each divisional
pair meets exactly twice" or "each cross pair plays at most once" across the whole
season -- only within one week's greedy walk. No amount of random restarting fixes
that; it's a structural gap, not a tuning problem.

This solves it in two CP-SAT stages, mirroring the spec's own phase structure:

  Stage A -- WHICH GAMES.  Divisional pairs always play twice (fixed by the double
  round-robin requirement, no decision to make). Cross-division pairs are a real
  selection problem: pick exactly 16 Div1-Div2, 16 Div1-Div3, and 14 Div2-Div3 games
  from the avoid-list-eligible pool, such that every team's total matches its quota
  (8 for a 4-team-division team, 6 for a 5-team-division team), and decide the home
  team for each selected cross game to balance each team's home/away split toward
  7-7. These two totals (16/16/14 and 8/6/6) are forced by the spec's own numbers --
  see the worked arithmetic in the module docstring of `division_pair_quotas()`.

  Stage B -- WHICH WEEK.  Given the fixed game set from Stage A, assign every game to
  one of 14 weeks so each team plays exactly one game per week (a perfect matching
  per week), each divisional pair's two legs are separated by the spec's minimum gap
  (4 weeks for the 4-team division, 6 for the 5-team divisions -- satisfying the
  verification checklist's blanket >=4 either way), and divisional games are pushed
  into the bookend weeks (1-6, 9-14) as the objective, leaving weeks 7-8 as the
  buffer the spec describes.

Both stages are CP-SAT feasibility/optimization models: constraints are enforced
directly, not hoped for by resampling.
"""
from __future__ import annotations

import itertools
import sys
from collections import defaultdict
from dataclasses import dataclass

from ortools.sat.python import cp_model

# ==============================================================================
# LEAGUE CONFIGURATION
# ==============================================================================
DIV_1 = ["A", "B", "C", "D"]
DIV_2 = ["G", "H", "I", "J", "K"]
DIV_3 = ["L", "M", "N", "O", "P"]
DIVISIONS = {1: DIV_1, 2: DIV_2, 3: DIV_3}
TEAMS = DIV_1 + DIV_2 + DIV_3

AVOID_LIST = {
    ("A", "L"), ("B", "G"), ("C", "H"), ("D", "O"),
    ("G", "B"), ("H", "C"), ("I", "M"), ("J", "N"),
    ("K", "P"), ("L", "A"), ("M", "I"), ("N", "J"),
    ("O", "D"), ("P", "K"),
}

NUM_WEEKS = 14
BOOKEND_WEEKS = set(range(1, 7)) | set(range(9, 15))  # 1-6, 9-14
BUFFER_WEEKS = {7, 8}

# Minimum weeks between a divisional pair's two meetings. The spec's own phase
# table asks for 6 weeks in the two 5-team divisions and 4 in the 4-team division;
# both satisfy the verification checklist's blanket ">= 4 weeks" requirement.
REMATCH_GAP = {1: 4, 2: 6, 3: 6}


def division_of(team: str) -> int:
    for div_id, members in DIVISIONS.items():
        if team in members:
            return div_id
    raise ValueError(f"unknown team {team!r}")


def division_pair_quotas() -> dict[tuple[int, int], int]:
    """Exact cross-division game totals, forced by the spec's own per-team numbers.

    Div1 (4 teams) needs 8 non-div games/team -> 32 team-ends into {Div2, Div3}.
    Div2 (5 teams) needs 6 non-div games/team -> 30 team-ends into {Div1, Div3}.
    Div3 (5 teams) needs 6 non-div games/team -> 30 team-ends into {Div1, Div2}.

        x12 + x13 = 32
        x12 + x23 = 30
        x13 + x23 = 30
      =>  x12 = 16, x13 = 16, x23 = 14
    """
    return {(1, 2): 16, (1, 3): 16, (2, 3): 14}


# ==============================================================================
# STAGE A -- WHICH CROSS-DIVISION GAMES, AND WHO HOSTS
# ==============================================================================
@dataclass(frozen=True)
class CrossGame:
    team_a: str  # the lexicographically-first team of the pair
    team_b: str


def eligible_cross_pairs() -> list[CrossGame]:
    pairs = []
    for t1, t2 in itertools.combinations(TEAMS, 2):
        if division_of(t1) == division_of(t2):
            continue
        if (t1, t2) in AVOID_LIST or (t2, t1) in AVOID_LIST:
            continue
        pairs.append(CrossGame(t1, t2))
    return pairs


def divisional_quota(team: str) -> int:
    """Non-divisional games required for this team (14 total - divisional games)."""
    div_id = division_of(team)
    rivals = len(DIVISIONS[div_id]) - 1
    return 14 - 2 * rivals


def solve_game_selection() -> tuple[list[CrossGame], dict[CrossGame, str]]:
    """Returns (selected cross games, {game: home_team})."""
    model = cp_model.CpModel()
    pairs = eligible_cross_pairs()
    quotas = division_pair_quotas()

    played = {p: model.NewBoolVar(f"played_{p.team_a}_{p.team_b}") for p in pairs}
    a_home = {p: model.NewBoolVar(f"ahome_{p.team_a}_{p.team_b}") for p in pairs}
    b_home = {p: model.NewBoolVar(f"bhome_{p.team_a}_{p.team_b}") for p in pairs}
    for p in pairs:
        # Exactly one of {a hosts, b hosts} when played; neither when not played.
        model.Add(a_home[p] + b_home[p] == played[p])

    # Per-team non-divisional quota.
    for team in TEAMS:
        involved = [played[p] for p in pairs if team in (p.team_a, p.team_b)]
        model.Add(sum(involved) == divisional_quota(team))

    # Exact division-pair totals (16 / 16 / 14).
    for (d1, d2), quota in quotas.items():
        involved = [
            played[p] for p in pairs
            if {division_of(p.team_a), division_of(p.team_b)} == {d1, d2}
        ]
        model.Add(sum(involved) == quota)

    # Home/away balance objective: divisional legs give every team a fixed,
    # already-even home count (half its rivals), so only cross games are free to
    # optimize. Minimize each team's deviation from a 7-7 split.
    # Each team is the designated home leg for exactly one leg per rival (see
    # build_divisional_legs), so divisional home count is fixed at #rivals.
    fixed_div_home = {team: len(DIVISIONS[division_of(team)]) - 1 for team in TEAMS}
    deviations = []
    for team in TEAMS:
        home_terms = []
        for p in pairs:
            if p.team_a == team:
                home_terms.append(a_home[p])
            elif p.team_b == team:
                home_terms.append(b_home[p])
        home_count = fixed_div_home[team] + sum(home_terms)
        dev = model.NewIntVar(0, NUM_WEEKS, f"dev_{team}")
        model.Add(dev >= home_count - 7)
        model.Add(dev >= 7 - home_count)
        deviations.append(dev)
    model.Minimize(sum(deviations))

    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError("Stage A (game selection) is infeasible")

    selected = [p for p in pairs if solver.Value(played[p]) == 1]
    home_of = {p: (p.team_a if solver.Value(a_home[p]) else p.team_b) for p in selected}
    return selected, home_of


# ==============================================================================
# STAGE B -- WHICH WEEK
# ==============================================================================
@dataclass(frozen=True)
class Game:
    home: str
    away: str
    kind: str  # "divisional" or "cross"
    pair_key: tuple[str, str] | None = None  # divisional pair id, for spacing


def build_divisional_legs() -> list[Game]:
    legs = []
    for div_id, members in DIVISIONS.items():
        for t1, t2 in itertools.combinations(members, 2):
            key = (t1, t2)
            legs.append(Game(home=t1, away=t2, kind="divisional", pair_key=key))
            legs.append(Game(home=t2, away=t1, kind="divisional", pair_key=key))
    return legs


def build_cross_games(selected: list[CrossGame], home_of: dict[CrossGame, str]) -> list[Game]:
    games = []
    for p in selected:
        home = home_of[p]
        away = p.team_b if home == p.team_a else p.team_a
        games.append(Game(home=home, away=away, kind="cross"))
    return games


def solve_week_assignment(games: list[Game]) -> list[Game | None]:
    """Assigns each game a week (1-14). Returns a parallel list of week numbers."""
    model = cp_model.CpModel()
    weeks = range(1, NUM_WEEKS + 1)

    assign = {
        (gi, w): model.NewBoolVar(f"g{gi}_w{w}")
        for gi in range(len(games)) for w in weeks
    }
    for gi in range(len(games)):
        model.Add(sum(assign[gi, w] for w in weeks) == 1)

    games_by_team = defaultdict(list)
    for gi, g in enumerate(games):
        games_by_team[g.home].append(gi)
        games_by_team[g.away].append(gi)
    for team in TEAMS:
        for w in weeks:
            model.Add(sum(assign[gi, w] for gi in games_by_team[team]) == 1)

    # Divisional rematch spacing.
    legs_by_pair: dict[tuple[str, str], list[int]] = defaultdict(list)
    for gi, g in enumerate(games):
        if g.kind == "divisional":
            legs_by_pair[g.pair_key].append(gi)

    week_expr = {
        gi: sum(w * assign[gi, w] for w in weeks)
        for gi in range(len(games))
    }
    for (t1, t2), leg_indices in legs_by_pair.items():
        gi1, gi2 = leg_indices
        gap = REMATCH_GAP[division_of(t1)]
        first_earlier = model.NewBoolVar(f"order_{t1}_{t2}")
        model.Add(week_expr[gi2] - week_expr[gi1] >= gap).OnlyEnforceIf(first_earlier)
        model.Add(week_expr[gi1] - week_expr[gi2] >= gap).OnlyEnforceIf(first_earlier.Not())

    # Objective: push divisional games out of the buffer weeks (7, 8).
    buffer_div_penalty = []
    for gi, g in enumerate(games):
        if g.kind == "divisional":
            for w in BUFFER_WEEKS:
                buffer_div_penalty.append(assign[gi, w])
    model.Minimize(sum(buffer_div_penalty))

    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 8
    solver.parameters.max_time_in_seconds = 60
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise RuntimeError("Stage B (week assignment) is infeasible")

    result_weeks = []
    for gi in range(len(games)):
        for w in weeks:
            if solver.Value(assign[gi, w]) == 1:
                result_weeks.append(w)
                break
    return result_weeks


# ==============================================================================
# ASSEMBLY
# ==============================================================================
def build_schedule() -> dict[int, list[Game]]:
    selected_cross, home_of = solve_game_selection()
    divisional = build_divisional_legs()
    cross = build_cross_games(selected_cross, home_of)
    all_games = divisional + cross
    weeks = solve_week_assignment(all_games)

    schedule: dict[int, list[Game]] = defaultdict(list)
    for game, week in zip(all_games, weeks):
        schedule[week].append(game)
    return dict(sorted(schedule.items()))


if __name__ == "__main__":
    from verify import print_full_report

    schedule = build_schedule()
    print_full_report(schedule)
