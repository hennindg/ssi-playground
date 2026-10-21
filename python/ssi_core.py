"""
Computational core of the SSI playground. It runs in the browser (Pyodide, a Python interpreter
compiled to WebAssembly) and in normal Python for the tests.

Only numpy is used. scipy is not loaded in the browser, because it would make the page much
slower to open. The SSI functions follow oma/ssi_cov.py and oma/mode_clustering.py of the
hardanger-oma repository; the scipy calls are replaced by numpy equivalents.

One call of run() does the whole chain:
  1. simulate a record of a simply supported girder with known modes (frequency, damping, shape)
  2. covariance-driven SSI (SSI-cov) at a range of model orders
  3. stability check of the poles from order to order
  4. automatic mode picking (single-linkage clustering of the stable poles)
  5. compare the identified modes with the true ones
and returns everything the page needs to draw, as a JSON string.
"""

import json
import time

import numpy as np

# Stability criteria and clustering settings (same values as the Hardanger pipeline)
TOL_FREQ = 0.01         # frequency change < 1 % from the previous order
TOL_DAMPING = 0.05      # damping change < 5 %
TOL_MAC = 0.95          # MAC with the previous order > 0.95
MAX_DAMPING = 0.10      # poles with more than 10 % damping are thrown away
CLUSTER_DISTANCE = 0.05 # distance = relative frequency difference + (1 - MAC)
MIN_ORDER_SHARE = 0.25  # a mode must appear at 25 % of the model orders


# ---------------------------------------------------------------------------------------------
# 1. Simulation
# ---------------------------------------------------------------------------------------------

def discrete_sdof(freq, zeta, fs):
    """
    Exact discrete-time version (zero-order hold) of one mode:
        q'' + 2 zeta omega q' + omega^2 q = F,   output = acceleration q''.
    State x = [q, q']. Returns Ad, Bd (state update) and C, D (acceleration output).
    The discrete poles are exactly exp(lambda / fs), so the true frequency and damping are known.
    """
    omega = 2 * np.pi * freq
    A = np.array([[0.0, 1.0], [-omega ** 2, -2 * zeta * omega]])
    B = np.array([0.0, 1.0])
    C = np.array([-omega ** 2, -2 * zeta * omega])   # q'' = F - omega^2 q - 2 zeta omega q'
    D = 1.0

    # Matrix exponential exp(A dt) from the eigenvalues of A (two distinct complex values for zeta < 1)
    lam, V = np.linalg.eig(A)
    Ad = np.real(V @ np.diag(np.exp(lam / fs)) @ np.linalg.inv(V))
    # Zero-order hold: Bd = A^-1 (Ad - I) B
    Bd = np.linalg.solve(A, (Ad - np.eye(2)) @ B)
    return Ad, Bd, C, D


def stationary_state_covariance(Ad, Bd):
    """
    Covariance P of the state in steady state under unit white noise:  P = Ad P Ad^T + Bd Bd^T
    (discrete Lyapunov equation, solved for the 4 entries of the 2 x 2 matrix).
    Starting the simulation from this distribution means no start transient has to be thrown away.
    """
    lhs = np.eye(4) - np.kron(Ad, Ad)
    rhs = np.outer(Bd, Bd).flatten()
    P = np.linalg.solve(lhs, rhs).reshape(2, 2)
    return (P + P.T) / 2


def modal_acceleration(rng, freq, zeta, n_samples, fs):
    """Acceleration of one mode under a white-noise force, scaled to unit standard deviation."""
    Ad, Bd, C, D = discrete_sdof(freq, zeta, fs)
    P = stationary_state_covariance(Ad, Bd)
    x = np.linalg.cholesky(P) @ rng.standard_normal(2)
    force = rng.standard_normal(n_samples)

    # Plain Python floats are much faster than numpy for a 2 x 2 recursion
    a11, a12, a21, a22 = Ad[0, 0], Ad[0, 1], Ad[1, 0], Ad[1, 1]
    b1, b2 = Bd[0], Bd[1]
    c1, c2 = C[0], C[1]
    x1, x2 = float(x[0]), float(x[1])
    acc = np.empty(n_samples)
    for k, u in enumerate(force.tolist()):
        acc[k] = c1 * x1 + c2 * x2 + D * u
        x1, x2 = a11 * x1 + a12 * x2 + b1 * u, a21 * x1 + a22 * x2 + b2 * u
    return acc / np.std(acc)


