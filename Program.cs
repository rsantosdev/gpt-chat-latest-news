using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("foundry", client => client.Timeout = TimeSpan.FromSeconds(120));
var app = builder.Build();
var schema = JsonNode.Parse(File.ReadAllText(Path.Combine(app.Environment.ContentRootPath, "ui-schema.json")))!;

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/config", (IConfiguration config) => new
{
    configured = !string.IsNullOrWhiteSpace(config["Foundry:Endpoint"])
        && !string.IsNullOrWhiteSpace(config["Foundry:ApiKey"]),
    deployment = config["Foundry:Deployment"]
});
app.MapGet("/api/schema", () => Results.Json(schema));
app.MapInterleaved(schema);

app.MapPost("/api/generate", async (GenerateInput input, IConfiguration config,
    IHttpClientFactory clients, CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(input.Prompt) || input.Prompt.Length > 12000)
        return Results.BadRequest(new { error = "Enter a prompt of 1–12,000 characters." });

    var deployment = config["Foundry:Deployment"];
    var apiKey = config["Foundry:ApiKey"];
    var endpoint = config["Foundry:Endpoint"]?.Trim().TrimEnd('/');
    if (string.IsNullOrWhiteSpace(endpoint) || string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(deployment))
        return Results.BadRequest(new { error = "Configure Foundry endpoint, API key, and deployment name. See README.md." });
    if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var resource)
        || (resource.Scheme != "https" && !(resource.Scheme == "http" && resource.IsLoopback))
        || resource.Query.Length != 0 || resource.Fragment.Length != 0 || resource.UserInfo.Length != 0)
        return Results.BadRequest(new { error = "Use an HTTPS Foundry resource endpoint or its /openai/v1/ base URL." });

    // An application-defined UI contract, not a model-specific GenUI flag.
    var instructions = """
          Answer with a UI description. Choose bar_chart, metric_cards, table, or text to suit the request.
          Use only facts and data supplied by the user; do not invent live data. Use at most 24 items.
          If the request cannot be represented by numeric items, use type text with an empty items array.
          Return exactly one JSON object conforming to the following application-defined JSON Schema.
          Do not wrap the JSON in Markdown. Keep the title and summary concise.
          """ + "\n" + schema.ToJsonString();

    var payload = new JsonObject
    {
        ["model"] = deployment,
        ["messages"] = new JsonArray(
            new JsonObject { ["role"] = "system", ["content"] = instructions },
            new JsonObject { ["role"] = "user", ["content"] = input.Prompt })
    };
    payload["response_format"] = new JsonObject
    {
        ["type"] = "json_schema",
        ["json_schema"] = new JsonObject
        {
            ["name"] = "ui_response", ["strict"] = true, ["schema"] = schema.DeepClone()
        }
    };

    if (!endpoint.EndsWith("/openai/v1", StringComparison.OrdinalIgnoreCase))
        endpoint += "/openai/v1";
    using var request = new HttpRequestMessage(HttpMethod.Post, endpoint + "/chat/completions");
    request.Headers.Add("api-key", apiKey);
    request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");

    var timer = Stopwatch.StartNew();
    try
    {
        using var response = await clients.CreateClient("foundry").SendAsync(request, cancellationToken);
        var rawResponse = await response.Content.ReadAsStringAsync(cancellationToken);
        string? content = null, refusal = null, finishReason = null, parseError = null;
        try
        {
            using var document = JsonDocument.Parse(rawResponse);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("choices", out var choices)
                && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0
                && choices[0].ValueKind == JsonValueKind.Object)
            {
                var choice = choices[0];
                if (choice.TryGetProperty("finish_reason", out var finish) && finish.ValueKind == JsonValueKind.String)
                    finishReason = finish.GetString();
                if (choice.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.Object)
                {
                    if (message.TryGetProperty("content", out var text) && text.ValueKind == JsonValueKind.String)
                        content = text.GetString();
                    if (message.TryGetProperty("refusal", out var refused) && refused.ValueKind == JsonValueKind.String)
                        refusal = refused.GetString();
                }
            }
        }
        catch (JsonException) { parseError = "The upstream response was not valid JSON. The original body is shown below."; }

        // Preserve the entire upstream body, including errors and unknown fields.
        // Headers are deliberately excluded: credentials never reach the browser.
        return Results.Ok(new
        {
            deployment, request = payload,
            httpStatus = (int)response.StatusCode, elapsedMs = timer.ElapsedMilliseconds,
            content, refusal, finishReason, parseError, rawResponse
        });
    }
    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
    {
        return Results.Json(new { error = "Foundry did not respond within 120 seconds." }, statusCode: 504);
    }
    catch (HttpRequestException)
    {
        return Results.Json(new { error = "Could not reach Foundry. Check the endpoint and network access." }, statusCode: 502);
    }
});

app.Run();
record GenerateInput(string Prompt);
