// cfn2iam web UI.
//
// The logic is not here: the page runs the cfn2iam Python package (cfn2iam.core)
// in the browser with Pyodide, so the web version and the CLI are one
// implementation. This file only loads that runtime and renders what it returns.

const PYODIDE_VERSION = "314.0.7";
const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// The cfn2iam release the page installs from PyPI. `?wheel=<same-origin URL>` overrides it.
const CFN2IAM_VERSION = "0.3.0";

// Glue between the page and cfn2iam.core: fetch backend files relative to the page,
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

class CoreRuntime {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.ready = this.load();
    // The error is shown by onStatus; keep it from surfacing as an unhandled rejection.
    this.ready.catch(() => {});
  }

  wheelSource() {
    const override = new URLSearchParams(location.search).get("wheel");
    if (!override) return { spec: `cfn2iam==${CFN2IAM_VERSION}`, label: `cfn2iam ${CFN2IAM_VERSION} from PyPI` };
    const url = new URL(override, location.href);
    // Installing a wheel runs its code in this page, so only accept one served by this site.
    if (url.origin !== location.origin) {
      throw new Error(`?wheel must point to a file on ${location.origin}, not ${url.origin}`);
    }
    return { spec: url.href, label: `cfn2iam wheel ${url.pathname}`, override: url.pathname };
  }

  async load() {
    const started = performance.now();
    try {
      const source = this.wheelSource();
      this.onStatus("loading", "Loading the Python runtime (Pyodide)…");
      const { loadPyodide } = await import(`${PYODIDE_INDEX_URL}pyodide.mjs`);
      const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
      await pyodide.loadPackage(["micropip", "pyyaml"], { messageCallback: () => {} });

      this.onStatus("loading", `Installing ${source.label}…`);
      const install = pyodide.toPy({ spec: source.spec });
      try {
        // deps=False: the core needs only PyYAML (loaded above); typer and boto3 are for the CLI.
        await pyodide.runPythonAsync("import micropip\nawait micropip.install(spec, deps=False)", { globals: install });
      } finally {
        install.destroy();
      }

      pyodide.globals.set("BACKEND_URL", new URL("backend/", location.href).href);
      await pyodide.runPythonAsync(PYTHON_GLUE);
      this.analyzeTemplateFn = pyodide.globals.get("analyze_template");
      this.analyzeResourceTypeFn = pyodide.globals.get("analyze_resource_type");
      this.version = pyodide.runPython("from importlib.metadata import version; version('cfn2iam')");

      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      this.onStatus("ready", `cfn2iam ${this.version}${source.override ? ` from ${source.override}` : ""} · runs in your browser with Pyodide · ready in ${seconds}s`);
    } catch (error) {
      this.onStatus("error", `Couldn't start cfn2iam in your browser: ${firstLine(error)}`);
      throw error;
    }
  }

  async analyzeTemplate(text, allowDelete) {
    await this.ready;
    return JSON.parse(await this.analyzeTemplateFn(text, allowDelete));
  }

  async analyzeResourceType(resourceType, allowDelete) {
    await this.ready;
    return JSON.parse(await this.analyzeResourceTypeFn(resourceType, allowDelete));
  }
}

class CFNIAMGenerator {
  constructor() {
    // Keep the empty states from the page so Clear can restore them.
    this.initialPolicyHTML = document.getElementById("policyOutput").innerHTML;
    this.initialResourcesHTML = document.getElementById("resourcesOutput").innerHTML;
    this.runtime = new CoreRuntime((state, message) => this.setRuntimeStatus(state, message));
    this.initializeEventListeners();
  }

  initializeEventListeners() {
    document.getElementById("generateBtn").addEventListener("click", () => this.generatePolicy());
    document.getElementById("loadExampleBtn").addEventListener("click", () => this.loadExample());
    document.getElementById("loadSamExampleBtn").addEventListener("click", () => this.loadSamExample());
    document.getElementById("clearBtn").addEventListener("click", () => this.clearAll());
    document.getElementById("fileInput").addEventListener("change", (e) => this.handleFileUpload(e));
    document.getElementById("lookupBtn").addEventListener("click", () => this.lookupSingleResource());

    const fileUpload = document.getElementById("fileUpload");
    fileUpload.addEventListener("dragover", (e) => {
      e.preventDefault();
      fileUpload.classList.add("dragover");
    });
    fileUpload.addEventListener("dragleave", () => {
      fileUpload.classList.remove("dragover");
    });
    fileUpload.addEventListener("drop", (e) => {
      e.preventDefault();
      fileUpload.classList.remove("dragover");
      this.handleFileUpload({ target: { files: e.dataTransfer.files } });
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => this.switchTab(tab.dataset.tab));
    });

