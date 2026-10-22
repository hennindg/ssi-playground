# Interactive SSI-cov

Covariance-driven stochastic subspace identification (SSI-cov) of a simulated girder with known
modal properties, computed in the browser.

**[Open the application](https://hennindg.github.io/interactive-ssi-cov/)**

![Screenshot](docs/screenshot.png)

A simply supported girder with user-defined natural frequencies and damping ratios is excited by
white noise and measured by a row of accelerometers. SSI-cov identifies the modes from the simulated
response alone, and the application compares the results with the true values: stabilization
diagram, mode shapes, and the distribution of the identified damping ratios over repeated records.

## Parameter studies

- **Block rows.** A larger number of block rows (a longer maximum time lag) increases the
  underestimation of damping for the more heavily damped modes. Compare the bias over 20 records
  at 30 and at 120 block rows.
- **Record length.** The bias decreases with record length, which shows that it is a finite-record
  effect.
- **Closely spaced modes.** Two modes 2 % apart in frequency, identified with a reduced number of
  sensors.
- **Measurement noise.** At high noise levels, the stable pole columns of weakly excited modes break
  up in the stabilization diagram.

## Method

| Step | Description |
|---|---|
| Simulation | Each mode is a single-degree-of-freedom oscillator driven by independent white noise, discretized exactly (zero-order hold) and started from its stationary state, so the true natural frequency and damping ratio are known exactly. Mode *k* has *k* half-waves, sin(kπx/L). All modes have the same response level; sensor noise is specified relative to the RMS response. Sample rate 2 Hz. |
| SSI-cov | Output covariances (computed via FFT) up to time lag 2s−1, block Toeplitz matrix, singular vectors and values from the eigen-decomposition of T·Tᵀ, system matrix from the shift structure of the observability matrix, poles from its eigenvalues (Peeters & De Roeck, 1999). |
| Stability | A pole is stable when, relative to the previous model order, Δf < 1 %, Δζ < 5 % and MAC > 0.95. |
| Mode selection | Single-linkage clustering of the stable poles on Δf/f + (1 − MAC), cut at 0.05; a mode must appear in at least a quarter of the model orders. Damping outliers are removed with the box-plot rule. |

The computations are implemented in Python and NumPy in [`python/ssi_core.py`](python/ssi_core.py)
and run in a Web Worker through [Pyodide](https://pyodide.org). The page (`index.html`, `app.js`,
`style.css`) uses no build step and no framework; the figures are rendered directly as SVG.

The SSI-cov and clustering functions are taken from an
[operational modal analysis of the Hardanger Bridge](https://github.com/hennindg/hardanger-oma)
(1310 m main span, Norway), where the same damping bias was observed and corrected.

## Running locally

```bash
python -m http.server 8000
```

Then open http://localhost:8000. Unit tests of the Python core:

```bash
python -m pytest
```

## Reference

Peeters, B. & De Roeck, G. (1999). Reference-based stochastic subspace identification for
output-only modal analysis. *Mechanical Systems and Signal Processing*, 13(6), 855–878.

## License

MIT
