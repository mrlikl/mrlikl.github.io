// Installs the cfn2iam release pinned in cfn2iam/requirements.txt the way the page does
// (cfn2iam/runtime.js: PyPI lookup, SHA-256 check, micropip with deps=False) and runs a
// template through cfn2iam.core against this repo's cfn2iam/backend/.
//
//   npm install --no-save --prefix <dir> pyodide@<PYODIDE_VERSION from cfn2iam/runtime.js>
//   node .github/scripts/check-cfn2iam.mjs <dir>/node_modules/pyodide
//
// backend/ is served on a local port so the page's own fetch glue (pyfetch) is what reads it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pyodideDir = process.argv[2];
if (!pyodideDir) {
  console.error("usage: node check-cfn2iam.mjs <pyodide package dir>");
  process.exit(2);
}

const site = resolve(fileURLToPath(new URL("../../cfn2iam/", import.meta.url)));
const runtime = await import(pathToFileURL(join(site, "runtime.js")).href);

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[/\\]+/, "");
  try {
    if (path.startsWith("..")) throw new Error("outside the site");
    const body = await readFile(join(site, path));
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const backendURL = `http://127.0.0.1:${server.address().port}/backend/`;

const TEMPLATE = `
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Resources:
  HelloWorldFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.lambdaHandler
      Runtime: nodejs22.x
      Events:
        HelloWorld:
          Type: Api
          Properties: {Path: /hello, Method: get}
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "\${AWS::StackName}-bucket"
  Table:
    Type: AWS::Serverless::SimpleTable
`;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

let failed = false;
try {
  const requirements = await readFile(join(site, "requirements.txt"), "utf8");
  const pin = runtime.parsePin(requirements);
  console.log(`requirements.txt pins cfn2iam ${pin.version} (${pin.hashes.length} hashes)`);

  const wheel = runtime.fetchPinnedWheel(requirements);
  const { loadPyodide } = await import(pathToFileURL(join(resolve(pyodideDir), "pyodide.mjs")).href);
  const core = await runtime.startCore({ loadPyodide, wheel, backendURL, onStatus: (m) => console.log(m) });
  const { filename, sha256 } = await wheel;
  console.log(`installed ${filename} (sha256 ${sha256}) under Pyodide ${core.pyodide.version}`);

  const analysis = await core.analyzeTemplate(TEMPLATE, false);
  check(!analysis.error, `template error: ${analysis.error}`);
  check(Object.keys(analysis.unresolved).length === 0, `unresolved types: ${JSON.stringify(analysis.unresolved)}`);
  for (const type of ["AWS::Lambda::Function", "AWS::S3::Bucket", "AWS::DynamoDB::Table", "AWS::ApiGateway::RestApi"]) {
    check(analysis.resource_types.includes(type), `${type} missing from ${analysis.resource_types.join(", ")}`);
  }
  const statements = analysis.policy.Statement;
  check(statements.some((s) => s.Effect === "Allow" && s.Action.includes("s3:CreateBucket")), "no s3:CreateBucket in the Allow statement");
  check(statements.some((s) => s.Effect === "Deny" && s.Action.length > 0), "delete actions were not denied");
  console.log(`template: ${analysis.resource_types.length} resource types, ${analysis.allow.length} allowed, ${analysis.delete.length} denied`);

  const lookup = await core.analyzeResourceType("AWS::S3::Bucket", true);
  check(!lookup.error && lookup.allow.length > 0, `lookup failed: ${JSON.stringify(lookup).slice(0, 300)}`);
  console.log(`lookup AWS::S3::Bucket: ${lookup.allow.length} allowed, ${lookup.delete.length} delete`);

  const cliOnly = core.pyodide.runPython(
    "import sys, json; json.dumps(sorted(m for m in ('typer', 'click', 'boto3', 'cfn2iam.app') if m in sys.modules))"
  );
  check(cliOnly === "[]", `CLI-only modules were imported: ${cliOnly}`);
  console.log(`cfn2iam ${core.version} works the way the page runs it`);
} catch (error) {
  console.error(`FAILED: ${error.message ?? error}`);
  failed = true;
} finally {
  server.close();
}
process.exit(failed ? 1 : 0);