    document.querySelectorAll(".seg").forEach((seg) => {
      seg.addEventListener("click", () => this.switchMode(seg.dataset.mode));
    });

    document.getElementById("singleResourceType").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.lookupSingleResource();
    });

    document.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.getElementById("singleResourceType").value = chip.dataset.type;
        this.lookupSingleResource();
      });
    });

    document.getElementById("templateInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) this.generatePolicy();
    });
  }

  setRuntimeStatus(state, message) {
    const el = document.getElementById("runtimeStatus");
    el.dataset.state = state;
    el.querySelector(".runtime-text").textContent = message;
    el.setAttribute("role", state === "error" ? "alert" : "status");
    if (state === "error") this.showError(message);
  }

  switchMode(mode) {
    document.querySelector(".workbench").dataset.mode = mode;
    document.querySelectorAll(".seg").forEach((s) => {
      const active = s.dataset.mode === mode;
      s.classList.toggle("active", active);
      s.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".mode").forEach((p) => p.classList.toggle("active", p.dataset.modePanel === mode));
    if (mode === "lookup") document.getElementById("singleResourceType").focus();
  }

  // Runs one analysis with the loading overlay up, waiting for the runtime if it is still starting.
  async runAnalysis(call) {
    const runtimeReady = document.getElementById("runtimeStatus").dataset.state === "ready";
    this.showLoading(true, runtimeReady ? "Resolving resource schemas…" : "Starting Python in your browser…");
    this.clearMessages();
    try {
      const result = await call();
      // A template the core can't read: show its message whole, on one line.
      if (result.error) throw new Error(result.error.replace(/\s+/g, " "));
      return result;
    } finally {
      this.showLoading(false);
    }
  }

  async lookupSingleResource() {
    const resourceType = document.getElementById("singleResourceType").value.trim();

    if (!resourceType) {
      this.showError("Please enter a resource type");
      return;
    }

    if (!resourceType.includes("::")) {
      this.showError("Resource type must be in format AWS::Service::Resource");
      return;
    }

    const allowDelete = document.getElementById("allowDelete").checked;
    try {
      const result = await this.runAnalysis(() => this.runtime.analyzeResourceType(resourceType, allowDelete));
      this.displaySingleResourcePolicyResult(resourceType, result);
      this.reportResult(`Generated the policy for ${resourceType}${result.sam ? ` (${result.resource_types.length} resource types)` : ""}`);
    } catch (error) {
      this.showError(`Error: ${firstLine(error)}`);
    }
  }

  displaySingleResourcePolicyResult(resourceType, result) {
    this.renderPolicy(result);

    const sam = result.sam;
    const base = new Set(sam ? sam.base_resources : []);
    let resourcesHtml = `<p class="section-title">${escapeHTML(resourceType)}</p>`;
    if (sam) {
      resourcesHtml += `<p class="hint">Includes every resource this SAM type can create. A real template only needs the ones its properties turn on.</p>`;
    }
    resourcesHtml += this.renderResourceList(result, (type) =>
      sam ? (base.has(type) ? "always" : "conditional") : ""
    );

    document.getElementById("resourcesOutput").innerHTML = resourcesHtml;
    this.switchTab("policy");
  }

  // Shared result rendering for template and single-resource lookups.
  renderPolicy(result) {
    const unresolved = Object.keys(result.unresolved);
    const n = unresolved.length;
    const notice = n
      ? `<div class="notice"><strong>Incomplete policy.</strong> ${n} resource type${n === 1 ? "" : "s"} couldn't be resolved, so ${n === 1 ? "its" : "their"} permissions are missing: ${unresolved.map((t) => `<code title="${escapeHTML(result.unresolved[t])}">${escapeHTML(t)}</code>`).join(", ")}. The CLI can look up private types in your account's CloudFormation registry.</div>`
      : "";
    const deleteLabel = document.getElementById("allowDelete").checked ? "delete actions allowed" : "delete actions denied";

    this.lastUnresolved = n;
    document.getElementById("policyOutput").innerHTML = `
      ${notice}
      <div class="policy-summary">
        <span class="stat"><strong>${result.allow.length}</strong> actions allowed</span>
        <span class="stat"><strong>${result.delete.length}</strong> ${deleteLabel}</span>
        <span class="stat"><strong>${result.resource_types.length}</strong> resource types</span>
      </div>
      <div class="code-block">
        <button class="copy-btn" type="button" onclick="copyToClipboard('policyOutput')">Copy</button>
        <pre id="policyJson">${highlightJSON(JSON.stringify(result.policy, null, 2))}</pre>
      </div>
    `;
  }

  renderResourceList(result, badgeFor) {
    const rows = [...result.resource_types].sort().map((type) => {
      const info = result.by_type[type];
      const badge = info && info.error
        ? `<span class="badge error" title="${escapeHTML(info.error)}">not resolved</span>`
        : badgeFor(type)
          ? `<span class="badge${badgeFor(type) === "from SAM" ? " sam" : ""}">${badgeFor(type)}</span>`
          : "";
      return `<div class="resource-item"><span>${escapeHTML(type)}</span>${badge}</div>`;
    });
    return `<div class="resource-list">${rows.join("")}</div>`;
  }

  handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      this.showError("File is too large (max 1MB)");
      return;
    }

    const validExtensions = [".json", ".yaml", ".yml", ".template"];
    const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf("."));
    if (!validExtensions.includes(fileExtension)) {
      this.showError("Please upload a valid CloudFormation template (.json, .yaml, .yml, .template)");
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      document.getElementById("templateInput").value = e.target.result;
      this.showSuccess(`Loaded file: ${file.name}`);
    };
    reader.readAsText(file);
  }

  clearAll() {
    document.getElementById("templateInput").value = "";
    document.getElementById("singleResourceType").value = "";
    document.getElementById("policyOutput").innerHTML = this.initialPolicyHTML;
    document.getElementById("resourcesOutput").innerHTML = this.initialResourcesHTML;
    this.clearMessages();
    this.switchTab("policy");
  }

  switchTab(tabName) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".output-content").forEach((c) => c.classList.remove("active"));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add("active");
    document.getElementById(`${tabName}-content`).classList.add("active");
  }

  async generatePolicy() {
    const templateText = document.getElementById("templateInput").value.trim();
    const allowDelete = document.getElementById("allowDelete").checked;

    if (!templateText) {
      this.showError("Please enter a CloudFormation/SAM template or upload a file");
      return;
    }

    if (templateText.length > 1024 * 1024) {
      this.showError("Template is too large (max 1MB)");
      return;
    }

    try {
      const result = await this.runAnalysis(() => this.runtime.analyzeTemplate(templateText, allowDelete));
      if (result.resource_types.length === 0) {
        this.showError("No valid AWS resources found in template");
        return;
      }
      this.displayResults(result);
      this.reportResult(`Generated the policy for ${result.resource_types.length} resource types`);
    } catch (error) {
      this.showError(`Error: ${firstLine(error)}`);
    }
  }

  displayResults(result) {
    this.renderPolicy(result);

    let resourcesHtml = "";
    if (result.sam_resources.length > 0) {
      resourcesHtml += `<p class="section-title">SAM resources</p>`;
      resourcesHtml += `<div class="resource-list">${result.sam_resources
        .map((sr) => `<div class="resource-item" title="Creates ${escapeHTML(sr.expands_to.join(", "))}"><span>${escapeHTML(sr.logical_id)}</span><span class="badge sam">${escapeHTML(sr.type)}</span></div>`)
        .join("")}</div>`;
    }
    resourcesHtml += `<p class="section-title">Resource types in the policy</p>`;
    resourcesHtml += this.renderResourceList(result, () => "");

    document.getElementById("resourcesOutput").innerHTML = resourcesHtml;
    this.switchTab("policy");
  }

  loadExample() {
    const example = {
      Resources: {
        myInstance: {
          Type: "AWS::EC2::Instance",
          Properties: {
            ImageId: "ami-0a70b9d193ae8a799",
            InstanceType: "t2.micro",
            KeyName: "my-key-pair",
            SecurityGroupIds: ["sg-12a4c434"],
          },
        },
      },
    };

    document.getElementById("templateInput").value = JSON.stringify(example, null, 2);
    this.showSuccess("Loaded example template with an EC2 instance");
  }

  loadSamExample() {
    const samExample = {
      AWSTemplateFormatVersion: "2010-09-09",
      Transform: "AWS::Serverless-2016-10-31",
      Description: "Example SAM template for cfn2iam",
      Globals: {
        Function: {
          Timeout: 3,
        },
      },
      Resources: {
        HelloWorldFunction: {
          Type: "AWS::Serverless::Function",
          Properties: {
            CodeUri: "hello-world/",
            Handler: "app.lambdaHandler",
            Runtime: "nodejs18.x",
            Events: {
              HelloWorld: {
                Type: "Api",
                Properties: {
                  Path: "/hello",
                  Method: "get",
                },
              },
              ScheduledEvent: {
                Type: "Schedule",
                Properties: {
                  Schedule: "rate(5 minutes)",
                },
              },
            },
          },
        },
        MyServerlessApi: {
          Type: "AWS::Serverless::Api",
          Properties: {
            StageName: "prod",
            Auth: {
              DefaultAuthorizer: "CognitoAuthorizer",
              Authorizers: {
                CognitoAuthorizer: {
                  UserPoolArn: "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_example",
                },
              },
            },
          },
        },
        MyTable: {
          Type: "AWS::Serverless::SimpleTable",
          Properties: {
            PrimaryKey: {
              Name: "id",
              Type: "String",
            },
            BillingMode: "PAY_PER_REQUEST",
          },
        },
        MyStateMachine: {
          Type: "AWS::Serverless::StateMachine",
          Properties: {
            DefinitionUri: "statemachine.asl.json",
            Events: {
              CloudWatchEvent: {
                Type: "EventBridgeRule",
                Properties: {
                  Pattern: {
                    source: ["aws.s3"],
                  },
                },
              },
            },
          },
        },
      },
      Outputs: {
        HelloWorldApi: {
          Description: "API Gateway endpoint URL for Prod stage for Hello World function",
          Value: {
            "Fn::Sub": "https://${ServerlessRestApi}.execute-api.${AWS::Region}.amazonaws.com/Prod/hello/",
          },
        },
        HelloWorldFunction: {
          Description: "Hello World Lambda Function ARN",
          Value: { "Fn::GetAtt": ["HelloWorldFunction", "Arn"] },
        },
      },
    };

    document.getElementById("templateInput").value = JSON.stringify(samExample, null, 2);
    this.showSuccess("Loaded SAM example with Function, API, SimpleTable, and StateMachine");
  }

  showLoading(show, message) {
    if (message) document.getElementById("loadingText").textContent = message;
    document.getElementById("loading").style.display = show ? "block" : "none";
    document.getElementById("generateBtn").disabled = show;
    document.getElementById("lookupBtn").disabled = show;
  }

  // After rendering: success, unless some types couldn't be resolved.
  reportResult(successMessage) {
    if (this.lastUnresolved) {
      const n = this.lastUnresolved;
      this.showError(`The policy is incomplete: ${n} resource type${n === 1 ? "" : "s"} couldn't be resolved`);
    } else {
      this.showSuccess(successMessage);
    }
  }

  showError(message) {
    this.showMessage(message, "error");
  }

  showSuccess(message) {
    this.showMessage(message, "success");
  }

  showMessage(message, type) {
    this.clearMessages();
    const div = document.createElement("div");
    div.className = `alert ${type}`;
    div.textContent = message;
    div.setAttribute("role", type === "error" ? "alert" : "status");
    document.getElementById("toasts").appendChild(div);
    setTimeout(() => div.remove(), type === "error" ? 7000 : 3500);
  }

  clearMessages() {
    document.querySelectorAll(".alert").forEach((el) => el.remove());
  }
}

