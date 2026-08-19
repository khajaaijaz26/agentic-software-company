import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

import {
  defaultUserProviderConfig,
  legacyProjectFiles,
  loadProjectConfig,
  loadUserProviderConfig,
  projectFiles,
  saveUserProviderConfig,
} from "../../packages/config/src/index.js";
import {
  AnthropicMessagesAdapter,
  createModelRoutingRevision,
  DeterministicModelAdapter,
  ModelBroker,
  ModelGateway,
  OpenAIResponsesAdapter,
  resolveModelRoute,
  type FetchLike,
  type ModelCapabilityCatalog,
  type NormalizedModelFrame,
} from "../../packages/model-gateway/src/index.js";
import {
  EnvironmentSecretBroker,
  LinuxSecretServiceBackend,
  SecretBackendBroker,
  UnsupportedCredentialBackendError,
  createPlatformCredentialBackend,
  parseSecretReference,
  scrubSecretEnvironment,
  type CredentialCommandRunner,
} from "../../packages/secret-broker/src/index.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "software-agent-providers-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, {recursive: true, force: true});
  }
});

function eventStream(chunks: readonly string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(chunk));
      }
    },
  }), {
    status: 200,
    headers: {"content-type": "text/event-stream", ...headers},
  });
}

async function frames(source: AsyncIterable<NormalizedModelFrame>): Promise<readonly NormalizedModelFrame[]> {
  const result: NormalizedModelFrame[] = [];
  for await (const frame of source) result.push(frame);
  return result;
}

function catalog(providerId: "openai" | "anthropic", modelId: string): ModelCapabilityCatalog {
  return {
    schema: "software-agent.model-catalog/v1",
    providerId,
    version: "test-1",
    source: "test fixture",
    observedAt: "2026-08-19T00:00:00.000Z",
    models: [{
      modelId,
      capabilities: {
        tools: true,
        structuredOutput: true,
        vision: "UNKNOWN",
        streaming: true,
        contextTokens: 128_000,
      },
      pricing: "UNKNOWN",
    }],
  };
}

function fetchUrl(input: string | URL | Request | undefined): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url;
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

