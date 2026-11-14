# CloudFormation to IAM Policy Generator

A client-side web tool that generates minimal IAM policies for CloudFormation stack deployment. Upload or paste your CloudFormation template and get the exact IAM permissions needed for deployment.

## 🚀 How It Works

The page runs the [cfn2iam](https://github.com/mrlikl/cfn2iam) Python package itself, in your browser, so the web tool and the CLI are one implementation and produce the same policy.

1. **Runtime**: `runtime.js` loads [Pyodide](https://pyodide.org/) (a pinned version from cdn.jsdelivr.net) and installs the `cfn2iam` release pinned in `requirements.txt` from PyPI, after checking its SHA-256 (see below). The template never leaves your browser.
2. **Template Analysis**: `cfn2iam.core` parses the template (JSON or YAML, including short-form intrinsics like `!Ref`) and expands SAM resources with the rules in `backend/sam_rules/`
3. **Schema Lookup**: Reads each resource type's schema from `backend/schemas/`, relative to the page
4. **Permission Mapping**: Maps each schema's handler permissions to IAM actions
5. **Policy Generation**: Creates the policy document; `app.js` renders it, the per-resource lists, and a warning for any resource type that couldn't be resolved

`app.js` is only UI. A change to how policies are worked out belongs in the cfn2iam package: release it, and Dependabot opens the pull request that moves the page to it.

## 📌 Which cfn2iam release the page runs

`requirements.txt` (next to the page) pins it, with the SHA-256 of each file of that release:

```
cfn2iam==0.3.0 \
    --hash=sha256:a3422dbb… \
    --hash=sha256:d8af1c15…
```

At startup `runtime.js` reads that file, asks PyPI for that version (`https://pypi.org/pypi/cfn2iam/<version>/json`), downloads the `py3-none-any` wheel whose hash is pinned from files.pythonhosted.org, checks the downloaded bytes against the pin, and installs them with micropip, `deps=False` (PyYAML comes from Pyodide; typer and boto3 are CLI-only and are never installed). It does not use the package index (`/simple/cfn2iam/`): PyPI and the browser cache that for up to 10 minutes, so right after a release it can still list only the older versions, and micropip then fails with "Can't find a pure Python 3 wheel". If PyPI or the CDN can't be reached, or a hash doesn't match, the status line says which and what to do.

**Updating.** Dependabot (`.github/dependabot.yml`, the `/cfn2iam` entry) checks PyPI daily with no cooldown and opens a "Bump cfn2iam from X to Y in /cfn2iam" pull request that changes the version and the hashes. The `Check cfn2iam web runtime` workflow runs on that PR: it installs the pinned release the same way the page does (Pyodide under Node, the same `runtime.js`) and runs a template through `cfn2iam.core` with this folder's `backend/`. Merging the PR is all it takes; nothing else holds the version. To bump by hand, change the version and replace the hashes with the ones PyPI lists for the new release (`pip download cfn2iam==X --no-deps` and `pip hash`, or the release's JSON), then run the check below.

`requirements.txt` is not for `pip install -r`: its dependencies are not pinned, so pip's hash-checking mode would refuse it.

The Pyodide version is `PYODIDE_VERSION` in `runtime.js`; the check workflow reads it from there.

## 📋 Generated Policy Structure

The tool generates policies with two types of permissions:

- **Allow Statements**: Create, Update, Read, List permissions
- **Delete Statements**: Delete-only permissions (Allow or Deny based on user choice)

## 🔄 Schema Updates

CloudFormation schemas are automatically updated weekly via GitHub Actions:

- Downloads latest schemas from AWS
- Processes and optimizes for client-side use
- Creates pull requests for review
- Maintains schema index for quick lookups

The CLI reads the same files from https://mrlikl.github.io/cfn2iam/backend.

## 🔐 Service Authorization Reference (`backend/servicereference/`)

A trimmed copy of AWS's machine-readable [Service Authorization Reference](https://servicereference.us-east-1.amazonaws.com/): for each IAM action, the resource types it supports and their ARN formats. It is the data for resource scoping; nothing reads it yet.

`backend/process_service_reference.py` (standard library only) downloads the index and every service file, and `.github/workflows/update-service-reference.yml` runs it weekly and opens a pull request on the `service-reference-update` branch. A run is all or nothing: if the source is unreachable, any file is malformed, or the index lists under 90% of the services published now, it exits non-zero and leaves the folder as it was. Files have sorted keys and lists and no timestamps, so a PR only appears when AWS changed something. The log, and the PR body, end with how many actions in `backend/schemas/` resolve here.

**Files.** `servicereference/index.json` maps each service prefix to its file. Each service has one file, `servicereference/<prefix>.json`; prefixes are always lowercase (`sqs`, `s3`, `elasticfilesystem`).

```json
{"services": {"sqs": {"filename": "sqs.json", "serviceName": "SQS"}, "...": {}}, "totalServices": 457}
```

A service file (`sqs.json`, shortened):

```json
{
 "service": "sqs",
 "serviceName": "SQS",
 "version": "v1.5",
 "actions": {
  "createqueue": {
   "name": "CreateQueue",
   "resources": ["queue"],
   "conditionKeys": ["aws:RequestTag/${TagKey}", "aws:TagKeys"],
   "flags": ["IsWrite"]
  },
  "listqueues": {"name": "ListQueues", "resources": []}
 },
 "resources": {
  "queue": {
   "arnFormats": ["arn:${Partition}:sqs:${Region}:${Account}:${QueueName}"],
   "conditionKeys": ["aws:ResourceTag/${TagKey}"]
  }
 },
 "conditionKeys": {"aws:TagKeys": ["ArrayOfString"], "...": []}
}
```

- `actions` is keyed by the **lowercased** action name; `name` keeps AWS's spelling. `resources` is always present: the resource types the action can be scoped to, as keys into the same file's `resources`. An empty list means the action has no resource-level permissions and must stay on `"Resource": "*"`. The source does not say which listed types are required, so scope to all of them (for example `ec2:RunInstances` lists 18).
- Optional on an action, omitted when empty: `conditionKeys` (the action's own condition keys), `resourceConditionKeys` (`{resource type: [keys]}`, keys that apply only to this action on that type, mostly in ec2), and `flags`, the annotations that are true, from `IsWrite`, `IsList`, `IsPermissionManagement`, `IsTaggingOnly` and `IsDataPlane`. A read-only action has none of the first four.
- `resources` is keyed by AWS's resource type name, case kept (`function alias`, `ApiKeys`). `arnFormats` usually has one entry; 13 types have two (API Gateway's REST and HTTP API paths, lex, greengrass), and either may be the right one. `conditionKeys` on a resource is optional.
- `conditionKeys` at the top is optional: every condition key the service defines, with its types.

**Looking up an action** such as `s3:getObject` (CloudFormation schemas are inconsistent about case):

1. Split on the first `:` and lowercase both halves: `s3`, `getobject`.
2. Fetch `servicereference/index.json` once; if the prefix is not in `services`, the action is unknown. Otherwise fetch that `filename` (once per service per run).
3. `actions["getobject"]`; if missing, the action is unknown. Treat both unknown cases like an empty `resources`: keep `"Resource": "*"`.
4. For each name in `resources`, take `resources[name]["arnFormats"]`.

A pattern such as `ec2:Describe*` or `s3:*` is not a key; match it against the lowercased keys with `fnmatch` if you need its actions, or leave it on `"Resource": "*"`. Prefixes the schemas use that AWS does not (`efs` for `elasticfilesystem`, `emr` for `elasticmapreduce`, `stepfunctions` for `states`) are not aliased.

**Filling an ARN format.** Placeholders are `${Name}`. Fill `${Partition}`, `${Region}` and `${Account}` and replace every other placeholder with `*`. Some formats differ: the region or account field may be empty (`arn:${Partition}:iam::${Account}:role/${RoleNameWithPath}`, `arn:${Partition}:s3:::${BucketName}`) or literal (`aws` for AWS-owned resources, `*`, one `us-west-2`), and about 20 formats name the account `${AccountId}` or something more specific (`${ManagementAccountId}`). The service field is not always the file's prefix (`sts.json` holds `arn:${Partition}:iam::${Account}:role/...`), and is once `${Vendor}`. Leave literals as they are.

On the data of 14 Nov 2026, of the 9,033 distinct actions (ignoring case) in `backend/schemas/`, 6,798 resolve with resource types, 2,005 resolve with none, and 230 do not resolve: 111 unknown actions, 87 unknown prefixes, 31 wildcards and one empty string.

## 🧪 Testing an unreleased cfn2iam locally

Build a wheel in the cfn2iam repo, copy it into `cfn2iam/dev-wheels/` here (gitignored), serve this repo, and point the page at it with `?wheel=`:

```bash
# in the cfn2iam repo (the version normally comes from the git tag)
SETUPTOOLS_SCM_PRETEND_VERSION=0.3.0 uv build
cp dist/cfn2iam-0.3.0-py3-none-any.whl ../mrlikl.github.io/cfn2iam/dev-wheels/

# in this repo
python3 -m http.server 3000
# open http://localhost:3000/cfn2iam/?wheel=dev-wheels/cfn2iam-0.3.0-py3-none-any.whl
```

`?wheel=` only accepts a wheel served by the same site, because installing it runs its code in the page; it skips `requirements.txt` and the hash check. The status line under the template shows which cfn2iam version is running and, with `?wheel=`, which file.

Without `?wheel=`, the same local server runs the production path: the release pinned in `requirements.txt`, from PyPI. Serve over `http://localhost` (or https), not a LAN address: checking the hash needs a secure context.

To run the CI check locally (Node 24):

```bash
npm install --no-save --prefix /tmp/pyodide pyodide@$(node --input-type=module -e 'console.log((await import("./cfn2iam/runtime.js")).PYODIDE_VERSION)')
node .github/scripts/check-cfn2iam.mjs /tmp/pyodide/node_modules/pyodide
```

## 🚦 Getting Started

1. Visit the tool at [https://mrlikl.github.io/cfn2iam/](https://mrlikl.github.io/cfn2iam/)
2. Upload a CloudFormation template or paste content
3. Click "Generate IAM Policy"

The first visit downloads the Python runtime (about 14 MB from the CDN, cached by the browser afterwards).
