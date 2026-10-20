// SSE lines and UTF-8 characters can split across arbitrary network chunks.
export async function* readSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", event = "message", data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message"; data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const content = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = content;
          if (field === "data") data.push(content);
        }
      }
      // Unterminated frames cannot establish a completed response.
      if (done) break;
    }
  } finally { reader.releaseLock(); }
}
