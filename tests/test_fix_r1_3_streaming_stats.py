from __future__ import annotations

import numpy as np
import pytest

from app.mcp.artifact_tools import _streaming_stats


def test_streaming_stats_preserves_small_spread_at_large_offset() -> None:
    values = 1.7e9 + np.tile(np.array([-1.0, 1.0]), 50_000)

    stats = _streaming_stats(values)

    assert stats["std"] == pytest.approx(np.std(values), rel=1e-12, abs=1e-12)
