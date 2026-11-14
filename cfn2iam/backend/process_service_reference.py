#!/usr/bin/env python3
"""
Process the AWS Service Authorization Reference for cfn2iam
Downloads every service file and writes a trimmed, per-service lookup format

Source: https://servicereference.us-east-1.amazonaws.com/ (an index of every
service and the URL of its file). Output: servicereference/<prefix>.json plus
servicereference/index.json. The format is documented in cfn2iam/README.md.

The run is all or nothing: if the index or any service file cannot be fetched or
does not have the expected shape, it exits non-zero and leaves the published
files untouched. Output is deterministic (sorted keys and lists, no timestamps),
so a week with no upstream change produces no diff.

After writing, it prints how many of the IAM actions in schemas/ resolve here.
"""

import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

INDEX_URL = "https://servicereference.us-east-1.amazonaws.com/"
OUTPUT_DIR = Path("servicereference")
SCHEMAS_DIR = Path("schemas")

WORKERS = 16
TIMEOUT = 30  # seconds per request
ATTEMPTS = 4  # per URL, with exponential backoff between them
# Refuse to publish if the index lists far fewer services than are published now:
# a truncated index would otherwise delete most of the folder.
MIN_KEPT_FRACTION = 0.9

SERVICE_PREFIX = re.compile(r"^[a-z0-9][a-z0-9-]*$")


class SourceError(Exception):
    """The source is unreachable or a file does not have the expected shape."""


# --- Download ---------------------------------------------------------------


def fetch_json(url):
    """GET a URL and parse it as JSON, retrying transient failures."""
    request = urllib.request.Request(url, headers={"User-Agent": "cfn2iam-backend-updater"})
    last_error = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(2 ** attempt)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                body = response.read()
            return json.loads(body)
        except urllib.error.HTTPError as e:
            last_error = e
            # A missing or forbidden file will not appear on retry.
            if 400 <= e.code < 500 and e.code not in (408, 429):
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as e:
            # ValueError covers a truncated or garbled body (json.JSONDecodeError).
            last_error = e
    raise SourceError(f"{url}: {last_error}")


# --- Validation and trimming ------------------------------------------------


def _require(condition, where, message):
    if not condition:
        raise SourceError(f"{where}: {message}")


def _str_list(value, where, field):
    """An optional list of strings; absent or null means empty."""
    if value is None:
        return []
    _require(isinstance(value, list) and all(isinstance(v, str) for v in value), where, f"{field} is not a list of strings")
    return value


def parse_index(data):
    """[(prefix, url)] from the source index, sorted by prefix."""
    _require(isinstance(data, list) and data, INDEX_URL, "index is not a non-empty list")
    origin = INDEX_URL.rstrip("/")
    entries = {}
    for entry in data:
        _require(isinstance(entry, dict), INDEX_URL, f"index entry is not an object: {entry!r}")
        prefix, url = entry.get("service"), entry.get("url")
        _require(isinstance(prefix, str) and SERVICE_PREFIX.match(prefix), INDEX_URL, f"bad service prefix {prefix!r}")
        _require(isinstance(url, str) and url.startswith(origin + "/"), INDEX_URL, f"{prefix}: url {url!r} is not under {origin}")
        _require(prefix not in entries, INDEX_URL, f"service {prefix!r} listed twice")
        entries[prefix] = url
    return sorted(entries.items())


