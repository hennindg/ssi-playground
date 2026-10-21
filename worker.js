// Runs Python (Pyodide + numpy) in a background thread, so the page stays responsive
// while SSI is computing. The page sends {id, params}; the worker answers {id, result}.

importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js");

let runSsi = null;

async function start() {
  postMessage({ type: "status", text: "Loading Python" });
  const pyodide = await loadPyodide();
  postMessage({ type: "status", text: "Loading numpy" });
  await pyodide.loadPackage("numpy");

  const code = await (await fetch("python/ssi_core.py?v=1")).text();
  pyodide.FS.writeFile("/home/pyodide/ssi_core.py", code);
  pyodide.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  runSsi = pyodide.pyimport("ssi_core").run;
  postMessage({ type: "ready" });
}

const ready = start().catch((err) => postMessage({ type: "error", text: String(err) }));

onmessage = async (event) => {
  await ready;
  const { id, params } = event.data;
  try {
    const result = JSON.parse(runSsi(JSON.stringify(params)));
    postMessage({ type: "result", id, result });
  } catch (err) {
    postMessage({ type: "result", id, error: String(err) });
  }
};
