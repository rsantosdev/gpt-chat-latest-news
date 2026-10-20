import assert from "node:assert/strict";
import { readSse } from "../wwwroot/sse.mjs";

const wire = ': keepalive\r\nevent: response.output_text.delta\r\ndata: {"delta":"Olá 🌎"}\r\n\r\n'
  + 'event: multiline\ndata: {"a":\ndata: 1}\n\n'
  + 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  + 'event: unfinished\ndata: {"never":"dispatch"}';
const bytes = new TextEncoder().encode(wire);
// Single-byte chunks deliberately split CRLF, JSON tokens, and UTF-8 characters.
const stream = new ReadableStream({
  start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); }
});
const frames = [];
for await (const frame of readSse(stream)) frames.push(frame);
assert.equal(frames.length, 3);
assert.equal(JSON.parse(frames[0].data).delta, "Olá 🌎");
assert.equal(frames[1].event, "multiline");
assert.deepEqual(JSON.parse(frames[1].data), { a: 1 });
assert.equal(frames[2].event, "response.completed");
console.log("PASS: fragmented SSE frames, CRLF, multiline data, split UTF-8, incomplete final frame.");