def girder_mode_shapes(n_modes, n_sensors):
    """
    Mode shapes of a simply supported girder, sin(n pi x / L), at n_sensors equally spaced
    sensors (supports not included). Mode k has k half-waves. Returns x/L [n_sensors]
    and shapes [n_modes, n_sensors].
    """
    x = np.arange(1, n_sensors + 1) / (n_sensors + 1)
    shapes = np.array([np.sin((k + 1) * np.pi * x) for k in range(n_modes)])
    return x, shapes


def simulate_record(seed, freqs, dampings, n_sensors, noise_ratio, duration_s, fs):
    """
    Accelerations [n_samples, n_sensors] = sum over modes of a_k(t) * shape_k + measurement noise.
    Every mode has the same response level; the noise std is noise_ratio times the RMS of the
    noise-free signal (the same for all channels).
    """
    rng = np.random.default_rng(seed)
    n_samples = int(round(duration_s * fs))
    x, shapes = girder_mode_shapes(len(freqs), n_sensors)
    y = np.zeros((n_samples, n_sensors))
    for k in range(len(freqs)):
        y += np.outer(modal_acceleration(rng, freqs[k], dampings[k], n_samples, fs), shapes[k])
    rms = np.sqrt(np.mean(y ** 2))
    y += noise_ratio * rms * rng.standard_normal(y.shape)
    return y, x, shapes


# ---------------------------------------------------------------------------------------------
# 2. SSI-cov
# ---------------------------------------------------------------------------------------------

def output_covariances(y, max_lag):
    """
    Output covariance matrices R_i = E[ y(k+i) y(k)^T ] for i = 0 ... max_lag,
    computed for all channel pairs at once with the FFT (much faster than one product per lag).
    Returns an array [max_lag + 1, n_channels, n_channels].
    """
    y = y - np.mean(y, axis=0)
    n_samples = y.shape[0]
    n_fft = 1
    while n_fft < 2 * n_samples:       # zero padding: no wrap-around of the circular correlation
        n_fft *= 2
    Y = np.fft.rfft(y, n=n_fft, axis=0)                       # [n_freq, n_channels]
    cross = Y[:, :, None] * np.conj(Y[:, None, :])            # Y_a conj(Y_b) for all pairs
    sums = np.fft.irfft(cross, n=n_fft, axis=0)[:max_lag + 1]  # sum_k y_a(k+i) y_b(k)
    counts = n_samples - np.arange(max_lag + 1)
    return sums / counts[:, None, None]


def block_toeplitz(R, block_rows):
    """
    Block Toeplitz matrix of output covariances, s = block_rows:
        [ R_s       R_(s-1)  ...  R_1 ]
        [ R_(s+1)   R_s      ...  R_2 ]
        [ ...                         ]
        [ R_(2s-1)  ...           R_s ]
    Size (s * n_channels) x (s * n_channels). Needs R up to lag 2s-1.
    """
    s = block_rows
    n_channels = R.shape[1]
    T = np.zeros((s * n_channels, s * n_channels))
    for row in range(s):
        for col in range(s):
            T[row * n_channels:(row + 1) * n_channels,
              col * n_channels:(col + 1) * n_channels] = R[s + row - col]
    return T


