# cfn2iam: stop deploying CloudFormation with AdministratorAccess

cfn2iam reads a CloudFormation or SAM template and generates the IAM policy the stack needs to deploy, before the stack is deployed.

IAM Access Analyzer can also generate a policy, but it builds it from CloudTrail activity: the role has to deploy with broad permissions first, and you narrow it afterwards. cfn2iam reads the template instead, so you have the policy before the first deploy.

Live at [mrlikl.github.io/cfn2iam](https://mrlikl.github.io/cfn2iam/). The same logic is available as a command-line tool: [GitHub](https://github.com/mrlikl/cfn2iam) and [PyPI](https://pypi.org/project/cfn2iam/).

## Using the page

1. Open the page and wait for the status line under the editor to say it is ready (the first load downloads about 14 MB; see [Scope and limitations](#scope-and-limitations)).
2. Paste a template (JSON or YAML, CloudFormation or SAM) or upload one (`.json`, `.yaml`, `.yml` or `.template`, up to 1 MB).
3. Choose whether to turn on "Allow deletes" (see below), then click "Generate policy".
4. Copy the policy. The "Resources" tab lists the permissions per resource type. "Single resource" mode looks up one resource type, such as `AWS::S3::Bucket`, without a template.

## Scope and limitations

- **Actions, not resources.** Every statement uses `"Resource": "*"`, so the policy is least-privilege on actions only. Resource ARNs mostly do not exist until the stack does. Scoping by account and region is being added to the CLI and will reach the page after that; until then the page always emits `"*"`.
- **Delete-only actions go into an explicit Deny by default.** The policy has an Allow statement for the actions the create, read, update and list handlers need, and a second statement for actions that only the delete handler needs. That second statement is a `Deny` unless "Allow deletes" is on, in which case it is an `Allow`. An explicit Deny overrides an Allow from any other policy attached to the same role, so if the role also has to delete the stack's resources, turn the toggle on. An action that is delete-only for one resource type but needed by another type in the template stays in the Allow statement.
- **Where the permissions come from.** From AWS's published CloudFormation resource schemas: the permissions each schema lists for its create, read, update, list and delete handlers. The policy is only as complete as those schemas. They can be missing permissions for some resource types or configurations, so try the policy on a non-production stack first.
- **Schema freshness.** A GitHub Actions workflow downloads AWS's schemas weekly and opens a pull request when they change (see [Schema updates](#schema-updates)).
- **Unknown or unresolved resource types.** If a resource type has no schema (for example a private or third-party type), or its schema could not be fetched, the page lists the type, shows a warning that the policy is incomplete, and generates the policy for the other types. The CLI can look such types up in your account's CloudFormation registry; the page cannot.
- **Custom resources are skipped:** `Custom::*`, `AWS::CloudFormation::CustomResource` and `AWS::CDK::Metadata`. Anything they need, such as permission to invoke their Lambda function, is not included.
- **First load.** The page downloads the Python runtime (Pyodide, about 14 MB) and the cfn2iam package, and takes a couple of seconds. Browsers cache it afterwards.
- **What leaves your browser.** The template is parsed and analysed in your browser and is never sent to any server. The page does make these requests:
  - `mrlikl.github.io` (this site): the page files, `requirements.txt`, and for each resource type in your template the schema file `backend/schemas/<type>.json` (plus `backend/sam_rules/` files for SAM types). So the site's host can see which resource types were looked up, but not the template, your property values or names.
  - `pypi.org` and `files.pythonhosted.org`: the pinned cfn2iam release.
  - `cdn.jsdelivr.net`: the Pyodide runtime.
  - `fonts.googleapis.com` and `fonts.gstatic.com`: fonts.
  - `www.googletagmanager.com`: Google Analytics (gtag, measurement ID `G-9M3S5VZ6C5`) is loaded on this page, and the site's other pages. The page's code does not pass it the template. What Google Analytics itself collects (page views, and whatever its default measurement settings include) is configured in the Analytics property, not in this repository.

## How it compares

| | cfn2iam | IAM Access Analyzer policy generation | Writing it by hand |
|---|---|---|---|
| When it runs | Before the first deploy | After the role has been used | Before the first deploy |
| What it reads | The template, and AWS's published resource schemas | CloudTrail events for the role, up to 90 days | The documentation for each resource type |
| Prior deploy with broad permissions needed | No | Yes: it can only report what the role has already done | No |
| Resource-level scoping | No: `"Resource": "*"` today | The generated policy contains resource ARN placeholders for actions that support resource-level permissions, which you fill in | Yes, if you write it |
| Gaps | Only as complete as AWS's schemas; custom resources skipped | Does not record `iam:PassRole` or action-level data events; some services give only service-level information, so you add actions yourself | Whatever you miss |
| Effort | Paste a template | Set up a CloudTrail trail and a service role, deploy, then review | Read the docs for every resource type, then iterate on failures |

The Access Analyzer column is from AWS's [IAM Access Analyzer policy generation](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-policy-generation.html) documentation. The cfn2iam column is from this repository and the [cfn2iam](https://github.com/mrlikl/cfn2iam) package. The two tools can be used together: cfn2iam for the starting policy, and Access Analyzer later to check what a role actually used.

## How it works

The page runs the [cfn2iam](https://github.com/mrlikl/cfn2iam) Python package itself, in your browser, so the web tool and the CLI are one implementation and produce the same policy.

1. **Runtime**: `runtime.js` loads [Pyodide](https://pyodide.org/) (a pinned version from cdn.jsdelivr.net) and installs the `cfn2iam` release pinned in `requirements.txt` from PyPI, after checking its SHA-256 (see below). The template never leaves your browser.
2. **Template Analysis**: `cfn2iam.core` parses the template (JSON or YAML, including short-form intrinsics like `!Ref`) and expands SAM resources with the rules in `backend/sam_rules/`
3. **Schema Lookup**: Reads each resource type's schema from `backend/schemas/`, relative to the page
4. **Permission Mapping**: Maps each schema's handler permissions to IAM actions
5. **Policy Generation**: Creates the policy document; `app.js` renders it, the per-resource lists, and a warning for any resource type that couldn't be resolved

`app.js` is only UI. A change to how policies are worked out belongs in the cfn2iam package: release it, and Dependabot opens the pull request that moves the page to it.

## Which cfn2iam release the page runs

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

## Generated policy structure

The policy has up to two statements, both with `"Resource": "*"`:

- **Allow**: the permissions the schemas list for the create, read, update and list handlers.
- **Delete-only**: the permissions only the delete handler needs. `Deny` by default, `Allow` with the "Allow deletes" toggle.

## Schema updates

`.github/workflows/update-cfn-schemas.yml` runs weekly (Sunday 01:00 UTC) and on demand:

- Downloads AWS's published CloudFormation resource schemas
- Processes them for client-side use (`backend/process_schemas.py`)
- Opens a pull request for review; nothing is written if nothing changed
- Maintains a schema index (`backend/schemas/index.json`) for lookups

SAM expansion rules in `backend/sam_rules/` are maintained by hand and are not touched by the workflow.

The CLI reads the same files from https://mrlikl.github.io/cfn2iam/backend.

## Service Authorization Reference (`backend/servicereference/`)

A trimmed copy of AWS's machine-readable [Service Authorization Reference](https://servicereference.us-east-1.amazonaws.com/): for each IAM action, the resource types it supports and their ARN formats. It is the data for resource scoping, which neither the page nor the released CLI uses yet.

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

## Testing an unreleased cfn2iam locally

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
