using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;

static class InterleavedEndpoint
{
    public static void MapInterleaved(this WebApplication app, JsonNode schema)
    {
        app.MapGet("/interleaved", () => Results.File(
            Path.Combine(app.Environment.WebRootPath, "interleaved.html"), "text/html"));
        app.MapPost("/api/interleaved", async (InterleavedInput input, HttpContext context,
            IConfiguration config, IHttpClientFactory clients) =>
        {
            if (string.IsNullOrWhiteSpace(input.Prompt) || input.Prompt.Length > 12000)
            {
                await Results.BadRequest(new { error = "Enter a prompt of 1–12,000 characters." }).ExecuteAsync(context);
                return;
            }
            var endpoint = config["Foundry:Endpoint"]?.Trim().TrimEnd('/');
            var key = config["Foundry:ApiKey"];
            var deployment = config["Foundry:Deployment"];
            if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(deployment))
            {
                await Results.BadRequest(new { error = "Configure Foundry endpoint, API key, and deployment. See README.md." }).ExecuteAsync(context);
                return;
            }
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
                || (uri.Scheme != "https" && !(uri.Scheme == "http" && uri.IsLoopback))
                || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0)
            {
                await Results.BadRequest(new { error = "Use an HTTPS Foundry resource endpoint or its /openai/v1/ base URL." }).ExecuteAsync(context);
                return;
            }
            var payload = new JsonObject
            {
                ["model"] = deployment, ["stream"] = true, ["store"] = false,
                ["instructions"] = """
                    Help the user analyze only the data they supplied. Do not invent live facts.
                    When a useful finding is already clear, share it immediately in a short,
                    user-facing assistant update, then continue the remaining analysis.
                    Prefer a concrete finding over a generic 'I am working on it' preamble.
                    Do not expose private chain of thought. Do not add artificial delays.
                    """ + (input.IncludeUi
                    ? "\nAfter your early update, complete the analysis and call render_ui once to present the final result. Use at most 24 numeric items. The tool renders the supplied UI locally and has no external side effects."
                    : "\nAfter an early useful update, deliver your completed analysis in a final assistant message."),
                ["input"] = input.Prompt
            };
            if (input.IncludeUi)
            {
                // Constrain only the UI tool; leave user-facing updates as natural text.
                payload["parallel_tool_calls"] = false;
                payload["tools"] = new JsonArray(new JsonObject
                {
                    ["type"] = "function", ["name"] = "render_ui", ["strict"] = true,
                    ["description"] = "Present the completed analysis as a bar chart, metric cards, table, or text component.",
                    ["parameters"] = schema.DeepClone()
                });
            }
            if (!endpoint.EndsWith("/openai/v1", StringComparison.OrdinalIgnoreCase)) endpoint += "/openai/v1";
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint + "/responses");
            request.Headers.Add("api-key", key);
            request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
            timeout.CancelAfter(TimeSpan.FromSeconds(120));
            try
            {
                using var upstream = await clients.CreateClient("foundry").SendAsync(
                    request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (!upstream.IsSuccessStatusCode || upstream.Content.Headers.ContentType?.MediaType != "text/event-stream")
                {
                    var raw = await upstream.Content.ReadAsStringAsync(timeout.Token);
                    await Results.Json(new
                    {
                        error = "Foundry did not return a successful SSE stream.",
                        httpStatus = (int)upstream.StatusCode, request = payload, rawResponse = raw
                    }, statusCode: upstream.IsSuccessStatusCode ? 502 : (int)upstream.StatusCode).ExecuteAsync(context);
                    return;
                }
                context.Response.ContentType = "text/event-stream";
                context.Response.Headers.CacheControl = "no-cache";
                context.Response.Headers["X-Accel-Buffering"] = "no";
                context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
                // Application metadata is explicitly named; it is never model text.
                await WriteEvent(context, "demo.request", new { deployment, request = payload, httpStatus = (int)upstream.StatusCode }, timeout.Token);
                using var stream = await upstream.Content.ReadAsStreamAsync(timeout.Token);
                var buffer = new byte[4096];
                int read;
                while ((read = await stream.ReadAsync(buffer, timeout.Token)) != 0)
                {
                    await context.Response.Body.WriteAsync(buffer.AsMemory(0, read), timeout.Token);
                    await context.Response.Body.FlushAsync(timeout.Token);
                }
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
            catch (Exception error) when (error is HttpRequestException or IOException or OperationCanceledException)
            {
                var message = error is OperationCanceledException
                    ? "The response exceeded 120 seconds." : "The Foundry connection failed or was interrupted.";
                if (context.Response.HasStarted)
                    await WriteEvent(context, "demo.error", new { error = message }, context.RequestAborted);
                else
                    await Results.Json(new { error = message }, statusCode: 502).ExecuteAsync(context);
            }
        });
    }

    static async Task WriteEvent(HttpContext context, string name, object value, CancellationToken token)
    {
        await context.Response.WriteAsync($"event: {name}\ndata: {JsonSerializer.Serialize(value)}\n\n", token);
        await context.Response.Body.FlushAsync(token);
    }
}

record InterleavedInput(string Prompt, bool IncludeUi = true);