describe("Software Agent native provider adapters", () => {
  it("normalizes fragmented OpenAI Responses text, tool, usage, and completion frames", async () => {
    const secret = "openai-secret-canary";
    const environment: NodeJS.ProcessEnv = {OPENAI_API_KEY: secret};
    const fetchImplementation: FetchLike = () => Promise.resolve(eventStream([
      "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-test\"}}\n\n",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel",
      "lo\"}\n\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"\"}}\n\n",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":1,\"delta\":\"{\\\"path\\\":\"}\n\n",
      "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":1,\"delta\":\"\\\"README.md\\\"}\"}\n\n",
      "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":1,\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}\n\n",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-test\",\"usage\":{\"input_tokens\":10,\"output_tokens\":4,\"total_tokens\":14,\"input_tokens_details\":{\"cached_tokens\":2},\"output_tokens_details\":{\"reasoning_tokens\":1}}}}\n\n",
    ], {"x-request-id": "req_openai"}));
    const fetchMock = vi.fn(fetchImplementation);
    const adapter = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker(environment, {scrubOnRead: true}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: fetchMock,
      catalog: catalog("openai", "gpt-test"),
    });

    const result = await frames(adapter.stream({
      requestId: "model_request_1",
      modelId: "gpt-test",
      system: "Be exact.",
      input: "Inspect the README.",
      maxOutputTokens: 200,
      tools: [{name: "read_file", description: "Read a file", inputSchema: {type: "object"}}],
    }, new AbortController().signal));

    expect(result).toEqual([
      {type: "text-delta", text: "Hello"},
      {type: "tool-call", callId: "call_1", name: "read_file", arguments: {path: "README.md"}},
      {
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 2,
          reasoningTokens: 1,
          totalTokens: 14,
          source: "PROVIDER",
        },
      },
      {
        type: "completed",
        providerRequestId: "resp_1",
        resolvedModel: "gpt-test",
        stopReason: "completed",
      },
    ]);
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(fetchUrl(url)).toBe("https://api.openai.com/v1/responses");
    expect(init).toMatchObject({method: "POST", redirect: "error"});
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
    expect(typeof init?.body === "string" ? init.body : "").not.toContain("OPENAI_API_KEY");
  });

  it("normalizes Anthropic Messages streams and pins the API version", async () => {
    const fetchMock = vi.fn(async () => eventStream([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":3}}}\n\n",
      "event: ping\ndata: {\"type\":\"ping\"}\n\n",
      "event: provider_future_event\ndata: {\"type\":\"provider_future_event\",\"future\":true}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
      "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool_1\",\"name\":\"run_tests\",\"input\":{}}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"scope\\\":\\\"unit\\\"}\"}}\n\n",
      "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"output_tokens\":2}}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ], {"request-id": "req_anthropic"})) as FetchLike;
    const adapter = new AnthropicMessagesAdapter({
      secretBroker: new EnvironmentSecretBroker({ANTHROPIC_API_KEY: "anthropic-test-key"}),
      credential: parseSecretReference("env://ANTHROPIC_API_KEY"),
      fetch: fetchMock,
      catalog: catalog("anthropic", "claude-test"),
    });

    const result = await frames(adapter.stream({
      requestId: "model_request_2",
      modelId: "claude-test",
      system: "Be exact.",
      input: "Run tests.",
      maxOutputTokens: 100,
    }, new AbortController().signal));

    expect(result).toEqual([
      {type: "text-delta", text: "Done"},
      {type: "tool-call", callId: "tool_1", name: "run_tests", arguments: {scope: "unit"}},
      {
        type: "usage",
        usage: {
          inputTokens: 8,
          outputTokens: 5,
          cachedInputTokens: 3,
          reasoningTokens: "UNKNOWN",
          totalTokens: 13,
          source: "PROVIDER",
        },
      },
      {type: "completed", providerRequestId: "msg_1", resolvedModel: "claude-test", stopReason: "tool_use"},
    ]);
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] ?? [];
    expect(fetchUrl(url)).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-test-key");
  });

  it("treats model-list responses as identity-only and never infers capabilities", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{id: "known"}, {id: "new-unlisted-model"}],
    }), {status: 200, headers: {"content-type": "application/json"}})) as FetchLike;
    const adapter = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker({OPENAI_API_KEY: "test"}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: fetchMock,
      catalog: catalog("openai", "known"),
    });

    const discovered = await adapter.discover();
    expect(discovered.find(({modelId}) => modelId === "known")?.capabilities.tools).toBe(true);
    expect(discovered.find(({modelId}) => modelId === "new-unlisted-model")?.capabilities).toEqual({
      tools: "UNKNOWN",
      structuredOutput: "UNKNOWN",
      vision: "UNKNOWN",
      streaming: "UNKNOWN",
      contextTokens: "UNKNOWN",
    });
    expect(discovered.find(({modelId}) => modelId === "new-unlisted-model")?.pricing).toBe("UNKNOWN");
  });

  it("encodes portable tool results using each provider's native continuation protocol", async () => {
    const openAiFetch = vi.fn<FetchLike>(() => Promise.resolve(eventStream([
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tools\",\"model\":\"gpt-test\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    ])));
    const openAi = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker({OPENAI_API_KEY: "test"}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: openAiFetch,
      catalog: catalog("openai", "gpt-test"),
    });
    await openAi.complete({
      requestId: "openai_tool_result",
      modelId: "gpt-test",
      system: "Use tools safely.",
      input: "unused when messages are supplied",
      maxOutputTokens: 10,
      messages: [
        {role: "user", content: "Read the file."},
        {role: "assistant", content: "", toolCalls: [{callId: "call_1", name: "read_file", arguments: {path: "README.md"}}]},
      ],
      toolResults: [{callId: "call_1", name: "read_file", content: "permission denied", isError: true}],
    }, new AbortController().signal);
    const openAiBody = requestBody(vi.mocked(openAiFetch).mock.calls[0]?.[1]);
    expect(openAiBody.input).toEqual([
      {role: "system", content: "Use tools safely."},
      {role: "user", content: "Read the file."},
      {type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"README.md\"}"},
      {type: "function_call_output", call_id: "call_1", output: "[tool_error]\npermission denied"},
    ]);

    const anthropicFetch = vi.fn<FetchLike>(() => Promise.resolve(eventStream([
      "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_tools\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":1}}}\n\n",
      "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ])));
    const anthropic = new AnthropicMessagesAdapter({
      secretBroker: new EnvironmentSecretBroker({ANTHROPIC_API_KEY: "test"}),
      credential: parseSecretReference("env://ANTHROPIC_API_KEY"),
      fetch: anthropicFetch,
      catalog: catalog("anthropic", "claude-test"),
    });
    await anthropic.complete({
      requestId: "anthropic_tool_result",
      modelId: "claude-test",
      system: "Use tools safely.",
      input: "unused when messages are supplied",
      maxOutputTokens: 10,
      providerContinuationId: "msg_previous_1",
      messages: [
        {role: "user", content: "Read the file."},
        {role: "assistant", content: "", toolCalls: [{callId: "call_1", name: "read_file", arguments: {path: "README.md"}}]},
      ],
      toolResults: [{callId: "call_1", name: "read_file", content: "permission denied", isError: true}],
    }, new AbortController().signal);
    const anthropicBody = requestBody(vi.mocked(anthropicFetch).mock.calls[0]?.[1]);
    expect(anthropicBody).not.toHaveProperty("previous_response_id");
    expect(anthropicBody.messages).toEqual([
      {role: "user", content: "Read the file."},
      {role: "assistant", content: [{type: "tool_use", id: "call_1", name: "read_file", input: {path: "README.md"}}]},
      {role: "user", content: [{type: "tool_result", tool_use_id: "call_1", content: "permission denied", is_error: true}]},
    ]);
  });

  it("maps validated same-provider continuation identities only for OpenAI", async () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(eventStream([
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_next\",\"model\":\"gpt-test\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
    ])));
    const adapter = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker({OPENAI_API_KEY: "test"}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: fetchMock,
    });
    await adapter.complete({
      requestId: "valid_continuation",
      modelId: "gpt-test",
      system: "system",
      input: "",
      maxOutputTokens: 10,
      providerContinuationId: "resp_previous_1",
      toolResults: [{callId: "call_1", content: "success"}],
    }, new AbortController().signal);
    expect(requestBody(vi.mocked(fetchMock).mock.calls[0]?.[1])).toMatchObject({
      previous_response_id: "resp_previous_1",
      input: expect.arrayContaining([{type: "function_call_output", call_id: "call_1", output: "success"}]),
    });
    await expect(adapter.complete({
      requestId: "invalid_continuation",
      modelId: "gpt-test",
      system: "system",
      input: "input",
      maxOutputTokens: 10,
      providerContinuationId: "response\nheader-injection",
    }, new AbortController().signal)).rejects.toThrow("continuation ID");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on provider error events delivered after HTTP 200", async () => {
    const openAi = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker({OPENAI_API_KEY: "openai-stream-secret"}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: () => Promise.resolve(eventStream([
        "event: error\ndata: {\"type\":\"error\",\"message\":\"openai-stream-secret\"}\n\n",
      ])),
    });
    const anthropic = new AnthropicMessagesAdapter({
      secretBroker: new EnvironmentSecretBroker({ANTHROPIC_API_KEY: "anthropic-stream-secret"}),
      credential: parseSecretReference("env://ANTHROPIC_API_KEY"),
      fetch: () => Promise.resolve(eventStream([
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"anthropic-stream-secret\"}}\n\n",
      ])),
    });
    const request = {requestId: "stream_error", modelId: "test-model", system: "system", input: "input", maxOutputTokens: 10} as const;

    await expect(frames(openAi.stream(request, new AbortController().signal)))
      .rejects.toMatchObject({code: "PROVIDER_PROTOCOL_ERROR", message: expect.not.stringContaining("openai-stream-secret")});
    await expect(frames(anthropic.stream(request, new AbortController().signal)))
      .rejects.toMatchObject({code: "PROVIDER_PROTOCOL_ERROR", message: expect.not.stringContaining("anthropic-stream-secret")});
  });

  it("rejects out-of-order Anthropic content events", async () => {
    const adapter = new AnthropicMessagesAdapter({
      secretBroker: new EnvironmentSecretBroker({ANTHROPIC_API_KEY: "test"}),
      credential: parseSecretReference("env://ANTHROPIC_API_KEY"),
      fetch: () => Promise.resolve(eventStream([
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"invalid\"}}\n\n",
      ])),
    });
    await expect(frames(adapter.stream({
      requestId: "invalid_anthropic_order",
      modelId: "claude-test",
      system: "system",
      input: "input",
      maxOutputTokens: 10,
    }, new AbortController().signal))).rejects.toMatchObject({code: "PROVIDER_PROTOCOL_ERROR"});
  });

  it.each([
    ["redirect", async () => new Response(null, {status: 307, headers: {location: "https://evil.invalid"}})],
    ["oversized body", async () => new Response("x".repeat(300), {status: 200, headers: {"content-type": "text/event-stream"}})],
    ["malformed frame", async () => eventStream(["data: {not-json}\n\n"])],
  ] satisfies ReadonlyArray<readonly [string, FetchLike]>)("fails closed on %s without exposing credential bytes", async (name, implementation) => {
    void name;
    const secret = "must-never-appear-in-errors";
    const adapter = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker({OPENAI_API_KEY: secret}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: vi.fn(implementation),
      maxResponseBytes: 256,
      catalog: catalog("openai", "gpt-test"),
    });

    let caught: unknown;
    try {
      await frames(adapter.stream({
        requestId: "unsafe_response",
        modelId: "gpt-test",
        system: "system",
        input: "input",
        maxOutputTokens: 10,
      }, new AbortController().signal));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(secret);
  });

  it.each([400, 401, 403, 404, 408, 413, 422, 429, 500])("normalizes provider HTTP %i without exposing response bodies", async (status) => {
    const responseCanary = `untrusted-provider-body-${status}`;
    const adapter = new OpenAIResponsesAdapter({
      secretBroker: new EnvironmentSecretBroker({OPENAI_API_KEY: "test"}),
      credential: parseSecretReference("env://OPENAI_API_KEY"),
      fetch: () => Promise.resolve(new Response(responseCanary, {
        status,
        headers: status === 429 ? {"retry-after": "2"} : {},
      })),
    });
    let caught: unknown;
    try {
      await adapter.complete({
        requestId: `http_${status}`,
        modelId: "gpt-test",
        system: "system",
        input: "input",
        maxOutputTokens: 10,
      }, new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({code: "PROVIDER_HTTP_ERROR", status});
    expect(String(caught)).not.toContain(responseCanary);
    if (status === 429) expect(caught).toMatchObject({retryAfter: "2"});
  });

  it("enforces timeout and cancellation without retrying", async () => {
    const fetchImplementation: FetchLike = (input, init) => {
      void input;
      return new Promise<Response>((resolve, reject) => {
        void resolve;
        init?.signal?.addEventListener("abort", () => reject(new Error("transport aborted")), {once: true});
      });
    };
    const fetchMock = vi.fn(fetchImplementation);
    const adapter = new AnthropicMessagesAdapter({
      secretBroker: new EnvironmentSecretBroker({ANTHROPIC_API_KEY: "timeout-key"}),
      credential: parseSecretReference("env://ANTHROPIC_API_KEY"),
      fetch: fetchMock,
      timeoutMs: 10,
      catalog: catalog("anthropic", "claude-test"),
    });

    await expect(frames(adapter.stream({
      requestId: "timeout_request",
      modelId: "claude-test",
      system: "system",
      input: "input",
      maxOutputTokens: 10,
    }, new AbortController().signal))).rejects.toMatchObject({code: "PROVIDER_TIMEOUT"});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const canceled = new AbortController();
    canceled.abort();
    await expect(frames(adapter.stream({
      requestId: "canceled_request",
      modelId: "claude-test",
      system: "system",
      input: "input",
      maxOutputTokens: 10,
    }, canceled.signal))).rejects.toMatchObject({code: "PROVIDER_CANCELED"});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Software Agent broker grants, routing, and BYOK boundaries", () => {
  it("issues attempt-bound key-free grants and consumes each grant once", async () => {
    const gateway = new ModelGateway();
    gateway.register(new DeterministicModelAdapter());
    const broker = new ModelBroker(gateway, {now: () => new Date("2026-08-19T10:00:00.000Z")});
    const grant = broker.issueGrant({
      runId: "run_1",
      taskId: "task_1",
      agentId: "software-engineer",
      attemptId: "attempt_1",
      providerId: "deterministic",
      modelId: "local",
      routingRevision: 2,
      maxInputTokens: 1_000,
      maxOutputTokens: 100,
      expiresAt: "2026-08-19T10:05:00.000Z",
    });

    expect(JSON.stringify(grant)).not.toMatch(/secret|credential|api.?key/iu);
    await expect(broker.complete(grant, {
      requestId: "request_1",
      modelId: "local",
      system: "system",
      input: "input",
      maxOutputTokens: 100,
    }, new AbortController().signal)).resolves.toMatchObject({providerId: "deterministic"});
    await expect(broker.complete(grant, {
      requestId: "request_1_replay",
      modelId: "local",
      system: "system",
      input: "input",
      maxOutputTokens: 100,
    }, new AbortController().signal)).rejects.toMatchObject({code: "MODEL_GRANT_CONSUMED"});
  });

  it("applies routing precedence and creates immutable revisions", () => {
    const route = resolveModelRoute({
      runOverride: "openai/run-model",
      nextRunSelection: "anthropic/session-model",
      roleId: "reviewer-qa",
      roleRoutes: {"reviewer-qa": "anthropic/role-model"},
      projectDefault: "openai/project-model",
      userDefault: "anthropic/user-model",
      revision: 4,
    });
    expect(route).toMatchObject({providerId: "openai", modelId: "run-model", source: "RUN", revision: 4});
    expect(Object.isFrozen(route)).toBe(true);
    expect(createModelRoutingRevision(route, "anthropic/next-model", "2026-08-19T00:00:00.000Z"))
      .toMatchObject({providerId: "anthropic", modelId: "next-model", source: "EXPLICIT_CHANGE", revision: 5});
  });

  it("scrubs resolved environment references and common provider keys from worker environments", async () => {
    const environment: NodeJS.ProcessEnv = {
      SOFTWARE_AGENT_PROFILE: "default",
      OPENAI_API_KEY: "openai-canary",
      ANTHROPIC_API_KEY: "anthropic-canary",
      PATH: "safe-path",
    };
    const broker = new EnvironmentSecretBroker(environment);
    const lease = await broker.resolve(parseSecretReference("env://OPENAI_API_KEY"), "provider request");
    expect(lease.value).toBe("openai-canary");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    const scrubbed = scrubSecretEnvironment(environment, [parseSecretReference("env://ANTHROPIC_API_KEY")]);
    expect(scrubbed).toEqual({SOFTWARE_AGENT_PROFILE: "default", PATH: "safe-path"});
  });

  it("passes Linux keychain values over stdin and never argv", async () => {
    const calls: Array<{command: string; args: readonly string[]; stdin?: string}> = [];
    const runner: CredentialCommandRunner = {
      run(command, args, options) {
        calls.push({command, args, ...(options.stdin === undefined ? {} : {stdin: options.stdin})});
        return Promise.resolve({stdout: options.stdin ?? "stored-secret\n", stderr: "", exitCode: 0});
      },
    };
    const backend = new LinuxSecretServiceBackend(runner);
    await backend.set("openai/default", "stored-secret");
    expect(calls[0]?.stdin).toBe("stored-secret");
    expect(calls[0]?.args.join(" ")).not.toContain("stored-secret");
    expect(await backend.get("openai/default")).toBe("stored-secret");
  });

  it("uses an explicit unsupported backend rather than plaintext fallback", async () => {
    const backend = createPlatformCredentialBackend({platform: "win32", commandAvailable: () => false});
    const broker = new SecretBackendBroker([backend]);
    await expect(broker.resolve(parseSecretReference("keychain://openai/default"), "test"))
      .rejects.toBeInstanceOf(UnsupportedCredentialBackendError);
  });
});

describe("Software Agent provider configuration", () => {
  it("stores only secret references in user-global configuration", async () => {
    const root = temporaryDirectory();
    const paths = {config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), cache: join(root, "cache"), runtime: join(root, "runtime")};
    const config = defaultUserProviderConfig();
    const updated = {
      ...config,
      providers: {
        openai: {enabled: true, credential: "env://OPENAI_API_KEY", defaultModel: "gpt-test"},
      },
      defaults: {model: "openai/gpt-test", roles: {}},
    } as const;
    await saveUserProviderConfig(updated, paths);
    expect(await loadUserProviderConfig(paths)).toEqual(updated);
    expect(readFileSync(join(paths.config, "providers.toml"), "utf8")).not.toContain("sk-");
    await expect(saveUserProviderConfig({
      ...updated,
      providers: {openai: {...updated.providers.openai, credential: "sk-raw-secret"}},
    }, paths)).rejects.toThrow("secret reference");
  });

  it("backs up and migrates legacy Agent Company project configuration", async () => {
    const workspace = temporaryDirectory();
    const legacy = legacyProjectFiles(workspace);
    mkdirSync(legacy.directory, {recursive: true});
    writeFileSync(legacy.projectFile, [
      'schema = "agent-company.project/v1"',
      'mapping_id = "map_legacy"',
      "mapping_revision = 1",
      "[project]",
      'name = "Legacy"',
      'default_profile = "balanced"',
      "[runtime]",
      "max_parallel_agents = 3",
      "task_timeout_minutes = 30",
      "checkpoint_interval_seconds = 15",
      "[models]",
      'default = "deterministic/local"',
      "[models.routes]",
      "[models.fallbacks]",
      "[budgets]",
      "project_cost_limit_usd = 25",
      "warn_at_percent = 80",
      "require_approval_at_percent = 100",
      "[ui]",
      'theme = "system"',
      'density = "comfortable"',
      'color = "auto"',
      "show_costs = true",
      "",
    ].join("\n"));
    writeFileSync(legacy.policyFile, 'schema = "agent-company.policy/v1"\n');
    writeFileSync(legacy.gitignoreFile, "*.sqlite\n");

    const migrated = await loadProjectConfig(workspace);
    expect(migrated.schema).toBe("software-agent.project/v2");
    expect(projectFiles(workspace).directory).toContain(".software-agent");
    expect(readFileSync(join(projectFiles(workspace).directory, "migration-backup", "agent-company-v1", "project.toml"), "utf8"))
      .toContain("agent-company.project/v1");
  });
});