def trim_service(prefix, data, warnings):
    """The published form of one service file. Raises SourceError on a bad shape."""
    where = f"{prefix}.json"
    _require(isinstance(data, dict), where, "not an object")
    _require(isinstance(data.get("Name"), str) and data["Name"].lower() == prefix, where, f"Name {data.get('Name')!r} does not match the index")

    resources = {}
    for r in data.get("Resources") or []:
        _require(isinstance(r, dict) and isinstance(r.get("Name"), str) and r["Name"], where, f"resource without a name: {r!r}")
        name = r["Name"]
        _require(name not in resources, where, f"resource {name!r} listed twice")
        arns = _str_list(r.get("ARNFormats"), f"{where} resource {name}", "ARNFormats")
        _require(arns and all(a.startswith("arn:") for a in arns), where, f"resource {name!r} has no ARN format")
        out = {"arnFormats": sorted(set(arns))}
        keys = _str_list(r.get("ConditionKeys"), f"{where} resource {name}", "ConditionKeys")
        if keys:
            out["conditionKeys"] = sorted(set(keys))
        resources[name] = out

    actions = {}
    for a in data.get("Actions") or []:
        _require(isinstance(a, dict) and isinstance(a.get("Name"), str) and a["Name"], where, f"action without a name: {a!r}")
        name = a["Name"]
        key = name.lower()
        _require(key not in actions, where, f"action {name!r} listed twice (names are case-insensitive)")
        out = {"name": name}

        types = []
        resource_keys = {}
        for r in a.get("Resources") or []:
            _require(isinstance(r, dict) and isinstance(r.get("Name"), str), where, f"action {name}: bad resource entry {r!r}")
            if r["Name"] not in resources:
                # Seen upstream (ivs): the action names a resource type the file does not
                # define. Without an ARN format it cannot scope anything, so drop it.
                warnings.append(f"{prefix}:{name} names undefined resource type {r['Name']!r}; dropped")
                continue
            types.append(r["Name"])
            keys = _str_list(r.get("ConditionKeys"), f"{where} action {name}", "ConditionKeys")
            if keys:
                resource_keys[r["Name"]] = sorted(set(keys))
        out["resources"] = sorted(set(types))
        if resource_keys:
            out["resourceConditionKeys"] = resource_keys

        keys = _str_list(a.get("ActionConditionKeys"), f"{where} action {name}", "ActionConditionKeys")
        if keys:
            out["conditionKeys"] = sorted(set(keys))

        props = (a.get("Annotations") or {}).get("Properties") or {}
        _require(isinstance(props, dict), where, f"action {name}: Annotations.Properties is not an object")
        flags = sorted(k for k, v in props.items() if v is True)
        if flags:
            out["flags"] = flags

        actions[key] = out
    _require(actions, where, "no actions")

    condition_keys = {}
    for c in data.get("ConditionKeys") or []:
        _require(isinstance(c, dict) and isinstance(c.get("Name"), str), where, f"bad condition key {c!r}")
        condition_keys[c["Name"]] = sorted(set(_str_list(c.get("Types"), f"{where} condition key {c['Name']}", "Types")))

    service = {
        "service": prefix,
        "serviceName": data.get("ServiceName") or prefix,
        "version": data.get("Version") or "",
        "actions": actions,
        "resources": resources,
    }
    if condition_keys:
        service["conditionKeys"] = condition_keys
    return service


def dumps(data):
    return json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


# --- Build and publish ------------------------------------------------------


def build():
    """{filename: content} for the whole folder, or raise SourceError."""
    print(f"Downloading service index from {INDEX_URL}...")
    entries = parse_index(fetch_json(INDEX_URL))
    print(f"Index lists {len(entries)} services; downloading them...")

    def one(entry):
        prefix, url = entry
        try:
            return prefix, fetch_json(url), None
        except SourceError as e:
            return prefix, None, e

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(one, entries))

    errors = [str(e) for _, _, e in results if e is not None]
    warnings = []
    files = {}
    index = {}
    for prefix, data, error in results:
        if error is not None:
            continue
        try:
            service = trim_service(prefix, data, warnings)
        except SourceError as e:
            errors.append(str(e))
            continue
        filename = f"{prefix}.json"
        files[filename] = dumps(service)
        index[prefix] = {"filename": filename, "serviceName": service["serviceName"]}

    for w in warnings:
        print(f"Warning: {w}")
    if errors:
        raise SourceError(f"{len(errors)} of {len(entries)} services failed:\n  " + "\n  ".join(errors))

    files["index.json"] = dumps({"services": index, "totalServices": len(index)})
    return files


