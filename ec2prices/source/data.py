"""Fetch EC2 Linux on-demand prices and instance specs from the AWS Price List API.

Writes ../data/:
  instances.json         specs for every instance type, one line each
  prices/<region>.json   hourly USD price per instance type, one line each
  index.json             regions, plus the date each file last changed

A file is only rewritten when its content changes, so its date (and the weekly PR)
reflect real changes, and a price change in one region only touches that region's file.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

# us-east-1 first: when specs differ slightly between regions, its values win.
REGIONS = [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "eu-central-1",
    "eu-west-1",
    "ca-central-1",
]

BASE_URL = "https://pricing.us-east-1.amazonaws.com"
SOURCE = "AWS Price List API"
HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / "master"  # downloaded offer files, gitignored
DATA_DIR = HERE.parent / "data"

# Shared-tenancy Linux on-demand instances, no licence or pre-installed software.
INSTANCE_FILTER = {
    "operatingSystem": "Linux",
    "tenancy": "Shared",
    "preInstalledSw": "NA",
    "licenseModel": "No License required",
    "capacitystatus": "Used",
    "marketoption": "OnDemand",
    "operation": "RunInstances",
}

# Order of the values in each instances.json row.
FIELDS = [
    "category",
    "vcpu",
    "memory_gib",
    "arch",
    "processor",
    "clock",
    "network",
    "storage",
    "gpus",
    "gpu_memory_gib",
    "current_gen",
]


def region_offer_urls():
    """Return {region: (url, version)} for the current EC2 offer files."""
    index = requests.get(f"{BASE_URL}/offers/v1.0/aws/index.json", timeout=60).json()
    region_index_url = index["offers"]["AmazonEC2"]["currentRegionIndexUrl"]
    regions = requests.get(BASE_URL + region_index_url, timeout=60).json()["regions"]
    urls = {}
    for region in REGIONS:
        path = regions[region]["currentVersionUrl"]
        urls[region] = (BASE_URL + path, path.split("/")[5])
    return urls


def download(region, url, version):
    """Download a region's offer file, reusing a cached copy of the same version."""
    CACHE_DIR.mkdir(exist_ok=True)
    path = CACHE_DIR / f"{region}-{version}.json"
    if path.exists():
        print(f"{region}: using cached {path.name}")
        return path
    for stale in CACHE_DIR.glob(f"{region}-*.json"):
        stale.unlink()
    print(f"{region}: downloading {url}")
    tmp = path.with_suffix(".part")
    with requests.get(url, stream=True, timeout=300) as response:
        response.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in response.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    tmp.rename(path)
    return path


def hourly_price(terms):
    for term in terms.values():
        for dimension in term["priceDimensions"].values():
            if dimension.get("unit") == "Hrs":
                price = float(dimension["pricePerUnit"]["USD"])
                if price > 0:
                    return price
    return None


def number(text):
    """'8 GiB' -> 8, '0.613 GiB' -> 0.613, 'NA' -> None."""
    match = re.search(r"[\d.]+", (text or "").replace(",", ""))
    if not match:
        return None
    value = float(match.group())
    return int(value) if value.is_integer() else value


def specs_from(attributes):
    """Instance specs as a row, in FIELDS order."""
    processor = attributes.get("physicalProcessor", "")
    clock = attributes.get("clockSpeed")
    return [
        attributes.get("instanceFamily"),
        number(attributes.get("vcpu")),
        number(attributes.get("memory")),
        "arm64" if "Graviton" in processor else "x86_64",
        processor or None,
        clock if clock not in (None, "NA") else None,
        attributes.get("networkPerformance"),
        attributes.get("storage"),
        number(attributes.get("gpu")) or 0,
        number(attributes.get("gpuMemory")),
        attributes.get("currentGeneration") == "Yes",
    ]


def extract(path):
    """Return {instance_type: (specs_row, hourly_price)} from one region's offer file."""
    with open(path) as f:
        offer = json.load(f)
    on_demand = offer["terms"]["OnDemand"]
    found = {}
    for sku, product in offer["products"].items():
        if not product.get("productFamily", "").startswith("Compute Instance"):
            continue
        attributes = product["attributes"]
        if any(attributes.get(key) != value for key, value in INSTANCE_FILTER.items()):
            continue
        price = hourly_price(on_demand.get(sku, {}))
        if price is not None:
            found[attributes["instanceType"]] = (specs_from(attributes), price)
    return found


def write_if_changed(path, header, body_key, body, now):
    """Write `header` fields plus a `body` dict with one entry per line.

    Returns the file's date: unchanged if the content is the same as on disk, else `now`.
    """
    if path.exists():
        old_date = json.loads(path.read_text()).get("updated")
        if path.read_text() == render({**header, body_key: body, "updated": old_date}, body_key):
            return old_date

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render({**header, body_key: body, "updated": now}, body_key))
    print(f"Wrote {path.relative_to(DATA_DIR.parent)} ({len(body)} entries)")
    return now


def render(document, body_key):
    """Sorted-key JSON, with the `body_key` dict written one entry per line for small diffs."""
    lines = ["{"]
    keys = sorted(document)
    for n, key in enumerate(keys):
        end = "" if n == len(keys) - 1 else ","
        if key == body_key:
            lines.append(f"  {json.dumps(key)}: {{")
            items = sorted(document[key].items())
            for i, (name, value) in enumerate(items):
                comma = "," if i < len(items) - 1 else ""
                lines.append(f"    {json.dumps(name)}: {json.dumps(value, sort_keys=True)}{comma}")
            lines.append("  }" + end)
        else:
            lines.append(f"  {json.dumps(key)}: {json.dumps(document[key], sort_keys=True)}{end}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main():
    urls = region_offer_urls()
    specs = {}
    prices = {}
    for region in REGIONS:
        found = extract(download(region, *urls[region]))
        print(f"{region}: {len(found)} instance types")
        prices[region] = {}
        for instance_type, (row, price) in found.items():
            specs.setdefault(instance_type, row)
            prices[region][instance_type] = price

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    regions = sorted(REGIONS)
    files = {
        "instances.json": write_if_changed(
            DATA_DIR / "instances.json",
            {"fields": FIELDS},
            "instances",
            dict(sorted(specs.items())),
            now,
        )
    }
    for region in regions:
        files[f"prices/{region}.json"] = write_if_changed(
            DATA_DIR / "prices" / f"{region}.json",
            {"region": region},
            "prices",
            dict(sorted(prices[region].items())),
            now,
        )

    updated = max(files.values())
    index_path = DATA_DIR / "index.json"
    index = {"updated": updated, "source": SOURCE, "regions": regions, "files": files}
    text = json.dumps(index, indent=2, sort_keys=True) + "\n"
    if not index_path.exists() or index_path.read_text() != text:
        index_path.write_text(text)
        print(f"Wrote data/index.json (updated {updated})")
    else:
        print(f"No changes; data stays as of {updated}")


if __name__ == "__main__":
    main()
