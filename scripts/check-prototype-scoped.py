"""Run the fleet checker without reading nested worktrees or private directories.

Usage: python scripts/check-prototype-scoped.py <fleet-checker.py> --repo . [--sync]
The shared checker is loaded unchanged; only its directory exclusion set is extended.
"""

import runpy
import sys


if len(sys.argv) < 2:
    raise SystemExit(__doc__)

checker = sys.argv.pop(1)
module = runpy.run_path(checker)
module["IGNORE_DIRS"].update({
    ".codex-worktrees", ".agent-worktrees", "security", ".task-tmp",
    "test-results", "playwright-report",
})
sys.argv[0] = checker
raise SystemExit(module["main"]())
