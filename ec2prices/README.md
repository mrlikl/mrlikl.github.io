# ec2prices

EC2 Linux on-demand prices for every instance type across regions, with vCPU, memory and architecture, and the cheapest region highlighted. Prices can be shown per hour, per vCPU or per GiB.

Live at [mrlikl.github.io/ec2prices](https://mrlikl.github.io/ec2prices).

## How it works

- `source/data.py` downloads each region's EC2 offer file from the [AWS Price List API](https://aws.amazon.com/blogs/aws/new-aws-price-list-api/), keeps shared-tenancy Linux on-demand instances with no licence or pre-installed software, and writes the files in `data/`.
- `index.html` and `static/app.js` load those files and render the table with DataTables.
- The [Update EC2 Pricing Data](../.github/workflows/update-pricing.yml) workflow runs weekly and opens a PR when prices or specs change. If nothing changed, nothing is written and no PR is opened.

## Data

`data/` is free to use. Each file has one entry per line, so diffs show exactly what changed, and a file is only rewritten when its content changes:

| File | Contents |
|---|---|
| `data/index.json` | Regions, and the date each file last changed |
| `data/instances.json` | Specs per instance type, as rows in the order of its `fields` list: category, vCPU, memory (GiB), arch, processor, clock, network, storage, GPUs, GPU memory (GiB), current generation |
| `data/prices/<region>.json` | Hourly USD price per instance type in that region |

`arch` is derived from the processor name (Graviton means `arm64`).

## Run locally

```bash
cd ec2prices/source
pip install -r requirements.txt
python3 data.py        # caches the offer files in source/master/
cd .. && python3 -m http.server   # then open http://localhost:8000
```

To add a region, add it to `REGIONS` in `data.py`.
