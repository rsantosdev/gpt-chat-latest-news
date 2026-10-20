# Streaming vs. interleaved-thinking output

**Streaming describes how output is delivered. Interleaved thinking describes when the model produces visible output while its work continues. They can work together.**

| | Regular streaming | Interleaved-thinking output |
|---|---|---|
| Main idea | Deliver generated output in small chunks. | Produce useful visible output before finishing the broader task. |
| Typical experience | One answer grows progressively on screen. | An early finding arrives, followed by more reasoning or work, then a fuller answer. |
| Benefit | Start reading an answer before its last token arrives. | Start using a finding before the overall analysis is complete. |
| What to inspect | Text-delta events. | Separate output messages, reasoning-item metadata, and phase labels when supplied. |

Each visible message in an interleaved response can itself be streamed over the same connection.

## What our live demo showed

| Time | Observed output |
|---|---|
| **3.43 s** | Early finding: APAC has the highest profit despite the lowest revenue. |
| **3.97 s** | A service `reasoning` item appeared between assistant messages. |
| **4.08 s** | The later analysis started arriving. |
| **8.43 s** | The GenUI chart and response were complete. |

One request, real service events, no simulated updates or artificial delays. These timings describe one run, not a performance guarantee.

**Private reasoning stays private.** A reasoning item is metadata, not the model's chain of thought. Streaming tokens alone does not prove interleaved thinking, and a separate early message is not guaranteed on every request.

Sources: [Microsoft announcement](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/gpt-chat-latest-gets-more-intelligent-interactive-and-personal-in-microsoft-foun/4564574) · [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) · [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
