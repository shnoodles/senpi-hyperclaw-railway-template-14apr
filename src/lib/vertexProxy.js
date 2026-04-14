/**
 * Local Vertex AI proxy server.
 *
 * Runs an HTTP server on a local port that accepts OpenAI-compatible
 * chat/completions requests and forwards them to Vertex AI,
 * handling auth, request formatting, and response cleanup.
 *
 * Supports multiple proxy modes for different model types:
 *   - "rawPassthrough" (default) — POST OpenAI body directly to :rawPredict URL
 *   - "rawPredict" — Gemma-style: wrap in instances + @requestFormat
 *   - "direct" — POST to /v1/chat/completions on dedicated DNS
 *
 * Architecture:
 *   OpenClaw → http://127.0.0.1:{PORT}/v1/chat/completions (OpenAI format)
 *     → Vertex AI endpoint (shared or dedicated domain)
 *     → response cleanup → OpenAI response back to OpenClaw
 */

import http from "node:http";

const VERTEX_PROXY_PORT = parseInt(process.env.VERTEX_PROXY_PORT || "7199", 10);

// Circular buffer for request/response logging (last 20 requests)
const REQUEST_LOG = [];
const MAX_LOG_ENTRIES = 20;
function logRequest(entry) {
  REQUEST_LOG.push({ ...entry, timestamp: new Date().toISOString() });
  if (REQUEST_LOG.length > MAX_LOG_ENTRIES) REQUEST_LOG.shift();
}
export function getRequestLog() {
  return REQUEST_LOG;
}

// Vertex AI endpoint config — env vars with sensible defaults
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || process.env.GCP_PROJECT_ID || "";
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || process.env.GCP_LOCATION || "us-central1";
const VERTEX_ENDPOINT_ID = process.env.VERTEX_ENDPOINT_ID || "";

// Dedicated DNS — uses dedicated domain instead of shared aiplatform.googleapis.com.
const VERTEX_DEDICATED_DNS = process.env.VERTEX_DEDICATED_DNS || process.env.VERTEX_DEDICATED_DOMAIN || "";

// Default model name returned by /v1/models
const DEFAULT_MODEL_NAME = process.env.VERTEX_MODEL_NAME || "gemma-4-31b-it";

function getRawPredictUrl() {
  const host = VERTEX_DEDICATED_DNS
    ? VERTEX_DEDICATED_DNS
    : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/endpoints/${VERTEX_ENDPOINT_ID}:rawPredict`;
}

/**
 * Get the direct OpenAI-compatible chat completions URL on the dedicated DNS.
 * Some vLLM containers expose /v1/chat/completions directly.
 */
function getDirectChatUrl() {
  const host = VERTEX_DEDICATED_DNS
    ? VERTEX_DEDICATED_DNS
    : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1/chat/completions`;
}

/**
 * Get the v1beta1 chat completions URL (for dedicated endpoints that use
 * the OpenAI-compatible interface at the v1beta1 path).
 */
function getChatCompletionsUrl() {
  const host = VERTEX_DEDICATED_DNS
    ? VERTEX_DEDICATED_DNS
    : `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${VERTEX_PROJECT}/locations/${VERTEX_LOCATION}/endpoints/${VERTEX_ENDPOINT_ID}/chat/completions`;
}

// Proxy mode:
//   "rawPassthrough" (default) — POST OpenAI body directly to :rawPredict URL
//   "rawPredict"               — wrap in instances + @requestFormat
//   "direct"                   — POST to /v1/chat/completions on dedicated DNS
//   "chatCompletions"          — POST to v1beta1/.../chat/completions (Gemma dedicated endpoints)
const VERTEX_PROXY_MODE = process.env.VERTEX_PROXY_MODE || "chatCompletions";

let server = null;

/**
 * Forward an OpenAI-format request to the Vertex AI endpoint.
 */
