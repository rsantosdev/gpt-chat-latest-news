"""Exercise the real app against a local HTTP stub. No credentials or pip installs."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread, Event
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
KEY = "TEST-ONLY-KEY-DO-NOT-EXPOSE"
UI = {
    "type": "bar_chart", "title": "Sprint progress — TEST FIXTURE",
    "summary": "Local test data; no real model inference.", "unit": "points",
    "items": [{"label": "Planned", "value": 40}, {"label": "Completed", "value": 32}, {"label": "Remaining", "value": 8}],
}
CONTENT = json.dumps(UI, indent=2, ensure_ascii=False)
seen = []
stream_release = Event()
stream_finished = Event()


class FoundryStub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        seen.append((self.path, dict(self.headers), payload))
        if self.path == "/openai/v1/responses":
            return self.respond_stream(payload)
        prompt = payload["messages"][-1]["content"]
        status = 200
        body = {
            "id": "TEST-FIXTURE-NOT-A-MODEL-RESPONSE", "model": "test-deployment",
            "choices": [{"message": {"role": "assistant", "content": CONTENT}, "finish_reason": "stop"}],
            "extra_unknown_field": {"preserve": True},
        }
        if prompt == "stub-unsupported":
            status, body = 400, {"error": {"code": "unsupported_parameter", "message": "TEST FIXTURE: unsupported response_format"}}
        elif prompt == "stub-text":
            body["choices"][0]["message"]["content"] = "This is plain text, not JSON."
        elif prompt == "stub-refusal":
            body["choices"][0]["message"].update(content=None, refusal="TEST FIXTURE refusal")
        elif prompt == "stub-truncated":
            body["choices"][0].update(finish_reason="length")
            body["choices"][0]["message"]["content"] = '{"type":'
        elif prompt == "stub-unexpected-envelope":
            body = ["TEST FIXTURE: unexpected but valid JSON envelope"]
        elif prompt in ("stub-cards", "stub-table"):
            ui = dict(UI, type="metric_cards" if prompt == "stub-cards" else "table")
            body["choices"][0]["message"]["content"] = json.dumps(ui, indent=2, ensure_ascii=False)
        raw = json.dumps(body, ensure_ascii=False).encode()
        if prompt == "stub-invalid-json":
            status, raw = 502, b"TEST FIXTURE: bad gateway"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(raw)

    def respond_stream(self, payload):
        prompt = payload["input"]
        if prompt == "stub-stream-unsupported":
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"TEST FIXTURE: Responses not supported"}}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def send(kind, **fields):
            data = dict(type=kind, **fields)
            self.wfile.write((f"event: {kind}\ndata: " + json.dumps(data, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        text = "APAC has the highest margin — TEST FIXTURE."
        message = {"id": "msg-test", "type": "message", "role": "assistant", "phase": "commentary",
                   "status": "completed", "content": [{"type": "output_text", "text": text}]}
        if prompt == "stub-stream-unlabeled":
            message.pop("phase")
        send("response.created", response={"id": "resp-test", "status": "in_progress", "output": []})
        send("response.output_item.added", output_index=0, item=dict(message, content=[], status="in_progress"))
        send("response.output_text.delta", output_index=0, content_index=0, item_id="msg-test", delta=text)
        if prompt == "stub-stream-held":
            stream_release.wait(timeout=10)
        if prompt == "stub-stream-truncated":
            return
        send("response.output_text.done", output_index=0, content_index=0, item_id="msg-test", text=text)
        send("response.output_item.done", output_index=0, item=message)
        output = [message]
        next_index = 1
        if prompt == "stub-stream-unlabeled":
            reasoning = {"id": "reasoning-test", "type": "reasoning", "summary": []}
            later = dict(message, id="msg-later", content=[{"type": "output_text", "text": "Completed analysis — TEST FIXTURE."}])
            for index, entry in [(1, reasoning), (2, later)]:
                send("response.output_item.added", output_index=index, item=entry)
                send("response.output_item.done", output_index=index, item=entry)
            output.extend([reasoning, later])
            next_index = 3
        if payload.get("tools"):
            item = {"id": "fc-test", "type": "function_call", "call_id": "call-test",
                    "name": "render_ui", "arguments": CONTENT, "status": "completed"}
            send("response.output_item.added", output_index=next_index, item=dict(item, arguments="", status="in_progress"))
            send("response.function_call_arguments.delta", output_index=next_index, item_id="fc-test", delta=CONTENT[:50])
            send("response.function_call_arguments.delta", output_index=next_index, item_id="fc-test", delta=CONTENT[50:])
            send("response.function_call_arguments.done", output_index=next_index, item_id="fc-test", arguments=CONTENT)
        else:
            item = dict(message, id="msg-final", phase="final_answer", content=[{"type": "output_text", "text": "Completed analysis — TEST FIXTURE."}])
            send("response.output_item.added", output_index=next_index, item=item)
        send("response.output_item.done", output_index=next_index, item=item)
        send("response.completed", response={"id": "resp-test", "status": "completed", "output": output + [item]})
        stream_finished.set()


def free_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def fetch(url, body=None):
    request = Request(url, None if body is None else json.dumps(body).encode(),
                      {"Content-Type": "application/json"} if body is not None else {})
    try:
        response = urlopen(request, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read().decode()


def generate(base, prompt):
    status, _, raw = fetch(base + "/api/generate", {"prompt": prompt})
    assert status == 200, raw
    assert KEY not in raw, "Credentials leaked into a response"
    return json.loads(raw)


stub = ThreadingHTTPServer(("127.0.0.1", 0), FoundryStub)
Thread(target=stub.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{free_port()}"
environment = dict(os.environ, Foundry__Endpoint=f"http://127.0.0.1:{stub.server_port}",
                   Foundry__ApiKey=KEY, Foundry__Deployment="test-deployment")
process = subprocess.Popen(
    ["dotnet", str(ROOT / "bin/Debug/net10.0/GenUiDemo.dll"), "--urls", base],
    cwd=ROOT, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(100):
        try:
            status, _, raw = fetch(base + "/api/config")
            assert status == 200 and KEY not in raw
            assert json.loads(raw)["deployment"] == "test-deployment"
            break
        except (URLError, ConnectionError):
            if process.poll() is not None:
                raise RuntimeError("App exited during startup")
            time.sleep(0.1)
    else:
        raise RuntimeError("App did not start")

    status, _, page = fetch(base)
    assert status == 200 and "Model content" in page
    status, _, page = fetch(base + "/interleaved")
    assert status == 200 and "Live model messages" in page
    status, headers, _ = fetch(base + "/ui-renderer.mjs")
    assert status == 200 and "javascript" in headers.get("Content-Type", ""), "ES module was not served as JavaScript"

    result = generate(base, "stub-success")
    assert result["content"] == CONTENT
    assert json.loads(result["rawResponse"])["extra_unknown_field"] == {"preserve": True}
    assert result["httpStatus"] == 200 and result["finishReason"] == "stop"
    path, headers, payload = seen[-1]
    assert path == "/openai/v1/chat/completions"
    assert headers.get("api-key") == KEY
    assert payload["model"] == "test-deployment"
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert payload["response_format"]["json_schema"]["schema"] == json.loads((ROOT / "ui-schema.json").read_text())
    assert payload == result["request"]

    result = generate(base, "stub-unsupported")
    assert result["httpStatus"] == 400 and result["content"] is None
    assert json.loads(result["rawResponse"])["error"]["code"] == "unsupported_parameter"
    result = generate(base, "stub-text")
    assert result["content"] == "This is plain text, not JSON."
    result = generate(base, "stub-refusal")
    assert result["content"] is None and result["refusal"] == "TEST FIXTURE refusal"
    result = generate(base, "stub-truncated")
    assert result["finishReason"] == "length" and result["content"] == '{"type":'
    result = generate(base, "stub-invalid-json")
    assert result["httpStatus"] == 502 and result["parseError"] and result["rawResponse"] == "TEST FIXTURE: bad gateway"
    result = generate(base, "stub-unexpected-envelope")
    assert result["content"] is None and isinstance(json.loads(result["rawResponse"]), list)
    count = len(seen)
    status, _, _ = fetch(base + "/api/generate", {"prompt": ""})
    assert status == 400 and len(seen) == count

    # Hold the upstream completion until early text has actually traversed the
    # proxy. A fully buffered relay cannot pass this assertion.
    request = Request(base + "/api/interleaved", json.dumps({"prompt": "stub-stream-held", "includeUi": True}).encode(), {"Content-Type": "application/json"})
    with urlopen(request, timeout=15) as response:
        prefix = ""
        while True:
            line = response.readline().decode()
            assert line, "Stream ended before early output"
            prefix += line
            if line.startswith("data:") and '"type": "response.output_text.delta"' in line:
                break
        assert not stream_finished.is_set(), "Proxy buffered the whole model response"
        stream_release.set()
        stream = prefix + response.read().decode()
    assert "response.completed" in stream and KEY not in stream
    path, headers, payload = seen[-1]
    assert path == "/openai/v1/responses" and headers.get("api-key") == KEY
    assert payload["stream"] is True and payload["store"] is False
    assert "text" not in payload and "reasoning" not in payload
    assert payload["tools"][0]["name"] == "render_ui" and payload["tools"][0]["strict"] is True
    assert payload["tools"][0]["parameters"] == json.loads((ROOT / "ui-schema.json").read_text())
    status, _, stream = fetch(base + "/api/interleaved", {"prompt": "stub-stream", "includeUi": False})
    assert status == 200 and '"phase": "final_answer"' in stream and "tools" not in seen[-1][2]
    status, _, stream = fetch(base + "/api/interleaved", {"prompt": "stub-stream-truncated", "includeUi": True})
    assert status == 200 and "response.completed" not in stream
    status, _, raw = fetch(base + "/api/interleaved", {"prompt": "stub-stream-unsupported", "includeUi": True})
    assert status == 400 and "Responses not supported" in json.loads(raw)["rawResponse"] and KEY not in raw
    print("PASS: JSON demo, streamed Responses requests, immediate relay, text-only mode, truncated streams, upstream errors, credential isolation.", flush=True)
    if "--serve" in sys.argv:
        print(f"UI test server: {base} (TEST FIXTURES ONLY; Ctrl-C to stop)", flush=True)
        Event().wait()
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    stub.shutdown()
    stub.server_close()
