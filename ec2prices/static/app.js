// ec2prices: load data/ (index, instance specs, one price file per region) and render the table.
(function () {
  // Price shown in the region columns: per hour, or divided by the instance's vCPUs or GiB.
  const DIVISORS = {
    hour: () => 1,
    vcpu: (row) => row.vcpu,
    gib: (row) => row.memory_gib,
  };
  let unit = "hour";

  loadData()
    .then(init)
    .catch((error) => {
      document.querySelector(".loading-cell").textContent = `Couldn't load prices (${error.message}).`;
    });

  async function loadData() {
    const index = await getJSON("data/index.json");
    const [instances, ...regionPrices] = await Promise.all([
      getJSON("data/instances.json"),
      ...index.regions.map((region) => getJSON(`data/prices/${region}.json`)),
    ]);
    return { index, instances, regionPrices };
  }

  async function getJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  function init({ index, instances, regionPrices }) {
    const data = { regions: index.regions };
    document.getElementById("last-updated").textContent = formatDate(index.updated);

    const rows = Object.entries(instances.instances).map(([type, values]) => {
      const row = { type, prices: {} };
      instances.fields.forEach((field, i) => (row[field] = values[i]));
      regionPrices.forEach((file) => {
        if (file.prices[type] != null) row.prices[file.region] = file.prices[type];
      });
      const prices = Object.values(row.prices);
      row.min = prices.length ? Math.min(...prices) : null;
      return row;
    });

    const categorySelect = document.getElementById("category");
    [...new Set(rows.map((r) => r.category).filter(Boolean))]
      .sort()
      .forEach((c) => categorySelect.add(new Option(c, c)));

    document.getElementById("table-head").innerHTML = ["Instance type", "vCPU", "Memory (GiB)", "Arch", ...data.regions]
      .map((h) => `<th>${escapeHTML(h)}</th>`)
      .join("");
    document.querySelector("#pricing-table tbody").innerHTML = "";

    const regionColumns = data.regions.map((region) => ({
      data: null,
      searchable: false,
      render: (row, type) => {
        const value = priceFor(row, region);
        if (type === "display") return value == null ? '<span class="na">–</span>' : value.toFixed(4);
        if (type === "sort" || type === "type") return value == null ? Number.MAX_VALUE : value;
        return value == null ? "" : value;
      },
      // The cheapest region is the same whichever unit is shown, so mark it once.
      createdCell: (td, _cell, row) => {
        if (row.prices[region] === row.min) td.classList.add("min-price");
      },
    }));

    const table = new DataTable("#pricing-table", {
      data: rows,
      deferRender: true,
      pageLength: 25,
      lengthMenu: [
        [10, 25, 50, 100, -1],
        [10, 25, 50, 100, "All"],
      ],
      order: [[0, "asc"]],
      language: {
        search: "",
        searchPlaceholder: "Filter, e.g. m7g or Graviton4",
        lengthMenu: "_MENU_ per page",
        zeroRecords: "No instance types match",
      },
      columns: [
        {
          data: "type",
          render: (type, renderType, row) => {
            if (renderType === "display") {
              return `<span class="itype" title="${escapeHTML(details(row))}">${escapeHTML(type)}</span>`;
            }
            if (renderType === "filter") return `${type} ${row.processor || ""} ${row.category || ""}`;
            // Family first, then size by vCPU: m7g.medium, m7g.large, ... m7g.16xlarge
            if (renderType === "sort") return `${type.split(".")[0]}|${String(row.vcpu || 0).padStart(4, "0")}|${type}`;
            return type;
          },
        },
        { data: "vcpu", searchable: false, render: numberCell },
        { data: "memory_gib", searchable: false, render: numberCell },
        { data: "arch", searchable: false, render: (arch) => (arch === "arm64" ? "Arm" : "x86") },
        ...regionColumns,
      ],
    });

    DataTable.ext.search.push((settings, _searchData, _index, row) => {
      if (settings.nTable.id !== "pricing-table") return true;
      const arch = document.getElementById("arch").value;
      const category = categorySelect.value;
      const currentOnly = document.getElementById("currentGen").checked;
      return (!arch || row.arch === arch) && (!category || row.category === category) && (!currentOnly || row.current_gen);
    });

    ["arch", "category", "currentGen"].forEach((id) =>
      document.getElementById(id).addEventListener("change", () => table.draw())
    );

    document.querySelectorAll(".seg").forEach((button) => {
      button.addEventListener("click", () => {
        unit = button.dataset.unit;
        document.querySelectorAll(".seg").forEach((b) => b.classList.toggle("active", b === button));
        table.rows().invalidate("data").draw(false);
      });
    });

    table.draw();
  }

  function priceFor(row, region) {
    const price = row.prices[region];
    if (price == null) return null;
    const divisor = DIVISORS[unit](row);
    return divisor ? price / divisor : null;
  }

  function numberCell(value, type) {
    if (value == null) return type === "display" ? '<span class="na">–</span>' : type === "sort" ? -1 : "";
    return value;
  }

  function details(row) {
    const gpus = row.gpus
      ? `${row.gpus} GPU${row.gpus > 1 ? "s" : ""}${row.gpu_memory_gib ? ` (${row.gpu_memory_gib} GiB)` : ""}`
      : null;
    return [row.category, row.processor, row.clock, row.network, row.storage, gpus].filter(Boolean).join(" · ");
  }

  // "2026-10-10T18:20:05Z" -> "2026-10-10 18:20 UTC"
  function formatDate(iso) {
    return iso ? iso.replace("T", " ").replace(/:\d{2}Z$/, " UTC") : "unknown";
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
})();