def poles_for_one_order(U, S, order, n_channels, fs):
    """
    Poles (frequency, damping, mode shape) for ONE model order from the SVD of the Toeplitz matrix.
    Only one pole of each complex conjugate pair is kept, with damping between 0 and MAX_DAMPING.
    """
    O = U[:, :order] * np.sqrt(S[:order])        # observability matrix
    C = O[:n_channels, :]                          # output matrix = first block row
    # Shift structure: (O without last block row) A = (O without first block row)
    A = np.linalg.lstsq(O[:-n_channels, :], O[n_channels:, :], rcond=None)[0]
    mu, psi = np.linalg.eig(A)

    keep = np.imag(mu) > 0
    mu, psi = mu[keep], psi[:, keep]
    lam = np.log(mu) * fs                          # continuous-time eigenvalues [rad/s]
    freq = np.abs(lam) / (2 * np.pi)
    damping = -np.real(lam) / np.abs(lam)
    shapes = C @ psi

    keep = (damping > 0) & (damping < MAX_DAMPING)
    order_of_freq = np.argsort(freq[keep])
    return freq[keep][order_of_freq], damping[keep][order_of_freq], shapes[:, keep][:, order_of_freq]


def ssi_cov(y, fs, block_rows, orders):
    """SSI-cov at all model orders. Returns a list with one dictionary of poles per order."""
    n_channels = y.shape[1]
    R = output_covariances(y, 2 * block_rows - 1)
    T = block_toeplitz(R, block_rows)
    # Only U and S of the SVD T = U S V^T are needed. They follow from the symmetric eigenvalue
    # problem (T T^T) U = U S^2, which is faster than a full SVD (same poles to ~1e-13).
    # One decomposition is enough: each model order uses the first columns of U and S.
    eigenvalues, eigenvectors = np.linalg.eigh(T @ T.T)
    largest_first = np.argsort(eigenvalues)[::-1]
    S = np.sqrt(np.maximum(eigenvalues[largest_first], 0.0))
    U = eigenvectors[:, largest_first]
    poles = []
    for order in orders:
        freq, damping, shapes = poles_for_one_order(U, S, order, n_channels, fs)
        poles.append({"order": order, "freq": freq, "damping": damping, "shapes": shapes})
    return poles, S


def mac(shape_1, shape_2):
    """Modal Assurance Criterion: 1 = same shape, 0 = orthogonal shapes."""
    top = np.abs(np.vdot(shape_1, shape_2)) ** 2
    bottom = np.real(np.vdot(shape_1, shape_1)) * np.real(np.vdot(shape_2, shape_2))
    return top / bottom


def check_stability(poles):
    """
    A pole is stable when, compared with the closest-frequency pole at the previous order,
    frequency, damping and mode shape (MAC) all changed less than the tolerances.
    Adds a boolean array "stable" to each order.
    """
    for k, current in enumerate(poles):
        current["stable"] = np.zeros(len(current["freq"]), dtype=bool)
        if k == 0 or len(poles[k - 1]["freq"]) == 0:
            continue
        previous = poles[k - 1]
        for p in range(len(current["freq"])):
            q = np.argmin(np.abs(previous["freq"] - current["freq"][p]))
            ok_freq = abs(current["freq"][p] - previous["freq"][q]) / previous["freq"][q] < TOL_FREQ
            ok_damping = abs(current["damping"][p] - previous["damping"][q]) / previous["damping"][q] < TOL_DAMPING
            ok_mac = mac(current["shapes"][:, p], previous["shapes"][:, q]) > TOL_MAC
            current["stable"][p] = ok_freq and ok_damping and ok_mac
    return poles


# ---------------------------------------------------------------------------------------------
# 3. Automatic mode picking
# ---------------------------------------------------------------------------------------------

def single_linkage_clusters(distances, max_distance):
    """
    Single-linkage clustering cut at max_distance: two poles are in the same cluster if a chain
    of poles connects them with every step shorter than max_distance. That is the same as the
    connected parts of a graph with an edge for every pair closer than max_distance.
    Returns a cluster number for every pole.
    """
    n = distances.shape[0]
    cluster = -np.ones(n, dtype=int)
    next_cluster = 0
    for start in range(n):
        if cluster[start] >= 0:
            continue
        cluster[start] = next_cluster
        to_visit = [start]
        while to_visit:
            i = to_visit.pop()
            neighbours = np.where((distances[i] < max_distance) & (cluster < 0))[0]
            cluster[neighbours] = next_cluster
            to_visit.extend(neighbours.tolist())
        next_cluster += 1
    return cluster


