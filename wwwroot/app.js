import { validateUi, renderUi } from "/ui-renderer.mjs";

const $ = id => document.getElementById(id);
function formatJson(value) {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; } // Keep invalid JSON and plain-text errors visible.
}

const presets = {
  sprint: "Show our sprint progress as an interactive bar chart. Use this sample data only: planned = 40 story points, completed = 32 story points, remaining = 8 story points.",
  sales: "Compare sales by region using a horizontal bar chart. Use this sample data only: Americas = 42000 USD, Europe = 31000 USD, APAC = 27000 USD. Summarize the main insight.",
  metrics: "Show three metric cards for our product launch. Use this sample data only: signups = 1250, active users = 840, paid users = 190. Use 'users' as the unit."
};
let currentContent = "";
document.querySelectorAll("[data-preset]").forEach(button => {
  button.addEventListener("click", () => { $("prompt").value = presets[button.dataset.preset]; });
});

try {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Could not load configuration.");
  const config = await response.json();
  $("deployment").textContent = config.deployment || "Deployment not configured";
  $("status").textContent = config.configured
    ? "Ready. The response will come from your configured Foundry deployment."
    : "Set Foundry:Endpoint and Foundry:ApiKey with dotnet user-secrets, then restart. See README.md.";
} catch (error) { $("status").textContent = error.message; }

$("generate-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("generate").disabled = true;
  $("copy-json").disabled = true;
  currentContent = "";
  $("status").textContent = "Waiting for GPT-chat-latest…";
  $("json-status").textContent = "Generating…";
  $("json-status").className = "";
  $("timing").textContent = "";
  $("http-status").textContent = "";
  $("model-json").textContent = "Waiting for the model…";
  $("request-json").textContent = "Waiting for response…";
  $("response-json").textContent = "Waiting for response…";
  $("preview").classList.add("empty");
  $("preview").textContent = "The model is choosing a component and generating its JSON…";
  try {
    const response = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: $("prompt").value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The request failed.");

    $("request-json").textContent = formatJson(result.request);
    $("response-json").textContent = formatJson(result.rawResponse);
    $("http-status").textContent = `HTTP ${result.httpStatus}`;
    $("timing").textContent = `${(result.elapsedMs / 1000).toFixed(2)} s`;
    $("deployment").textContent = result.deployment;
    currentContent = result.content ?? "";
    // Format the display only. Validate the original content without repairing it.
    $("model-json").textContent = formatJson(currentContent) || result.refusal || "No assistant content returned.";
    if (result.httpStatus < 200 || result.httpStatus >= 300) throw new Error(`Foundry returned HTTP ${result.httpStatus}. Open the full API response for details.`);
    if (result.parseError) throw new Error(result.parseError);
    if (result.refusal) throw new Error(`The model refused this request: ${result.refusal}`);
    if (result.finishReason !== "stop") throw new Error(`Response did not finish normally (${result.finishReason ?? "unknown"}). Inspect the API response.`);
    let ui;
    try { ui = JSON.parse(currentContent); }
    catch { throw new Error("The assistant content is not valid JSON. Its original content is displayed unchanged."); }
    $("json-status").textContent = "✓ Valid JSON · message.content";
    $("json-status").className = "valid";
    $("copy-json").disabled = false;
    try { validateUi(ui); }
    catch (error) { throw new Error(`Valid JSON, but it does not match the supported UI contract: ${error.message}`); }
    renderUi($("preview"), ui);
    $("status").textContent = ui.type === "bar_chart"
      ? "JSON validated and rendered. Hover over a bar or change its sort order to interact."
      : "JSON validated and rendered from the assistant's original content.";
  } catch (error) {
    $("status").textContent = error.message;
    if (!$("json-status").classList.contains("valid")) $("json-status").textContent = "Response could not be validated";
    $("preview").textContent = "No UI rendered. Inspect the original response for details.";
  } finally { $("generate").disabled = false; }
});

$("copy-json").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(formatJson(currentContent));
    $("copy-json").textContent = "Copied";
    setTimeout(() => { $("copy-json").textContent = "Copy JSON"; }, 1500);
  } catch { $("status").textContent = "Clipboard unavailable. Select and copy the model content directly."; }
});
