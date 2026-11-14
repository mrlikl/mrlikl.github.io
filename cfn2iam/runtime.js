// Starts cfn2iam.core under Pyodide. An ES module shared by the page (app.js) and the
// CI check (.github/scripts/check-cfn2iam.mjs), so both install and call the core the same way.
//
// The cfn2iam release comes from requirements.txt next to the page (Dependabot bumps it):
// its version is looked up on PyPI, its wheel downloaded from files.pythonhosted.org, and
// its SHA-256 checked against the pinned hashes before it is installed. The version's own
// JSON URL is used rather than the package index (/simple/cfn2iam/), which PyPI and the
// browser cache for up to 10 minutes and so can miss a release that was just published.

export const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

const PYPI = "https://pypi.org/pypi";
const RELOAD = "then reload the page";

// Glue between JavaScript and cfn2iam.core: fetch backend files from BACKEND_URL,
// and hand results back to JavaScript as JSON strings.
const PYTHON_GLUE = `
import json
from pyodide.http import pyfetch
from cfn2iam import core

_cache = {}

async def _fetch_json(path):
    if path in _cache:
        return _cache[path]
    response = await pyfetch(BACKEND_URL + path)
    if response.status == 404:
        raise core.NotFound(path)
    if not response.ok:
        raise OSError(f"HTTP {response.status} for {path}")
    data = await response.json()
    _cache[path] = data
    return data

async def _run(make):
    try:
        analysis = await make()
    except (core.TemplateError, ValueError) as e:
        return json.dumps({"error": str(e)})
    return json.dumps(analysis.to_dict())

async def analyze_template(text, allow_delete):
    return await _run(lambda: core.analyze_template(text, _fetch_json, allow_delete=bool(allow_delete)))

async def analyze_resource_type(resource_type, allow_delete):
    return await _run(lambda: core.analyze_resource_type(resource_type, _fetch_json, allow_delete=bool(allow_delete)))
`;

// A startup failure with a message that says what to do about it.
export class StartupError extends Error {}

// The cfn2iam pin in requirements.txt: `cfn2iam==X.Y.Z` with one or more `--hash=sha256:...`.
export function parsePin(text) {
  const logical = text.replace(/\\\r?\n/g, " ").split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, "").trim());
  const line = logical.find((l) => /^cfn2iam\s*==/i.test(l));
  const version = line && line.match(/^cfn2iam\s*==\s*([0-9][^\s;]*)/i);
  const hashes = line ? [...line.matchAll(/--hash[=\s]sha256:([0-9a-f]{64})\b/gi)].map((m) => m[1].toLowerCase()) : [];
  if (!version || hashes.length === 0) {
    throw new StartupError("requirements.txt has no `cfn2iam==<version>` line with a --hash=sha256:… pin");
  }
  return { version: version[1], hashes };
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto || !crypto.subtle) {
    throw new StartupError("this page needs a secure context (https:// or localhost) to verify the cfn2iam download");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchOrExplain(url, what, host) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new StartupError(`couldn't reach ${host} to ${what} (${error.message}). Check your connection, or allow ${host} if a network filter or extension blocks it, ${RELOAD}.`);
  }
  return response;
}