def pick_modes(poles):
    """
    Group the stable poles of all orders into physical modes. A mode must appear at many model
    orders; damping outliers are removed (box plot rule) and one pole per order is kept.
    Returns a list of modes sorted by frequency.
    """
    freq, damping, order, shapes = [], [], [], []
    for result in poles:
        s = result["stable"]
        freq.extend(result["freq"][s])
        damping.extend(result["damping"][s])
        order.extend([result["order"]] * int(s.sum()))
        shapes.append(result["shapes"][:, s])
    if len(freq) == 0:
        return []
    freq, damping, order, shapes = np.array(freq), np.array(damping), np.array(order), np.hstack(shapes)

    # Distance = relative frequency difference + (1 - MAC), for every pair of stable poles
    products = shapes.conj().T @ shapes
    norms = np.real(np.sum(shapes.conj() * shapes, axis=0))
    mac_all = np.abs(products) ** 2 / np.outer(norms, norms)
    f_i, f_j = freq[:, None], freq[None, :]
    distances = np.abs(f_i - f_j) / np.maximum(f_i, f_j) + (1 - mac_all)

    cluster = single_linkage_clusters(distances, CLUSTER_DISTANCE)
    min_orders = max(3, int(MIN_ORDER_SHARE * len(poles)))

    modes = []
    for c in np.unique(cluster):
        members = np.where(cluster == c)[0]
        if len(np.unique(order[members])) < min_orders:
            continue
        q1, q3 = np.percentile(damping[members], [25, 75])
        iqr = q3 - q1
        members = members[(damping[members] >= q1 - 1.5 * iqr) & (damping[members] <= q3 + 1.5 * iqr)]
        # one pole per order: the one closest to the median frequency
        median_freq = np.median(freq[members])
        kept = []
        for n in np.unique(order[members]):
            same_order = members[order[members] == n]
            kept.append(same_order[np.argmin(np.abs(freq[same_order] - median_freq))])
        members = np.array(kept)
        if len(members) < min_orders:
            continue
        representative = members[np.argmin(np.abs(freq[members] - median_freq))]
        shape = shapes[:, representative]
        shape = shape / shape[np.argmax(np.abs(shape))]          # largest component = +1
        modes.append({
            "freq": float(np.mean(freq[members])),
            "freq_std": float(np.std(freq[members])),
            "damping": float(np.mean(damping[members])),
            "damping_std": float(np.std(damping[members])),
            "n_orders": int(len(members)),
            "shape": np.real(shape),
            "shape_complex": shape,
        })
    modes.sort(key=lambda m: m["freq"])
    return modes


def match_modes(true_freqs, true_shapes, modes):
    """
    For each true mode, the identified mode within 15 % in frequency with the highest MAC
    (at least 0.8). Returns the index into modes (or -1) and the MAC for each true mode.
    """
    matches, macs = [], []
    for k in range(len(true_freqs)):
        best, best_mac = -1, 0.8
        for i, m in enumerate(modes):
            if abs(m["freq"] - true_freqs[k]) / true_freqs[k] > 0.15:
                continue
            value = mac(true_shapes[k], m["shape_complex"])
            if value > best_mac:
                best, best_mac = i, value
        matches.append(best)
        macs.append(float(best_mac) if best >= 0 else None)
    return matches, macs


