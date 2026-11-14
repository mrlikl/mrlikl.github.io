// Installs the cfn2iam release pinned in cfn2iam/requirements.txt the way the page does
// (cfn2iam/runtime.js: PyPI lookup, SHA-256 check, micropip with deps=False) and runs a
// template through cfn2iam.core against this repo's cfn2iam/backend/.
//
//   npm install --no-save --prefix <dir> pyodide@<PYODIDE_VERSION from cfn2iam/runtime.js>
//   node .github/scripts/check-cfn2iam.mjs <dir>/node_modules/pyodide
//
// Resource scoping (account and region) arrived in cfn2iam 0.4.0. If the pinned release has
// it, the check also runs a scoped analysis; if not, it logs that and skips that part.
// To try an unreleased build, set CFN2IAM_WHEEL=<path to a .whl> to install it instead of
// the pinned release (the pin and its hash are not checked then).
//
// backend/ is served on a local port so the page's own fetch glue (pyfetch) is what reads it.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
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

  const localWheel = process.env.CFN2IAM_WHEEL;
  const wheel = localWheel
    ? readFile(localWheel).then((bytes) => ({
        version: basename(localWheel).split("-")[1],
        filename: basename(localWheel),
        bytes: new Uint8Array(bytes),
        sha256: "(local wheel)",
      }))
    : runtime.fetchPinnedWheel(requirements);
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

  if (core.scoping) {
    const account = "123456789012";
    const region = "us-east-1";
    const scoped = await core.analyzeTemplate(TEMPLATE, false, { account, region });
    check(!scoped.error, `scoped template error: ${scoped.error}`);
    check(scoped.scoping && scoped.scoping.account === account && scoped.scoping.region === region, `no scoping report: ${JSON.stringify(scoped.scoping)}`);
    check(scoped.scoping.scoped_count > 0, "no action was scoped");
    check(scoped.policy.Statement.length > 2, `expected several statements, got ${scoped.policy.Statement.length}`);
    const s3 = scoped.policy.Statement.find((s) => s.Effect === "Allow" && s.Action.includes("s3:CreateBucket"));
    check(s3 && [].concat(s3.Resource).every((r) => r !== "*" && r.startsWith("arn:aws:s3:")), `s3:CreateBucket is not scoped: ${JSON.stringify(s3)}`);
    check(scoped.policy.Statement.some((s) => s.Effect === "Deny" && s.Resource === "*"), "the Deny statement is not on Resource *");
    check(Object.keys(core.scoping.reasons).length > 0 && typeof scoped.policy_size === "number", "reasons or policy_size missing");
    console.log(`scoped template: ${scoped.scoping.scoped_count} scoped, ${scoped.scoping.unscoped_count} on *, ${scoped.policy.Statement.length} statements, ${scoped.policy_size} characters`);

    const unscoped = await core.analyzeTemplate(TEMPLATE, false, {});
    check(unscoped.scoping === null && unscoped.policy.Statement.length <= 2, "an empty scope did not give the unscoped policy");

    const bad = await core.analyzeTemplate(TEMPLATE, false, { account: "12345" });
    check(bad.error && bad.scope_error, `a bad account was not reported as a scope error: ${JSON.stringify(bad).slice(0, 200)}`);
    const noAccount = await core.analyzeResourceType("AWS::S3::Bucket", false, { region });
    check(noAccount.error && noAccount.scope_error, "a region without an account was not refused");
    console.log(`scoping errors reported: "${bad.error}"`);
  } else {
    console.log(`cfn2iam ${core.version} has no resource scoping (added in 0.4.0): skipping the scoped checks`);
  }

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
