import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { discoverJuicedModels } from "../extensions/lib/juiced-catalog.ts";

test("Juiced discovery filters policies, preserves IDs and maps per-slot context and capabilities", async (t) => {
  let phase = "normal";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.headers.authorization, "Bearer fixture-key");
    if (phase === "outage") { response.writeHead(503).end(); return; }
    if (phase === "redirect") { response.writeHead(302, { location: "/other" }).end(); return; }
    const entries = [
      { id: "Exact/Model-Q6", service: "Chat", downloaded: true, policy: "hot", recipe: "llamacpp", labels: ["vision", "reasoning"] },
      { id: "On-demand", service: "Chat", downloaded: true, policy: "on-demand", recipe: "llamacpp", labels: [] },
      { id: "Disabled", service: "Chat", downloaded: true, policy: "disabled" },
      { id: "Absent", service: "Chat", downloaded: false, policy: "hot" },
      { id: "Speech", service: "Speak", downloaded: true, policy: "hot" },
    ];
    const data = request.url === "/v1/juiced/catalog" ? (phase === "malformed" ? {} : { data: phase === "empty" ? [] : entries }) :
      request.url === "/v1/health" ? { all_models_loaded: [] } :
      { resolved_ctx_size: 65536, effective: { llamacpp_args: "--parallel 2" } };
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(data));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const discover = () => discoverJuicedModels(`http://127.0.0.1:${address.port}/v1`, new AbortController().signal, "custom", { Authorization: "Bearer fixture-key" });
  const models = await discover();
  assert.deepEqual(models.map((model) => model.id), ["Exact/Model-Q6", "On-demand"]);
  assert.equal(models[0].provider, "custom");
  assert.equal(models[0].contextWindow, 32768);
  assert.equal(models[0].maxTokens, 8192);
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.ok(requests.includes("/v1/models/Exact%2FModel-Q6/options"));
  phase = "empty";
  assert.deepEqual(await discover(), []);
  for (const failure of ["outage", "malformed", "redirect"]) {
    phase = failure;
    await assert.rejects(discover());
  }
});

test("Juiced serving limits and explicit incompatibility take precedence over setup defaults", async (t) => {
  const server = createServer((request, response) => {
    const data = request.url === "/v1/juiced/catalog" ? { data: [
      { id: "large", service: "Chat", downloaded: true, policy: "hot", recipe: "llamacpp", max_context_window: 131072, max_output_tokens: 1024, labels: [] },
      { id: "unavailable", service: "Chat", downloaded: true, policy: "hot", available: false },
      { id: "incompatible", service: "Chat", downloaded: true, policy: "hot", capability_contract: { execution: { compatibility: { compatible: false } } } },
    ] } : request.url === "/v1/health" ? { all_models_loaded: [] } : { resolved_ctx_size: 131072, effective: { llamacpp_args: "--parallel 1" } };
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await discoverJuicedModels(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, new AbortController().signal);
  assert.deepEqual(result.map(model => model.id), ["large"]);
  assert.equal(result[0].contextWindow, 131072);
  assert.equal(result[0].maxTokens, 1024);
});