// Finds the pinned release's wheel on PyPI, downloads it and checks its hash.
// Returns { version, filename, bytes, sha256 }.
export async function fetchPinnedWheel(requirementsText) {
  const pin = parsePin(requirementsText);
  const what = `look up cfn2iam ${pin.version}`;
  const meta = await fetchOrExplain(`${PYPI}/cfn2iam/${encodeURIComponent(pin.version)}/json`, what, "pypi.org");
  if (meta.status === 404) {
    throw new StartupError(`PyPI has no cfn2iam ${pin.version} (HTTP 404), the version pinned in requirements.txt`);
  }
  if (!meta.ok) throw new StartupError(`PyPI answered HTTP ${meta.status} when asked for cfn2iam ${pin.version}; try again later`);
  const files = (await meta.json()).urls || [];

  const wheels = files.filter((f) => f.packagetype === "bdist_wheel" && f.filename.endsWith("-py3-none-any.whl"));
  const wheel = wheels.find((f) => pin.hashes.includes(String(f.digests && f.digests.sha256).toLowerCase()));
  if (!wheel) {
    throw new StartupError(
      wheels.length
        ? `PyPI's cfn2iam ${pin.version} wheel doesn't match the hashes pinned in requirements.txt, so it won't be run`
        : `PyPI has no pure-Python wheel for cfn2iam ${pin.version}`
    );
  }

  const download = await fetchOrExplain(wheel.url, `download cfn2iam ${pin.version}`, "files.pythonhosted.org");
  if (!download.ok) throw new StartupError(`downloading cfn2iam ${pin.version} from files.pythonhosted.org failed with HTTP ${download.status}; try again later`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (!pin.hashes.includes(sha256)) {
    throw new StartupError(`the downloaded cfn2iam ${pin.version} wheel has SHA-256 ${sha256}, which isn't pinned in requirements.txt, so it won't be run`);
  }
  return { version: pin.version, filename: wheel.filename, bytes, sha256 };
}

// Loads Pyodide, installs cfn2iam and returns the core's two entry points.
//   loadPyodide  async (options) => pyodide, e.g. importing pyodide.mjs from the CDN (browser) or npm (Node)
//   pyodideOptions  passed to loadPyodide
//   wheel  a promise of fetchPinnedWheel(...)'s result, or { url } for a wheel URL micropip fetches itself
//   backendURL  where cfn2iam/backend/ is served, ending in "/"
export async function startCore({ loadPyodide, pyodideOptions = {}, wheel, backendURL, onStatus = () => {} }) {
  // The wheel downloads while Pyodide loads; if both fail, the Pyodide error is the one reported.
  Promise.resolve(wheel).catch(() => {});
  onStatus(`Loading the Python runtime (Pyodide ${PYODIDE_VERSION})…`);
  let pyodide;
  try {
    pyodide = await loadPyodide(pyodideOptions);
    await pyodide.loadPackage(["micropip", "pyyaml"], { messageCallback: () => {}, errorCallback: () => {} });
  } catch (error) {
    throw new StartupError(`couldn't load the Python runtime from cdn.jsdelivr.net (${firstLineOf(error)}). Check your connection, or allow cdn.jsdelivr.net if a network filter or extension blocks it, ${RELOAD}.`);
  }

  const source = await wheel;
  onStatus(source.url ? `Installing cfn2iam from ${source.url}…` : `Installing cfn2iam ${source.version}…`);
  let spec = source.url;
  if (!spec) {
    spec = `emfs:/tmp/${source.filename}`;
    pyodide.FS.writeFile(`/tmp/${source.filename}`, source.bytes);
  }
  const install = pyodide.toPy({ spec });
  try {
    // deps=False: the core needs only PyYAML (loaded above); typer and boto3 are for the CLI.
    await pyodide.runPythonAsync("import micropip\nawait micropip.install(spec, deps=False)", { globals: install });
  } finally {
    install.destroy();
  }

  pyodide.globals.set("BACKEND_URL", backendURL);
  await pyodide.runPythonAsync(PYTHON_GLUE);
  const version = pyodide.runPython("from importlib.metadata import version; version('cfn2iam')");
  if (!source.url && version !== source.version) {
    throw new StartupError(`installed cfn2iam ${version}, but requirements.txt pins ${source.version}`);
  }
  const analyzeTemplate = pyodide.globals.get("analyze_template");
  const analyzeResourceType = pyodide.globals.get("analyze_resource_type");
  return {
    pyodide,
    version,
    analyzeTemplate: async (text, allowDelete) => JSON.parse(await analyzeTemplate(text, allowDelete)),
    analyzeResourceType: async (type, allowDelete) => JSON.parse(await analyzeResourceType(type, allowDelete)),
  };
}

function firstLineOf(error) {
  return String((error && error.message) || error).trim().split("\n")[0];
}
