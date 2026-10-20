import { readSse } from "/sse.mjs";
import { validateUi, renderUi } from "/ui-renderer.mjs";

const $ = id => document.getElementById(id);
const pretty = value => JSON.stringify(value, null, 2);
let controller, uiJson = "";

try {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("Could not load configuration.");
  const config = await response.json();
  $("deployment").textContent = config.deployment || "Deployment not configured";
  $("status").textContent = config.configured
    ? "Ready. Early messages are model-dependent; actual events will be shown."
    : "Configure Foundry credentials using the README, then restart the app.";
} catch (error) { $("status").textContent = error.message; }

$("stop").addEventListener("click", () => controller?.abort());
$("copy-json").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(uiJson); $("status").textContent = "Formatted UI JSON copied."; }
  catch { $("status").textContent = "Clipboard unavailable. Select and copy the UI JSON directly."; }
});

$("stream-form").addEventListener("submit", async event => {
  event.preventDefault();
  controller = new AbortController();
  const signal = controller.signal;
  const includeUi = $("include-ui").checked;
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const seconds = ms => `${(ms / 1000).toFixed(2)} s`;
  const entries = new Map();
  let completed = false, firstTextAt = null;
  uiJson = "";
  $("generate").disabled = true; $("stop").disabled = false; $("copy-json").disabled = true;
  for (const id of ["first-text", "ui-time", "total-time"]) $(id).textContent = "—";
  $("messages").replaceChildren(); $("event-log").textContent = "";
  $("ui-json").textContent = "No completed UI arguments yet.";
  $("request-json").textContent = "Waiting for connection…";
  $("preview").classList.add("empty");
  $("preview").textContent = includeUi ? "Waiting for a completed response with valid UI arguments." : "GenUI is disabled for this request.";
  $("status").textContent = "Connecting to Foundry…";
  $("evidence").textContent = "Waiting for actual model output. No intermediate message is simulated.";

  function getEntry(index, item = {}) {
    if (!entries.has(index)) entries.set(index, { index, item: {}, parts: new Map(), arguments: "", firstTextAt: null });
    const entry = entries.get(index);
    entry.item = { ...entry.item, ...item };
    if (Array.isArray(item.content)) {
      entry.parts = new Map(item.content.map((part, i) => [i, part.text ?? part.refusal ?? ""]));
    }
    if (typeof item.arguments === "string") entry.arguments = item.arguments;
    return entry;
  }

  function showMessage(entry) {
    const text = [...entry.parts].sort(([a], [b]) => a - b).map(([, part]) => part).join("");
    if (text && entry.firstTextAt === null) {
      entry.firstTextAt = elapsed();
      if (firstTextAt === null) { firstTextAt = entry.firstTextAt; $("first-text").textContent = seconds(firstTextAt); }
    }
    if (!entry.node) {
      entry.node = document.createElement("article"); entry.node.className = "live-message";
      entry.label = document.createElement("div"); entry.label.className = "message-label";
      entry.textNode = document.createElement("div"); entry.textNode.className = "message-text";
      entry.node.append(entry.label, entry.textNode); $("messages").append(entry.node);
    }
    entry.label.textContent = `Output ${entry.index + 1} · ${entry.item.phase || "phase not provided"}${entry.firstTextAt !== null ? " · " + seconds(entry.firstTextAt) : ""}`;
    entry.textNode.textContent = text;
  }

  function observeItem(index, item) {
    const entry = getEntry(index, item);
    if (entry.item.type === "message") showMessage(entry);
    if (entry.item.type === "reasoning" && !entry.node) {
      entry.node = document.createElement("div");
      entry.node.className = "reasoning-marker";
      entry.node.textContent = `Service reasoning item · ${seconds(elapsed())} · metadata only`;
      $("messages").append(entry.node);
    }
    return entry;
  }

  function complete(response) {
    if (response.status && response.status !== "completed") throw new Error(`Response status: ${response.status}. No UI rendered.`);
    for (const [index, item] of (response.output || []).entries()) observeItem(index, item);
    // This page executes the terminal display tool locally, with no follow-up
    // model request. Only render after the overall response has completed.
    if (includeUi) {
      const calls = [...entries.values()].filter(entry => entry.item.type === "function_call" && entry.item.name === "render_ui");
      if (calls.length !== 1) {
        $("preview").textContent = "The model did not return exactly one render_ui call. Inspect its messages and events.";
      } else {
        const ui = JSON.parse(calls[0].arguments);
        validateUi(ui); uiJson = pretty(ui);
        $("ui-json").textContent = uiJson;
        renderUi($("preview"), ui);
        $("copy-json").disabled = false; $("ui-time").textContent = seconds(elapsed());
      }
    }
    const visible = [...entries.values()].filter(entry => entry.firstTextAt !== null);
    const commentary = visible.find(entry => entry.item.phase === "commentary");
    const laterOutput = commentary && [...entries.values()].some(entry => entry.index > commentary.index &&
      (entry.firstTextAt !== null || entry.item.type === "function_call"));
    const reasoningBetweenMessages = [...entries.values()].some(entry => entry.item.type === "reasoning" &&
      visible.some(message => message.index < entry.index) && visible.some(message => message.index > entry.index));
    if (reasoningBetweenMessages) {
      $("evidence").textContent = "Observed: early assistant message → reasoning item → later assistant message. These are separate service output items; private reasoning was not exposed.";
    } else if (laterOutput) {
      $("evidence").textContent = "Observed: a commentary message followed by later model output. The service supplied the phase label; hidden reasoning is not visible.";
    } else if (visible.length && uiJson) {
      $("evidence").textContent = "Observed: model text before a UI tool result. A separate commentary phase was not confirmed. This does not establish hidden reasoning between them.";
    } else if (visible.length > 1) {
      $("evidence").textContent = "Observed: multiple visible messages. No commentary-plus-later-output sequence was confirmed from phase labels.";
    } else {
      $("evidence").textContent = "No separate intermediate message was observed. Streaming a single response is not evidence of interleaved thinking.";
    }
    $("total-time").textContent = seconds(elapsed());
    $("status").textContent = includeUi && !uiJson ? "Response completed without a usable GenUI result." : "Response completed. Inspect the actual phases and event timeline below.";
    completed = true;
  }

  try {
    const response = await fetch("/api/interleaved", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ prompt: $("prompt").value, includeUi })
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const raw = await response.text();
      let error;
      try { error = JSON.parse(raw); } catch { error = { rawResponse: raw }; }
      if (error.request) $("request-json").textContent = pretty(error.request);
      $("event-log").textContent = pretty(error);
      throw new Error(error.error || `HTTP ${response.status}: no event stream returned.`);
    }
    $("status").textContent = "Receiving service events…";
    for await (const frame of readSse(response.body)) {
      if (frame.data === "[DONE]") continue;
      let data;
      try { data = JSON.parse(frame.data); }
      catch {
        $("event-log").append(document.createTextNode(pretty({ atMs: Math.round(elapsed()), event: frame.event, unparsedData: frame.data }) + "\n\n"));
        throw new Error("A service event contained invalid JSON. The stream could not be validated.");
      }
      const type = data.type || frame.event;
      $("event-log").append(document.createTextNode(pretty({ atMs: Math.round(elapsed()), source: type.startsWith("demo.") ? "application" : "Foundry", event: type, data }) + "\n\n"));
      if (type === "demo.request") {
        $("request-json").textContent = pretty(data.request); $("deployment").textContent = data.deployment;
      } else if (type === "demo.error" || type === "error") {
        throw new Error(data.error?.message || data.error || data.message || "The service reported an error.");
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        observeItem(data.output_index, data.item);
      } else if (type === "response.output_text.delta" || type === "response.refusal.delta") {
        const entry = getEntry(data.output_index, { type: "message" });
        entry.parts.set(data.content_index, (entry.parts.get(data.content_index) || "") + data.delta);
        showMessage(entry);
      } else if (type === "response.output_text.done" || type === "response.refusal.done") {
        const entry = getEntry(data.output_index, { type: "message" });
        entry.parts.set(data.content_index, data.text ?? data.refusal ?? ""); showMessage(entry);
      } else if (type === "response.function_call_arguments.delta") {
        getEntry(data.output_index).arguments += data.delta;
      } else if (type === "response.function_call_arguments.done") {
        const entry = getEntry(data.output_index);
        entry.arguments = data.arguments;
        try { $("ui-json").textContent = pretty(JSON.parse(entry.arguments)); }
        catch { $("ui-json").textContent = entry.arguments; }
      } else if (type === "response.completed") {
        complete(data.response);
      } else if (type === "response.failed" || type === "response.incomplete") {
        throw new Error(data.response?.error?.message || `Service returned ${type}. No UI rendered.`);
      }
    }
    if (!completed) throw new Error("Stream ended without response.completed. Partial text is retained; no UI was rendered.");
  } catch (error) {
    $("status").textContent = signal.aborted ? "Stopped. Partial output is retained." : error.message;
    if (!completed) $("evidence").textContent = "This response did not complete; no conclusion about interleaved output was made.";
  } finally {
    controller.abort(); controller = null;
    $("generate").disabled = false; $("stop").disabled = true;
  }
});
