// CFN2IAM Application - Optimized & Simplified
class CFNIAMGenerator {
  constructor() {
    this.schemaCache = new Map();
    this.samRulesCache = new Map();
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
      tab.addEventListener("click", (e) => this.switchTab(e.target.dataset.tab));
    });
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

      this.showSuccess(
        `Generated IAM policy for ${resourceType}${samInfo ? ` (expanded to ${expandedResourceTypes.length} resources)` : ""}`
      );
    } catch (error) {
      this.showError(`Error: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
  }

  displaySingleResourcePolicyResult(resourceType, policy, expandedResourceTypes, permissions, samInfo) {
    document.getElementById("policyOutput").innerHTML = `
    <div class="code-block">
      <button class="copy-btn" onclick="copyToClipboard('policyOutput')">📋 Copy</button>
      <pre id="policyJson">${highlightJSON(JSON.stringify(policy, null, 2))}</pre>
    </div>
  `;

    let resourcesHtml = `<h4>Single Resource Lookup: ${resourceType}</h4>`;

    if (samInfo) {
      resourcesHtml += `
        <div class="sam-info">
          <h5>🚀 SAM Resource Expansion</h5>
          <p><strong>Base Resources:</strong> ${samInfo.baseResources.join(", ")}</p>
          <p><strong>Conditional Resources:</strong> ${samInfo.conditionalResources.length} rules</p>
          <p><strong>Logical ID Templates:</strong> ${samInfo.logicalIdTemplates.join(", ")}</p>
        </div>
      `;
    }

    resourcesHtml += `<h4>Expanded to ${expandedResourceTypes.length} resource type(s):</h4>`;
    resourcesHtml += expandedResourceTypes
      .map((type) => {
        const cssClass = samInfo ? "resource-item sam-resource" : "resource-item";
        return `<div class="${cssClass}">${type}</div>`;
      })
      .join("");

    document.getElementById("resourcesOutput").innerHTML = resourcesHtml;

    this.displayPermissionsBreakdown(permissions, resourceType, samInfo, expandedResourceTypes);
    this.switchTab("policy");
  }

  displayPermissionsBreakdown(permissions, resourceType, samInfo, expandedResourceTypes) {
    const outputElement = document.getElementById("permissionsOutput");
    if (!outputElement) return;

    let permissionsHtml = `
      <div class="permission-group">
        <h4>📊 Summary for ${resourceType}</h4>
        <p><strong>Create/Update/Read/List:</strong> ${permissions.allUpdate.length} permissions</p>
        <p><strong>Delete-only:</strong> ${permissions.allDelete.length} permissions</p>
        ${samInfo ? `<p><strong>SAM Resource:</strong> Expanded to ${expandedResourceTypes.length} underlying resources</p>` : ""}
      </div>
    `;

    if (permissions.allUpdate.length > 0) {
      permissionsHtml += `
        <div class="permission-group">
          <h4>✅ Allowed Permissions</h4>
          <div class="permission-list">
            ${permissions.allUpdate.map((p) => `<div class="permission-item">${p}</div>`).join("")}
          </div>
        </div>
      `;
    }

    if (permissions.allDelete.length > 0) {
      permissionsHtml += `
        <div class="permission-group">
          <h4>🗑️ Delete Permissions</h4>
          <div class="permission-list">
            ${permissions.allDelete.map((p) => `<div class="permission-item">${p}</div>`).join("")}
          </div>
        </div>
      `;
    }

    if (permissions.allUpdate.length === 0 && permissions.allDelete.length === 0) {
      permissionsHtml += `<div class="alert error">No permissions found or schema not available for this resource type.</div>`;
    }

    outputElement.innerHTML = permissionsHtml;
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
    document.getElementById("policyOutput").innerHTML = `
    <div style="padding: 2rem; text-align: center; color: var(--text-secondary);">
      Click "Generate Policy" to see results...
    </div>
  `;
    document.getElementById("resourcesOutput").innerHTML = "No resources analyzed yet...";
    const permissionsOutput = document.getElementById("permissionsOutput");
    if (permissionsOutput) {
      permissionsOutput.innerHTML = "No permissions analyzed yet...";
    }
    this.clearMessages();
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
      this.showSuccess(
        `Generated IAM policy for ${resourceTypes.length} resource types${samResources.length > 0 ? ` (${samResources.length} SAM resources)` : ""}`
      );
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
        return this.parseYamlSimple(templateText);
      } catch (yamlError) {
        throw new Error(`Invalid format. JSON error: ${jsonError.message}. YAML error: ${yamlError.message}`);
      }
    }
  }

  parseYamlSimple(templateText) {
    const result = { Resources: {} };
    const lines = templateText.split("\n");
    let inResources = false;
    let currentResource = null;
    let currentResourceIndent = 0;
    let resourcesIndent = 0;
    let inProperties = false;
    let propertiesIndent = 0;
    let currentSection = null;
    let currentSectionIndent = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      const lineIndent = line.length - line.trimStart().length;

      if (trimmed === "Resources:") {
        inResources = true;
        resourcesIndent = lineIndent;
        continue;
      }

      if (inResources) {
        if (line.trim() && lineIndent <= resourcesIndent) {
          break;
        }

        if (lineIndent === resourcesIndent + 2 && trimmed.endsWith(":") && !trimmed.includes(" ")) {
          currentResource = trimmed.slice(0, -1);
          currentResourceIndent = lineIndent;
          result.Resources[currentResource] = {};
          inProperties = false;
          currentSection = null;
          continue;
        }

        if (currentResource) {
          if (lineIndent === currentResourceIndent + 2 && trimmed.startsWith("Type:")) {
            const type = trimmed.replace("Type:", "").trim().replace(/['"]/g, "");
            result.Resources[currentResource].Type = type;
            continue;
          }

          if (lineIndent === currentResourceIndent + 2 && trimmed === "Properties:") {
            result.Resources[currentResource].Properties = {};
            inProperties = true;
            propertiesIndent = lineIndent;
            currentSection = null;
            continue;
          }

          if (inProperties) {
            if (lineIndent === propertiesIndent + 2 && trimmed.endsWith(":") && !trimmed.includes(" ")) {
              currentSection = trimmed.slice(0, -1);
              currentSectionIndent = lineIndent;
              result.Resources[currentResource].Properties[currentSection] = {};
              continue;
            }

            if (lineIndent === propertiesIndent + 2 && trimmed.includes(":") && !trimmed.endsWith(":")) {
              const [key, ...valueParts] = trimmed.split(":");
              const value = valueParts.join(":").trim().replace(/['"]/g, "");
              if (key && value) {
                result.Resources[currentResource].Properties[key] = value;
              }
            }

            if (currentSection && lineIndent > currentSectionIndent) {
              if (currentSection === "Events" && lineIndent === currentSectionIndent + 2 && trimmed.endsWith(":")) {
                const eventName = trimmed.slice(0, -1);
                result.Resources[currentResource].Properties.Events[eventName] = {};
              }

              if (currentSection === "Events" && trimmed.startsWith("Type:")) {
                const eventType = trimmed.replace("Type:", "").trim().replace(/['"]/g, "");
                const events = result.Resources[currentResource].Properties.Events;
                const eventKeys = Object.keys(events);
                if (eventKeys.length > 0) {
                  const lastEvent = eventKeys[eventKeys.length - 1];
                  events[lastEvent].Type = eventType;
                }
              }
            }
          }
        }
      }
    }
    return result;
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
      return [];
    }
  }

  evaluateCondition(condition, properties) {
    const { path, op, value } = condition;

    try {
      const pathValue = this.getNestedValue(properties, path);

      switch (op) {
        case "is_null":
          return pathValue == null;
        case "truthy":
          return !!pathValue;
        case "any_eq":
          if (path.includes("*")) {
            return this.evaluateWildcardPath(properties, path, value);
          }
          return pathValue === value;
        default:
          console.warn(`Unknown condition operator: ${op}`);
          return false;
      }
    } catch (error) {
      return false;
    }
  }

  evaluateWildcardPath(obj, path, expectedValue) {
    const parts = path.split(".");

    if (parts[0] === "properties" && parts.length >= 3) {
      const objectProp = parts[1];
      const wildcardIndex = parts.findIndex((part) => part === "*");

      if (wildcardIndex !== -1 && obj[objectProp]) {
        const targetObject = obj[objectProp];
        const pathAfterWildcard = parts.slice(wildcardIndex + 1);

        return Object.values(targetObject).some((item) => {
          if (!item) return false;

          let current = item;
          for (const pathPart of pathAfterWildcard) {
            if (!current || typeof current !== "object") return false;
            current = current[pathPart];
          }

          return current === expectedValue;
        });
      }
    }

    return false;
  }

  getNestedValue(obj, path) {
    if (path.startsWith("properties.")) {
      path = path.substring(11);
    }

    const parts = path.split(".");
    let current = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return null;
      }
      if (typeof current === "object" && part in current) {
        current = current[part];
      } else {
        return null;
      }
    }

    return current;
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

    return {
      allUpdate: Array.from(allUpdatePermissions).sort(),
      allDelete: Array.from(allDeletePermissions).sort(),
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
    document.getElementById("policyOutput").innerHTML = `
    <div class="code-block">
      <button class="copy-btn" onclick="copyToClipboard('policyOutput')">📋 Copy</button>
      <pre id="policyJson">${highlightJSON(JSON.stringify(policy, null, 2))}</pre>
    </div>
  `;

    let resourcesHtml = `<h4>Found ${resourceTypes.length} resource types:</h4>`;

    if (samResources.length > 0) {
      resourcesHtml += `
        <div class="sam-info">
          <h5>🚀 SAM Resources (${samResources.length})</h5>
          ${samResources.map((sr) => `<div class="resource-item sam-resource">${sr.logicalId}: ${sr.resource.Type}</div>`).join("")}
        </div>
      `;
    }

    resourcesHtml += resourceTypes
      .map((type) => {
        const isSamExpanded = samResources.some((sr) => sr.resource.Type.startsWith("AWS::Serverless::"));
        const cssClass = isSamExpanded && !type.startsWith("AWS::Serverless::") ? "resource-item sam-resource" : "resource-item";
        return `<div class="${cssClass}">${type}</div>`;
      })
      .join("");

    document.getElementById("resourcesOutput").innerHTML = resourcesHtml;

    this.displayPermissionsBreakdown(permissions, "Template Analysis", samResources.length > 0 ? samResources : null, resourceTypes);
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
    document.querySelector(".card").appendChild(div);
    setTimeout(() => div.remove(), 5000);
  }

  clearMessages() {
    document.querySelectorAll(".alert").forEach((el) => el.remove());
  }
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
  if (btn) {
    const originalText = btn.textContent;
    btn.textContent = "✅ Copied!";
    setTimeout(() => {
      btn.textContent = originalText;
    }, 3000);
  }
}

new CFNIAMGenerator();