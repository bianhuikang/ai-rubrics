import https from "node:https";
import { URL } from "node:url";

function llmTlsInsecure(): boolean {
  const value = process.env.LLM_TLS_INSECURE?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  return process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0";
}

function formatLlmFetchError(error: unknown, endpoint: string): Error {
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const message = error instanceof Error ? error.message : String(error);
  const certError = /unable to get local issuer certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate/i.test(
    `${message} ${causeMessage}`,
  );
  if (certError) {
    return new Error(
      `LLM request failed (TLS certificate): ${endpoint}. For local dev set LLM_TLS_INSECURE=1, or fix certificates with NODE_EXTRA_CA_CERTS.`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  return error instanceof Error ? error : new Error(message);
}

async function insecureHttpsFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const body =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : init?.body == null
          ? undefined
          : String(init.body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: Object.fromEntries(headers.entries()),
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              headers: res.headers as HeadersInit,
            }),
          );
        });
      },
    );

    req.on("error", (error) => reject(formatLlmFetchError(error, input)));

    const signal = init?.signal;
    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(formatLlmFetchError(new DOMException("The operation was aborted.", "AbortError"), input));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          req.destroy();
          reject(formatLlmFetchError(new DOMException("The operation was aborted.", "AbortError"), input));
        },
        { once: true },
      );
    }

    if (body) req.write(body);
    req.end();
  });
}

export async function llmFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    if (llmTlsInsecure()) return await insecureHttpsFetch(input, init);
    return await fetch(input, init);
  } catch (error) {
    throw formatLlmFetchError(error, input);
  }
}
