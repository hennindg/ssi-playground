"""
Tests of the Python core (run with: python -m pytest).
They run in normal Python, not in the browser, but it is the same file the page loads.
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
import ssi_core  # noqa: E402


def test_fft_covariances_equal_direct_sums():
    """The FFT shortcut must give the same R_i = E[y(k+i) y(k)^T] as the direct sum."""
    rng = np.random.default_rng(0)
    y = rng.standard_normal((400, 3))
    R = ssi_core.output_covariances(y, 20)
    y = y - y.mean(axis=0)
    for i in (0, 1, 7, 20):
        direct = y[i:].T @ y[:len(y) - i] / (len(y) - i)
        assert np.allclose(R[i], direct, atol=1e-12)


def test_discrete_mode_has_the_exact_poles():
    """The discrete system matrix of one mode has eigenvalues exp(lambda / fs)."""
    freq, zeta, fs = 0.3, 0.02, 2.0
    Ad, _, _, _ = ssi_core.discrete_sdof(freq, zeta, fs)
    lam = np.log(np.linalg.eigvals(Ad)) * fs
    lam = lam[np.imag(lam) > 0][0]
    assert np.isclose(np.abs(lam) / (2 * np.pi), freq)
    assert np.isclose(-np.real(lam) / np.abs(lam), zeta)


def test_lightly_damped_modes_are_identified():
    """A long, nearly noise-free record: frequencies within 0.3 %, damping within 0.15 %-points."""
    params = {"freqs": [0.15, 0.32, 0.55], "dampings": [0.01, 0.01, 0.01], "sensors": 7, "noise": 0.01,
              "duration_min": 180, "fs": 2.0, "block_rows": 40, "max_order": 30, "seed": 3, "details": False}
    out = json.loads(ssi_core.run(json.dumps(params)))
    for k, true_freq in enumerate(params["freqs"]):
        i = out["matches"][k]
        assert i >= 0, f"mode {k + 1} not identified"
        assert abs(out["modes"][i]["freq"] / true_freq - 1) < 0.003
        assert abs(out["modes"][i]["damping"] - params["dampings"][k]) < 0.0015
        assert out["macs"][k] > 0.99


def test_page_output_has_every_field():
    params = {"freqs": [0.2, 0.4], "dampings": [0.01, 0.02], "sensors": 4, "noise": 0.1,
              "duration_min": 10, "fs": 2.0, "block_rows": 20, "max_order": 20, "seed": 1, "details": True}
    out = json.loads(ssi_core.run(json.dumps(params)))
    for key in ("modes", "matches", "macs", "poles", "spectrum", "trace", "true_shapes", "sensor_x", "max_order"):
        assert key in out
    assert len(out["poles"]["freq"]) == len(out["poles"]["stable"])
