// CFN2IAM Application - Optimized & Simplified
class CFNIAMGenerator {
  constructor() {
    this.schemaCache = new Map();
    this.samRulesCache = new Map();
    // Keep the empty states from the page so Clear can restore them.
    this.initialPolicyHTML = document.getElementById("policyOutput").innerHTML;
    this.initialResourcesHTML = document.getElementById("resourcesOutput").innerHTML;
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

    this.showLoading(true);
    this.clearMessages();

    try {
      let permissions;
      let samInfo = null;
      let expandedResourceTypes = [];

      if (resourceType.startsWith("AWS::Serverless::")) {
        const samRule = await this.getSamRule(resourceType);
        const baseResources = samRule.base_resources || [];
        const conditionalResources = samRule.conditional_resources || [];

        const allResourceTypes = [...baseResources];
        conditionalResources.forEach((cr) => {
          allResourceTypes.push(...cr.resources);
        });

        expandedResourceTypes = [...new Set(allResourceTypes)];
        permissions = await this.getPermissionsForResources(expandedResourceTypes);
        samInfo = {
          baseResources,
          conditionalResources,
          logicalIdTemplates: samRule.logical_id_templates || [],
        };
      } else {
        expandedResourceTypes = [resourceType];
        permissions = await this.getPermissionsForResources([resourceType]);
      }

      const allowDelete = document.getElementById("allowDelete").checked;
      const policy = this.generatePolicyDocument(permissions, allowDelete);

      this.displaySingleResourcePolicyResult(
        resourceType,
        policy,
        expandedResourceTypes,
        permissions,
        samInfo
      );

      this.reportResult(`Generated the policy for ${resourceType}${samInfo ? ` (${expandedResourceTypes.length} resource types)` : ""}`);
    } catch (error) {
      this.showError(`Error: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
  }

  displaySingleResourcePolicyResult(resourceType, policy, expandedResourceTypes, permissions, samInfo) {
    this.renderPolicy(policy, permissions, expandedResourceTypes.length);

    const base = new Set(samInfo ? samInfo.baseResources : []);
    let resourcesHtml = `<p class="section-title">${escapeHTML(resourceType)}</p>`;
    if (samInfo) {
      resourcesHtml += `<p class="hint">Includes every resource this SAM type can create. A real template only needs the ones its properties turn on.</p>`;
    }
    resourcesHtml += this.renderResourceList(expandedResourceTypes, permissions, (type) =>
      samInfo ? (base.has(type) ? "always" : "conditional") : ""
    );

    document.getElementById("resourcesOutput").innerHTML = resourcesHtml;
    this.switchTab("policy");
  }

  // Shared result rendering for template and single-resource lookups.
  renderPolicy(policy, permissions, typeCount) {
    const unresolved = Object.entries(permissions.byResource || {}).filter(([, v]) => v.error);
    const notice = unresolved.length
      ? `<div class="notice"><strong>Incomplete policy.</strong> ${unresolved.length} resource type${unresolved.length === 1 ? "" : "s"} couldn't be resolved, so ${unresolved.length === 1 ? "its" : "their"} permissions are missing: ${unresolved.map(([t]) => `<code>${escapeHTML(t)}</code>`).join(", ")}. The CLI can look up private types in your account's CloudFormation registry.</div>`
      : "";
    const deleteLabel = document.getElementById("allowDelete").checked ? "delete actions allowed" : "delete actions denied";

    this.lastUnresolved = unresolved.length;
    document.getElementById("policyOutput").innerHTML = `
      ${notice}
      <div class="policy-summary">
        <span class="stat"><strong>${permissions.allUpdate.length}</strong> actions allowed</span>
        <span class="stat"><strong>${permissions.allDelete.length}</strong> ${deleteLabel}</span>
        <span class="stat"><strong>${typeCount}</strong> resource types</span>
      </div>
      <div class="code-block">
        <button class="copy-btn" type="button" onclick="copyToClipboard('policyOutput')">Copy</button>
        <pre id="policyJson">${highlightJSON(JSON.stringify(policy, null, 2))}</pre>
      </div>
    `;
  }

  renderResourceList(types, permissions, badgeFor) {
    const rows = [...types].sort().map((type) => {
      const info = (permissions.byResource || {})[type];
      const badge = info && info.error
        ? `<span class="badge error">not resolved</span>`
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

    this.showLoading(true);
    this.clearMessages();

    try {
      const template = this.parseTemplate(templateText);
      const { resourceTypes, samResources } = await this.extractAndValidateResources(template);

      if (resourceTypes.length === 0) {
        this.showError("No valid AWS resources found in template");
        return;
      }

      const permissions = await this.getPermissionsForResources(resourceTypes);
      const policy = this.generatePolicyDocument(permissions, allowDelete);

      this.displayResults(policy, resourceTypes, permissions, samResources);
      this.reportResult(`Generated the policy for ${resourceTypes.length} resource types`);
    } catch (error) {
      this.showError(`Error: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
  }

  parseTemplate(templateText) {
    try {
      return JSON.parse(templateText);
    } catch (jsonError) {
      try {
        return jsyaml.load(templateText, { schema: CFN_YAML_SCHEMA });
      } catch (yamlError) {
        throw new Error(`Invalid format. JSON error: ${jsonError.message}. YAML error: ${yamlError.message}`);
      }
    }
  }

  async extractAndValidateResources(template) {
    if (!template.Resources) {
      throw new Error("No Resources section found in template");
    }

    const resourceTypes = new Set();
    const samResources = [];
    const ignorePatterns = [/^Custom::.*/, /^AWS::CDK::Metadata$/, /^AWS::CloudFormation::CustomResource$/];

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      if (resource.Type && !ignorePatterns.some((pattern) => pattern.test(resource.Type))) {
        if (resource.Type.startsWith("AWS::Serverless::")) {
          samResources.push({ logicalId, resource });
          const expandedTypes = await this.expandSamResource(resource.Type, resource.Properties || {});
          expandedTypes.forEach((type) => resourceTypes.add(type));
        } else {
          resourceTypes.add(resource.Type);
        }
      }
    }

    return {
      resourceTypes: Array.from(resourceTypes),
      samResources,
    };
  }

  async expandSamResource(samResourceType, properties) {
    try {
      const samRule = await this.getSamRule(samResourceType);
      const expandedTypes = new Set();

      if (samRule.base_resources) {
        samRule.base_resources.forEach((type) => expandedTypes.add(type));
      }

      if (samRule.conditional_resources) {
        for (const condition of samRule.conditional_resources) {
          if (this.evaluateCondition(condition.condition, properties)) {
            condition.resources.forEach((type) => expandedTypes.add(type));
          }
        }
      }

      return Array.from(expandedTypes);
    } catch (error) {
      // No rule for this SAM type: keep the type itself so it shows up as unresolved
      // instead of silently dropping its permissions.
      return [samResourceType];
    }
  }

  // Same semantics as the CLI: a path can contain "*", and every value it reaches counts.
  evaluateCondition(condition, properties) {
    const { path, op, value } = condition;
    const values = valuesAtPath(properties, path.replace(/^properties\./, "").split("."));
    switch (op) {
      case "exists":
        return values.length > 0;
      case "truthy":
        return values.some(isTruthy);
      case "any_eq":
        return values.some((v) => v === value);
      case "all_eq":
        return values.length > 0 && values.every((v) => v === value);
      case "is_null":
        return values.every((v) => v === null || v === undefined);
      default:
        // Unknown operator: fail rather than silently dropping the rule's permissions.
        throw new Error(`Unsupported condition operator: ${op}`);
    }
  }

  async getSamRule(samResourceType) {
    if (this.samRulesCache.has(samResourceType)) {
      return this.samRulesCache.get(samResourceType);
    }

    const safeFilename = samResourceType.replace(/::/g, "_");
    const ruleUrl = `./backend/sam_rules/${safeFilename}.json`;

    try {
      const response = await fetch(ruleUrl);
      if (!response.ok) {
        throw new Error(`SAM rule not available (${response.status})`);
      }

      const rule = await response.json();
      this.samRulesCache.set(samResourceType, rule);
      return rule;
    } catch (error) {
      throw new Error(`SAM rule not found for ${samResourceType}`);
    }
  }

  async getPermissionsForResources(resourceTypes) {
    const allUpdatePermissions = new Set();
    const allDeletePermissions = new Set();
    const permissionsByResource = {};

    // PARALLEL FETCH OPTIMIZATION
    const schemaPromises = resourceTypes.map(async (resourceType) => {
      try {
        const schema = await this.getResourceSchema(resourceType);
        return { resourceType, schema, error: null };
      } catch (error) {
        return { resourceType, schema: null, error: error.message };
      }
    });

    const results = await Promise.all(schemaPromises);

    for (const { resourceType, schema, error } of results) {
      if (error) {
        permissionsByResource[resourceType] = {
          update: [],
          delete: [],
          error,
        };
        continue;
      }

      const { updatePermissions, deletePermissions } = this.extractPermissions(schema);

      updatePermissions.forEach((p) => allUpdatePermissions.add(p));
      deletePermissions.forEach((p) => allDeletePermissions.add(p));

      permissionsByResource[resourceType] = {
        update: Array.from(updatePermissions),
        delete: Array.from(deletePermissions),
      };
    }

    // An action can be delete-only for one type but needed to create or update another.
    // Keep it allowed: an explicit Deny would override the Allow and break the deploy.
    return {
      allUpdate: Array.from(allUpdatePermissions).sort(),
      allDelete: Array.from(allDeletePermissions).filter((p) => !allUpdatePermissions.has(p)).sort(),
      byResource: permissionsByResource,
    };
  }

  async getResourceSchema(resourceType) {
    if (this.schemaCache.has(resourceType)) {
      return this.schemaCache.get(resourceType);
    }

    const safeFilename = resourceType.replace(/::/g, "_").replace(/\//g, "_");
    const schemaUrl = `./backend/schemas/${safeFilename}.json`;

    try {
      const response = await fetch(schemaUrl);
      if (!response.ok) {
        throw new Error(`Schema not available (${response.status})`);
      }

      const schema = await response.json();
      this.schemaCache.set(resourceType, schema);
      return schema;
    } catch (error) {
      throw new Error(`Schema not found for ${resourceType}`);
    }
  }

  extractPermissions(schema) {
    const updatePermissions = new Set();
    const deletePermissions = new Set();

    if (schema.handlers) {
      ["create", "update", "read", "list"].forEach((action) => {
        if (schema.handlers[action]?.permissions) {
          schema.handlers[action].permissions.forEach((p) => updatePermissions.add(p));
        }
      });

      if (schema.handlers.delete?.permissions) {
        schema.handlers.delete.permissions.forEach((p) => {
          if (!updatePermissions.has(p)) {
            deletePermissions.add(p);
          }
        });
      }
    }

    return {
      updatePermissions: Array.from(updatePermissions),
      deletePermissions: Array.from(deletePermissions),
    };
  }

  generatePolicyDocument(permissions, allowDelete) {
    return this.generateTraditionalPolicy(permissions, allowDelete);
  }

  generateTraditionalPolicy(permissions, allowDelete) {
    const statements = [];

    if (permissions.allUpdate.length > 0) {
      statements.push({
        Effect: "Allow",
        Action: [...new Set(permissions.allUpdate)],
        Resource: "*",
      });
    }

    if (permissions.allDelete.length > 0) {
      statements.push({
        Effect: allowDelete ? "Allow" : "Deny",
        Action: [...new Set(permissions.allDelete)],
        Resource: "*",
      });
    }

    return {
      Version: "2012-10-17",
      Statement: statements,
    };
  }

  displayResults(policy, resourceTypes, permissions, samResources) {
    this.renderPolicy(policy, permissions, resourceTypes.length);

    let resourcesHtml = "";
    if (samResources.length > 0) {
      resourcesHtml += `<p class="section-title">SAM resources</p>`;
      resourcesHtml += `<div class="resource-list">${samResources
        .map((sr) => `<div class="resource-item"><span>${escapeHTML(sr.logicalId)}</span><span class="badge sam">${escapeHTML(sr.resource.Type)}</span></div>`)
        .join("")}</div>`;
    }
    resourcesHtml += `<p class="section-title">Resource types in the policy</p>`;
    resourcesHtml += this.renderResourceList(resourceTypes, permissions, () => "");

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

  showLoading(show) {
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

// CloudFormation short-form intrinsics (!Ref, !GetAtt, ...) for js-yaml, in all three node kinds.
const CFN_YAML_SCHEMA = (() => {
  const tags = ["Ref", "Condition", "GetAtt", "Sub", "Join", "Select", "Split", "FindInMap", "If", "Not",
    "Equals", "And", "Or", "Base64", "Cidr", "ImportValue", "GetAZs", "Transform", "Length", "ToJsonString",
    "ForEach", "Contains", "EachMemberEquals", "EachMemberIn", "RefAll", "ValueOf", "ValueOfAll"];
  const key = (tag) => (tag === "Ref" || tag === "Condition" ? tag : `Fn::${tag}`);
  const types = tags.flatMap((tag) =>
    ["scalar", "sequence", "mapping"].map(
      (kind) => new jsyaml.Type(`!${tag}`, { kind, construct: (data) => ({ [key(tag)]: data }) })
    )
  );
  return jsyaml.DEFAULT_SCHEMA.extend(types);
})();

// All values reached by a dotted path; "*" fans out over object values or array items.
function valuesAtPath(obj, parts) {
  let current = [obj];
  for (const part of parts) {
    const next = [];
    for (const node of current) {
      if (node === null || typeof node !== "object") continue;
      if (part === "*") next.push(...Object.values(node));
      else if (Object.prototype.hasOwnProperty.call(node, part)) next.push(node[part]);
    }
    current = next;
    if (!current.length) break;
  }
  return current;
}

function isTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
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