# GPT-chat-latest: JSON to UI

A small ASP.NET Core 10 app with plain HTML, CSS, and JavaScript. No React,
Vue, npm, agent framework, or extra NuGet packages. One Foundry deployment,
one model request, and an interactive UI next to the model content formatted as JSON.

## Run

Requires the .NET 10 SDK and a Microsoft Foundry resource with a deployed
`gpt-chat-latest` model.

From this directory:

```sh
dotnet user-secrets set "Foundry:Endpoint" "https://YOUR-RESOURCE.openai.azure.com/"
dotnet user-secrets set "Foundry:ApiKey" "YOUR-RESOURCE-KEY"
dotnet user-secrets set "Foundry:Deployment" "YOUR-GPT-CHAT-LATEST-DEPLOYMENT-NAME"
dotnet run
```

Open http://localhost:5080. The endpoint can also be the full
`https://YOUR-RESOURCE.openai.azure.com/openai/v1/` base URL. Use the deployment
name from your resource, which may differ from the catalog model name.

For environment-based configuration, the equivalent names are
`Foundry__Endpoint`, `Foundry__ApiKey`, and `Foundry__Deployment`.
Keep credentials in user secrets or environment variables, not appsettings.json.

## What to show in the video

1. Click **Generate UI** using the sprint prompt. The prompt supplies all data;
   there is no live project-management or weather integration.
2. Show **Model content**. This displays `choices[0].message.content` with
   two-space JSON indentation, with no Markdown stripping, JSON repair, or
   fallback. The green badge appears only after the original content passes
   `JSON.parse`. **Copy JSON** also copies the indented version.
3. Show the chart and click **Sort by value**. The browser renders the component
   chosen in the JSON; the sort runs locally without another model request.
4. Expand **Inspect the API request and full response**. Show the
   `response_format` schema, the full API response formatted as JSON, and the
   upstream HTTP status. Credentials are excluded. The backend preserves the
   original body in `rawResponse`; formatting affects the display only. Embedded
   strings stay strings in the API envelope, with decoded model JSON shown above.
5. Try the metric-card prompt to show a different component using the same code.

### Describe the evidence accurately

The HTTP API envelope is always JSON. The evidence here is that the assistant's
**content also parses as a JSON object** and matches a supported UI shape.
Chat Completions transports that object as serialized JSON in a string field.
It is JSON-formatted content, not a new transport type.

This app explicitly requests Structured Outputs with
`response_format: { type: "json_schema", json_schema: { strict: true, ... } }`.
`ui-schema.json` defines this app's contract; it is not a Microsoft-native GenUI
response schema or a `genui: true` flag. Other models supporting Structured
Outputs can use this pattern too. This demo does not establish that the pattern
is exclusive to the newly announced model. The separate `/interleaved` route
adds a streaming Responses API example described below.

If Foundry rejects the format, the model refuses, or the output is incomplete or
invalid, the original response remains visible and no UI is rendered.
No mock/sample response is substituted by the app.

## Small code path

- `Program.cs`: POST to Foundry's `/openai/v1/chat/completions`, request strict
  JSON Schema output, and preserve the upstream body.
- `ui-schema.json`: component type, title, summary, unit, and numeric items.
- `wwwroot/app.js`: validate the original content with `JSON.parse` and format
  JSON panels with two-space indentation. Invalid JSON stays visible unchanged.
- `wwwroot/ui-renderer.mjs`: render approved bar-chart, metric-card, table, or
  text components. All model strings use `textContent`; no generated code runs.

The API key stays in the backend. The deployment must support Chat Completions
and Structured Outputs and be accessible from your machine.

## Early output + GenUI

Open http://localhost:5080/interleaved, or choose **Early output → UI** in the
navigation. The same endpoint, key, and deployment settings are reused.

This page makes **one** streamed request to `/openai/v1/responses`:

1. It asks the model to share a useful finding early, then finish the analysis.
2. Assistant messages appear immediately from `response.output_text.delta`.
   Actual `commentary` or `final_answer` phase labels are shown when provided.
3. With **Combine with GenUI** checked, the final presentation is a `render_ui`
   function call with strict-schema arguments using the same `ui-schema.json`.
   The completed tool arguments are formatted as JSON and rendered locally
   after `response.completed`. No second model call or external action occurs.
4. Uncheck that option to observe a text-only response instead.

The schema constrains only the tool arguments. This route deliberately avoids
`text.format: json_schema`, which would also constrain natural-language output.
It exposes first-text time, UI-ready time, completion time, and a formatted
timeline of the original service events. **Stop** cancels the request.

### What the interleaved demo proves

The announcement describes visible output before the overall work is complete.
The page supports that pattern, but **a separate early message is not
guaranteed**. The model decides when to produce output. The page never inserts
canned model updates, splits one message into fake stages, or adds delays.

The evidence label recognizes separate assistant messages with a service
`reasoning` item between them, even when phase labels are absent. It also
distinguishes commentary followed by later output from unlabeled text followed
by a tool result or a single streamed message. These observations do not reveal
private reasoning. A token stream alone does not
prove thinking occurred between visible messages. Phase labels describe
assistant output; they are not an enable-interleaved-thinking request parameter.

The tool call is the terminal UI action for this demo; its result is not sent
back for a further model turn. Invalid arguments, errors, refusals, and streams
that end without `response.completed` do not produce a fabricated UI result.

The deployment must support the Responses API and function calling. If the
service rejects the request, the actual error is shown without a fallback to
two separate requests. `InterleavedEndpoint.cs` flushes upstream SSE bytes as
they arrive; `wwwroot/interleaved.js` displays them and reuses the UI renderer.

Live verification on October 20, 2026, using the default sample sales prompt:
first visible text at 3.43 seconds, a `reasoning` output item between assistant
messages, second message at 4.08 seconds, and the UI/response complete at 8.43
seconds. No phase labels were supplied in that run. These are one run's browser
measurements, not a latency guarantee or proof of a model-exclusive capability.

## Verify without credentials

```sh
dotnet build
python3 tests/smoke.py
node tests/sse.mjs
```

The smoke check starts an isolated loopback HTTP stub and this app with fake
credentials. It checks the actual outbound request, response preservation,
refusals, unsupported formats, invalid responses, and static module serving.
It also verifies that an early event crosses the proxy while the upstream
completion is held, plus text-only mode and interrupted/error responses.
It does not verify live Foundry inference. `--serve` keeps that test environment
running for UI inspection; every successful fixture is labeled **TEST FIXTURE**.

## References

- [Microsoft announcement](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/gpt-chat-latest-gets-more-intelligent-interactive-and-personal-in-microsoft-foun/4564574)
- [Microsoft: Structured Outputs, including dynamically generated UI](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs)
- [Microsoft: Chat Completions REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat)
- [OpenAI: Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Microsoft: Responses API streaming](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#streaming)
- [Microsoft: Reasoning and assistant phases](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)
- [OpenAI: Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