def first_singular_value_spectrum(y, fs, segment_samples):
    """
    First singular value of the cross spectral density matrix at each frequency (Welch average,
    Hann window, 50 % overlap), as in frequency domain decomposition. Drawn behind the
    stabilization diagram: its peaks show where the modes are, using all channels at once.
    """
    y = y - np.mean(y, axis=0)
    n = min(segment_samples, y.shape[0])
    window = np.hanning(n)
    starts = range(0, y.shape[0] - n + 1, n // 2)
    G = 0
    for s in starts:
        X = np.fft.rfft(y[s:s + n] * window[:, None], axis=0)   # [n_freq, n_channels]
        G = G + X[:, :, None] * np.conj(X[:, None, :])
    sv = np.linalg.svd(G, compute_uv=False)[:, 0]
    freqs = np.fft.rfftfreq(n, 1 / fs)
    return freqs, sv


# ---------------------------------------------------------------------------------------------
# 4. Everything in one call (used by the page)
# ---------------------------------------------------------------------------------------------

def run(params_json):
    """
    params_json: {"freqs": [...Hz], "dampings": [...fraction], "sensors": int, "noise": fraction,
                  "duration_min": float, "fs": Hz, "block_rows": int, "max_order": int,
                  "seed": int, "details": bool}
    With details = false only the identified modes are returned (used for repeated runs).
    """
    p = json.loads(params_json)
    t0 = time.perf_counter()
    freqs = np.array(p["freqs"], dtype=float)
    dampings = np.array(p["dampings"], dtype=float)
    fs = float(p["fs"])

    y, x, true_shapes = simulate_record(p["seed"], freqs, dampings, int(p["sensors"]),
                                        float(p["noise"]), 60 * float(p["duration_min"]), fs)
    t1 = time.perf_counter()

    # The shift equation needs more rows than unknowns: order <= (block_rows - 1) * n_channels
    highest_order = min(int(p["max_order"]), (int(p["block_rows"]) - 1) * len(x))
    orders = list(range(2, highest_order + 1, 2))
    poles, S = ssi_cov(y, fs, int(p["block_rows"]), orders)
    poles = check_stability(poles)
    modes = pick_modes(poles)
    matches, macs = match_modes(freqs, true_shapes, modes)
    t2 = time.perf_counter()

    out = {
        "seed": p["seed"],
        "modes": [{"freq": m["freq"], "damping": m["damping"], "freq_std": m["freq_std"],
                   "damping_std": m["damping_std"], "n_orders": m["n_orders"],
                   "shape": m["shape"].round(4).tolist()} for m in modes],
        "matches": matches,
        "macs": macs,
        "timing": {"simulate": t1 - t0, "ssi": t2 - t1},
    }
    if p.get("details", True):
        pole_freq, pole_order, pole_damping, pole_stable = [], [], [], []
        for result in poles:
            pole_freq.extend(np.round(result["freq"], 5).tolist())
            pole_damping.extend(np.round(result["damping"], 5).tolist())
            pole_order.extend([result["order"]] * len(result["freq"]))
            pole_stable.extend(result["stable"].astype(int).tolist())
        spec_f, spec_sv = first_singular_value_spectrum(y, fs, 512)
        keep = spec_f > 0
        # A short piece of the record (three sensors) to show what the input looks like
        trace_channels = sorted(set([0, len(x) // 2, len(x) - 1]))
        n_trace = min(len(y), int(600 * fs))
        out.update({
            "sensor_x": x.round(4).tolist(),
            "true_shapes": true_shapes.round(4).tolist(),
            "poles": {"freq": pole_freq, "order": pole_order, "damping": pole_damping,
                      "stable": pole_stable},
            "spectrum": {"freq": spec_f[keep].round(5).tolist(),
                         "db": (10 * np.log10(spec_sv[keep] / spec_sv[keep].max())).round(2).tolist()},
            "max_order": highest_order,
            "trace": {"x": [x[c] for c in trace_channels],
                      "y": [y[:n_trace, c].round(4).tolist() for c in trace_channels],
                      "fs": fs},
            "toeplitz_size": int(p["block_rows"]) * len(x),
        })
    return json.dumps(out)