def publish(files):
    """Replace OUTPUT_DIR with exactly `files`, never leaving a partial folder behind."""
    old_index = OUTPUT_DIR / "index.json"
    if old_index.exists():
        published = len(json.loads(old_index.read_text(encoding="utf-8")).get("services", {}))
        if len(files) - 1 < published * MIN_KEPT_FRACTION:
            raise SourceError(f"only {len(files) - 1} services against {published} published; refusing to shrink the folder")

    staging = OUTPUT_DIR.with_name(OUTPUT_DIR.name + ".new")
    retired = OUTPUT_DIR.with_name(OUTPUT_DIR.name + ".old")
    for d in (staging, retired):
        shutil.rmtree(d, ignore_errors=True)
    staging.mkdir()
    for filename, content in files.items():
        (staging / filename).write_text(content, encoding="utf-8")

    if OUTPUT_DIR.exists():
        unchanged = sorted(p.name for p in OUTPUT_DIR.iterdir()) == sorted(files) and all(
            (OUTPUT_DIR / f).read_text(encoding="utf-8") == c for f, c in files.items()
        )
        if unchanged:
            shutil.rmtree(staging)
            print("No changes")
            return
        OUTPUT_DIR.rename(retired)
    staging.rename(OUTPUT_DIR)
    shutil.rmtree(retired, ignore_errors=True)
    print(f"Wrote {len(files) - 1} services and index.json to {OUTPUT_DIR}/")


# --- Coverage against schemas/ ----------------------------------------------


def coverage(files):
    """Print how many actions in the CloudFormation schemas resolve in the reference."""
    if not SCHEMAS_DIR.is_dir():
        return
    services = {f[:-5]: json.loads(c) for f, c in files.items() if f != "index.json"}
    actions = set()
    for path in SCHEMAS_DIR.glob("*.json"):
        if path.name == "index.json":
            continue
        handlers = json.loads(path.read_text(encoding="utf-8")).get("handlers") or {}
        for handler in handlers.values():
            actions.update(p for p in (handler.get("permissions") or []) if isinstance(p, str))

    buckets = {k: [] for k in ("scoped", "unscoped", "wildcard", "malformed", "unknown service", "unknown action")}
    for action in sorted(actions):
        prefix, sep, name = action.partition(":")
        if not sep or not prefix or not name:
            buckets["malformed"].append(action)
        elif "*" in action or "?" in action:
            buckets["wildcard"].append(action)
        elif prefix.lower() not in services:
            buckets["unknown service"].append(action)
        elif name.lower() not in services[prefix.lower()]["actions"]:
            buckets["unknown action"].append(action)
        elif services[prefix.lower()]["actions"][name.lower()]["resources"]:
            buckets["scoped"].append(action)
        else:
            buckets["unscoped"].append(action)

    distinct = len({a.lower() for a in actions})
    print(f"Coverage of {len(actions)} distinct action strings ({distinct} ignoring case) in {SCHEMAS_DIR}/:")
    print(f"  resolve, with resource types:    {len(buckets['scoped'])}")
    print(f"  resolve, no resource types:      {len(buckets['unscoped'])}")
    for reason in ("unknown service", "unknown action", "wildcard", "malformed"):
        items = buckets[reason]
        sample = ", ".join(i or "\"\"" for i in items[:8]) + (", ..." if len(items) > 8 else "")
        print(f"  {reason + ':':<33} {len(items)}" + (f"  ({sample})" if items else ""))


def main():
    sys.stdout.reconfigure(line_buffering=True)  # keep progress and errors in order in CI logs
    try:
        files = build()
        publish(files)
    except SourceError as e:
        print(f"Error: {e}", file=sys.stderr)
        print("Published files left unchanged", file=sys.stderr)
        return 1
    coverage(files)
    return 0


if __name__ == "__main__":
    os.chdir(Path(__file__).resolve().parent)
    sys.exit(main())
