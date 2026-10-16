"""Position templates used when there is no participation data."""

from collections import Counter

from pipeline.lineups import DEFENSE_TEMPLATE, OFFENSE_TEMPLATE, fill_template


def test_offense_template_takes_most_used_player_per_slot():
    ranked = [("qb1", "QB"), ("wr1", "WR"), ("wr2", "WR"), ("t1", "T"), ("t2", "T"),
              ("g1", "G"), ("g2", "G"), ("c1", "C"), ("rb1", "RB"), ("te1", "TE"),
              ("wr3", "WR"), ("wr4", "WR"), ("qb2", "QB"), ("rb2", "RB")]
    picks = fill_template(ranked, OFFENSE_TEMPLATE)
    assert len(picks) == 11
    assert Counter(pos for _, pos in picks) == Counter(
        {"QB": 1, "RB": 1, "WR": 3, "TE": 1, "T": 2, "G": 2, "C": 1})
    assert {"wr4", "qb2", "rb2"}.isdisjoint(pid for pid, _ in picks)


def test_template_fallbacks_when_short_at_a_position():
    # No tight end and only one guard: the TE slot falls back to the fullback and the
    # second guard slot to the third tackle.
    ranked = [("qb", "QB"), ("rb", "RB"), ("fb", "FB"), ("w1", "WR"), ("w2", "WR"),
              ("w3", "WR"), ("t1", "T"), ("t2", "T"), ("t3", "T"), ("g1", "G"), ("c", "C")]
    picks = dict(fill_template(ranked, OFFENSE_TEMPLATE))
    assert len(picks) == 11 and "fb" in picks and "t3" in picks


def test_defense_template_shape():
    ranked = ([(f"de{i}", "DE") for i in range(3)] + [(f"dt{i}", "DT") for i in range(3)]
              + [(f"lb{i}", "ILB") for i in range(3)] + [(f"cb{i}", "CB") for i in range(4)]
              + [(f"s{i}", "FS") for i in range(3)])
    picks = fill_template(ranked, DEFENSE_TEMPLATE)
    assert Counter(pos for _, pos in picks) == Counter({"DE": 2, "DT": 2, "ILB": 2, "CB": 3, "FS": 2})


def test_template_never_repeats_a_player_and_stops_at_eleven():
    ranked = [(f"p{i}", "WR") for i in range(20)]
    picks = fill_template(ranked, OFFENSE_TEMPLATE)
    assert len(picks) == 11 and len({pid for pid, _ in picks}) == 11
