"""Data pipeline for FOSS 2-Minute Drill.

Turns public nflverse data (and, optionally, the public Next Gen Stats site API) into the
static JSON files under ``web/data/`` described in ``docs/DATA.md``.

Run ``python3 -m pipeline.build --help`` for usage.
"""