async function handleChatCompletions(openaiBody) {
  const token = process.env.VERTEX_API_TOKEN;
  if (!token) {
    throw new Error("VERTEX_API_TOKEN not set — vertexAuth.js may not have refreshed yet");
  }

  const wantsStream = !!openaiBody.stream;
  delete openaiBody.stream;
  delete openaiBody.stream_options;
  // Strip non-standard fields that vLLM doesn't understand
  delete openaiBody.store;

  const startTime = Date.now();

  // Debug: log tool presence
  const toolCount = (openaiBody.tools || []).length;
  if (toolCount > 0) {
    console.log(`[vertex-proxy] Tools: ${toolCount} function(s): ${(openaiBody.tools || []).map(t => t?.function?.name || "?").join(", ")}`);
  } else {
    console.log(`[vertex-proxy] Tools: NONE (no tools in request)`);
  }
  if (openaiBody.tool_choice) {
    console.log(`[vertex-proxy] tool_choice: ${JSON.stringify(openaiBody.tool_choice)}`);
  }

  let url, body;

  if (VERTEX_PROXY_MODE === "rawPredict") {
    // rawPredict mode (Gemma-style): wrap in instances
    url = getRawPredictUrl();
    const instance = { "@requestFormat": "chatCompletions" };
    for (const [key, value] of Object.entries(openaiBody)) {
      if (key !== "model" && key !== "stream" && key !== "stream_options") {
        instance[key] = value;
      }
    }
    body = JSON.stringify({ instances: [instance] });
    console.log(`[vertex-proxy] → rawPredict (instances): ${VERTEX_ENDPOINT_ID}`);
  } else if (VERTEX_PROXY_MODE === "direct") {
    // Direct mode: send OpenAI format to /v1/chat/completions on dedicated DNS
    url = getDirectChatUrl();
    body = JSON.stringify(openaiBody);
    console.log(`[vertex-proxy] → direct chat/completions: ${VERTEX_DEDICATED_DNS || VERTEX_ENDPOINT_ID}`);
  } else if (VERTEX_PROXY_MODE === "chatCompletions") {
    // v1beta1 chat completions (Gemma dedicated endpoints)
    url = getChatCompletionsUrl();
    body = JSON.stringify(openaiBody);
    console.log(`[vertex-proxy] → v1beta1 chat/completions: ${VERTEX_DEDICATED_DNS || VERTEX_ENDPOINT_ID}`);
  } else {
    // rawPassthrough mode (default): POST OpenAI body directly to :rawPredict
    url = getRawPredictUrl();
    body = JSON.stringify(openaiBody);
    console.log(`[vertex-proxy] → rawPassthrough: ${VERTEX_DEDICATED_DNS || VERTEX_ENDPOINT_ID}`);
  }

  console.log(`[vertex-proxy] Request keys: ${Object.keys(openaiBody).join(", ")}`);

  // 120s timeout to avoid infinite hangs
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timeout);
    if (fetchErr.name === "AbortError") {
      throw new Error(`request timed out after 120s`);
    }
    throw new Error(`network error: ${fetchErr.cause?.code || fetchErr.cause?.message || fetchErr.message}`);
  }
  clearTimeout(timeout);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[vertex-proxy] ← response: ${res.status} (${elapsed}s)`);

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`request failed (${res.status}): ${text}`);
  }

  // Unwrap: rawPredict (instances mode) wraps response in {"predictions": {...}}
  // Other modes return OpenAI format directly
  const parsed = JSON.parse(text);
  const result = VERTEX_PROXY_MODE === "rawPredict" ? (parsed.predictions || parsed) : parsed;

  // Clean up response for OpenClaw compatibility:
  // - Remove empty tool_calls arrays (confuses some clients)
  // - Log first choice content for debugging
  if (result?.choices) {
    for (const choice of result.choices) {
      if (choice?.message) {
        // Remove empty tool_calls array
        if (Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length === 0) {
          delete choice.message.tool_calls;
        }
        // Remove null fields that might confuse parsers
        for (const key of ["refusal", "annotations", "audio", "function_call", "reasoning"]) {
          if (choice.message[key] === null) {
            delete choice.message[key];
          }
        }
      }
    }
    const firstContent = result.choices[0]?.message?.content || "";
    const hasTool = !!result.choices[0]?.message?.tool_calls;
    const toolNames = result.choices[0]?.message?.tool_calls?.map(t => t.function?.name).join(", ") || "";
    console.log(`[vertex-proxy] ✓ ${elapsed}s | finish=${result.choices[0]?.finish_reason} | tools=${hasTool}${toolNames ? ` [${toolNames}]` : ""} | content=${firstContent.slice(0, 80).replace(/\n/g, "\\n")}...`);
  } else {
    console.log(`[vertex-proxy] ✓ ${elapsed}s | unexpected shape: ${Object.keys(result).join(",")}`);
  }

  return { result, wantsStream };
}

/**
 * Convert a non-streaming chat completion to SSE format.
 * This is needed when OpenClaw requests streaming but the endpoint only
 * returns non-streaming responses.
 */
function completionToSSE(completion) {
  const chunk = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
    choices: (completion.choices || []).map((c) => ({
      index: c.index,
      delta: {
        role: c.message?.role,
        content: c.message?.content || "",
        ...(c.message?.tool_calls ? { tool_calls: c.message.tool_calls } : {}),
      },
      finish_reason: c.finish_reason,
    })),
    ...(completion.usage ? { usage: completion.usage } : {}),
  };

  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * Handle /v1/models endpoint.
 */
function handleModels() {
  return {
    object: "list",
    data: [
      {
        id: DEFAULT_MODEL_NAME,
        object: "model",
        owned_by: "vertex-ai",
        permission: [],
      },
    ],
  };
}

/**
 * Start the local proxy server.
 */
export function startVertexProxy() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || "";
      console.log(`[vertex-proxy] ${req.method} ${url}`);

      // GET /v1/models
      if (req.method === "GET" && url.includes("/models")) {
        res.writeHead(200);
        res.end(JSON.stringify(handleModels()));
        return;
      }

      // POST /v1/chat/completions
      if (req.method === "POST" && (url.includes("/chat/completions") || url === "/")) {
        let body = "";
        for await (const chunk of req) body += chunk;

        try {
          const openaiRequest = JSON.parse(body);
          const toolNames = (openaiRequest.tools || []).map(t => t?.function?.name || "?");
          const msgCount = (openaiRequest.messages || []).length;
          const lastMsg = openaiRequest.messages?.[msgCount - 1];
          const toolCallsMade = [];
          for (const m of (openaiRequest.messages || [])) {
            if (m.role === "assistant" && m.tool_calls) {
              for (const tc of m.tool_calls) {
                toolCallsMade.push({ name: tc.function?.name, args: tc.function?.arguments?.slice(0, 100) });
              }
            }
          }
          logRequest({
            type: "chat_completions",
            model: openaiRequest.model,
            stream: !!openaiRequest.stream,
            toolCount: toolNames.length,
            toolNames,
            tool_choice: openaiRequest.tool_choice || null,
            messageCount: msgCount,
            lastMessageRole: lastMsg?.role,
            lastMessagePreview: typeof lastMsg?.content === "string" ? lastMsg.content.slice(0, 200) : JSON.stringify(lastMsg?.content)?.slice(0, 200),
            toolCallsMade,
            hasStore: !!openaiRequest.store,
            requestKeys: Object.keys(openaiRequest),
          });
          const { result, wantsStream } = await handleChatCompletions(openaiRequest);

          if (wantsStream) {
            console.log(`[vertex-proxy] Converting to SSE (client requested stream)`);
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            res.end(completionToSSE(result));
          } else {
            res.writeHead(200);
            res.end(JSON.stringify(result));
          }
        } catch (err) {
          console.error("[vertex-proxy] Error:", err.message);
          res.writeHead(502);
          res.end(JSON.stringify({
            error: {
              message: err.message,
              type: "proxy_error",
              code: 502,
            },
          }));
        }
        return;
      }

      // Catch-all
      let fallbackBody = "";
      for await (const chunk of req) fallbackBody += chunk;
      console.log(`[vertex-proxy] UNHANDLED ${req.method} ${url} body=${fallbackBody.slice(0, 500)}`);
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found", path: url }));
    });

    server.listen(VERTEX_PROXY_PORT, "127.0.0.1", () => {
      const baseUrl = `http://127.0.0.1:${VERTEX_PROXY_PORT}/v1`;
      console.log(`[vertex-proxy] Listening on ${baseUrl}`);
      console.log(`[vertex-proxy] Mode: ${VERTEX_PROXY_MODE}${VERTEX_DEDICATED_DNS ? ` via dedicated DNS (${VERTEX_DEDICATED_DNS})` : " via shared domain"}`);
      console.log(`[vertex-proxy] Endpoint: ${VERTEX_ENDPOINT_ID}`);
      console.log(`[vertex-proxy] Model: ${DEFAULT_MODEL_NAME}`);
      resolve(baseUrl);
    });

    server.on("error", (err) => {
      console.error("[vertex-proxy] Server error:", err.message);
      reject(err);
    });
  });
}

export function stopVertexProxy() {
  if (server) {
    server.close();
    server = null;
    console.log("[vertex-proxy] Stopped");
  }
}

export function getVertexProxyBaseUrl() {
  return `http://127.0.0.1:${VERTEX_PROXY_PORT}/v1`;
}
