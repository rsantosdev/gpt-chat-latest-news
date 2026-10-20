// No HTML or JavaScript returned by a model is executed.
export function validateUi(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  if (!["bar_chart", "metric_cards", "table", "text"].includes(value.type)) throw new Error("Unsupported UI component.");
  for (const field of ["title", "summary", "unit"]) {
    if (typeof value[field] !== "string") throw new Error(`Missing or invalid ${field}.`);
  }
  if (!Array.isArray(value.items) || value.items.length > 24) throw new Error("Expected at most 24 items.");
  for (const item of value.items) {
    if (!item || typeof item.label !== "string" || typeof item.value !== "number" || !Number.isFinite(item.value)) {
      throw new Error("Each item needs a label and a finite numeric value.");
    }
  }
  return value;
}

export function renderUi(container, ui) {
  validateUi(ui);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const number = value => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}${ui.unit ? " " + ui.unit : ""}`;
  container.replaceChildren(el("span", ui.type.replaceAll("_", " "), "component-label"), el("h3", ui.title), el("p", ui.summary, "summary"));
  container.classList.remove("empty");

  if (ui.type === "text") return;
  if (ui.type === "metric_cards") {
    const grid = el("div", undefined, "metrics");
    ui.items.forEach(item => {
      const card = el("div", undefined, "metric");
      card.append(el("span", item.label), el("strong", number(item.value)));
      grid.append(card);
    });
    container.append(grid);
  } else if (ui.type === "table") {
    const table = el("table");
    const header = el("tr");
    const labelHeading = el("th", "Item");
    const valueHeading = el("th", ui.unit || "Value");
    labelHeading.scope = valueHeading.scope = "col";
    header.append(labelHeading, valueHeading);
    const head = el("thead"); head.append(header); table.append(head);
    const body = el("tbody");
    ui.items.forEach(item => {
      const row = el("tr"); row.append(el("td", item.label), el("td", number(item.value))); body.append(row);
    });
    table.append(body); container.append(table);
  } else {
    const chart = el("div", undefined, "chart");
    const sort = el("button", "Sort by value", "sort");
    sort.type = "button";
    let sorted = false;
    const draw = () => {
      chart.replaceChildren();
      const items = sorted ? [...ui.items].sort((a, b) => b.value - a.value) : ui.items;
      const min = Math.min(0, ...items.map(item => item.value));
      const max = Math.max(0, ...items.map(item => item.value));
      const span = max - min || 1;
      const zero = -min / span * 100;
      items.forEach(item => {
        const row = el("div", undefined, "chart-row");
        const track = el("div", undefined, "track");
        const bar = el("div", undefined, "bar");
        const position = (item.value - min) / span * 100;
        track.style.setProperty("--zero", `${zero}%`);
        bar.style.left = `${Math.min(zero, position)}%`;
        bar.style.width = `${Math.abs(position - zero)}%`;
        bar.title = `${item.label}: ${number(item.value)}`;
        track.append(bar);
        row.append(el("span", item.label, "bar-label"), track, el("strong", number(item.value), "bar-value"));
        chart.append(row);
      });
    };
    sort.addEventListener("click", () => { sorted = !sorted; sort.textContent = sorted ? "Original order" : "Sort by value"; draw(); });
    draw(); container.append(chart, sort);
  }
}