// An error's message on one line. For a Python error, that's the exception and its
// message, without the traceback frames before it.
function firstLine(error) {
  const lines = String((error && error.message) || error).trim().split("\n");
  let start = 0;
  lines.forEach((line, i) => {
    if (/^\s+File "/.test(line)) start = i + 1;
  });
  // Skip the frame's source line and its ^^^ markers.
  while (start < lines.length - 1 && /^\s{4}/.test(lines[start])) start += 1;
  return lines.slice(start).join(" ").replace(/\s+/g, " ").trim();
}

// JSON syntax highlighting helper
function highlightJSON(json) {
  return json
    .replace(/("(\u[a-zA-Z0-9]{4}|\.[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
      let cls = "json-number";
      if (/^".*$/.test(match)) {
        if (/:$/.test(match)) {
          cls = "json-key";
        } else {
          cls = "json-string";
        }
      } else if (/true|false/.test(match)) {
        cls = "json-boolean";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + match + "</span>";
    })
    .replace(/([{}[\],])/g, '<span class="json-punctuation">$1</span>');
}

function copyToClipboard(elementId) {
  const element = document.getElementById(elementId);
  let text;

  if (elementId === "policyOutput") {
    // Look inside the code-block for the pre element
    const codeBlock = element.querySelector(".code-block");
    const preElement = codeBlock ? codeBlock.querySelector("#policyJson") : null;
    text = preElement ? preElement.textContent : element.textContent;
  } else {
    text = element.textContent;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        showCopySuccess(element);
      })
      .catch(() => {
        fallbackCopyToClipboard(text, element);
      });
  } else {
    fallbackCopyToClipboard(text, element);
  }
}

function fallbackCopyToClipboard(text, element) {
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-999999px";
  textArea.style.top = "-999999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    document.execCommand("copy");
    showCopySuccess(element);
  } catch (err) {
    // Silently handle clipboard errors
  }

  document.body.removeChild(textArea);
}

function showCopySuccess(element) {
  const btn = element.querySelector(".copy-btn");
  if (btn) flashCopied(btn);
}

function flashCopied(btn) {
  const originalText = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => {
    btn.textContent = originalText;
  }, 2000);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

new CFNIAMGenerator();
