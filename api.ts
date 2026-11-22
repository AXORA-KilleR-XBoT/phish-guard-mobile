// Talking to the Phish Guard API: checking the server address, sending one message, and
// validating what comes back. This file imports nothing from React Native, so the tests in
// api.test.ts can run it with plain Node.

export type CheckResult = { label: "spam" | "ham"; spam_probability: number };

/** The API rejects longer messages, so the app refuses them before sending. */
export const MAX_TEXT_CHARS = 10_000;
export const REQUEST_TIMEOUT_MS = 8000;

export type ApiErrorKind =
  | "invalid-url"
  | "empty-message"
  | "too-long"
  | "timeout"
  | "network"
  | "http"
  | "invalid-response";

/** An error whose message is safe and useful to show to the person using the app. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  constructor(kind: ApiErrorKind, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

// ---------- the server address ----------

export type UrlCheck = { ok: true; url: string } | { ok: false; message: string };

const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const IPV4 = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/; // no leading zeros: "010" can mean octal
const IPV6_IN_BRACKETS = /^\[[0-9A-Fa-f:.]+\]$/;
const URL_PATH = /^(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*$/;

/** True for addresses on your own machine or private network, where plain http:// is acceptable. */
function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]" || host.endsWith(".local")) return true;
  const match = IPV4.exec(host);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Check the address typed by the user and return it in a clean form (no trailing slash).
 * Plain http:// is only accepted for localhost and private-network addresses: anything on the
 * internet has to use https://, because http:// sends the message as readable text.
 */
export function validateServerUrl(input: string): UrlCheck {
  const fail = (message: string): UrlCheck => ({ ok: false, message });
  const value = input.trim();
  if (value === "") return fail("Enter the server address, for example http://192.168.1.20:8000");
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(value);
  if (!scheme) return fail("The address must start with http:// or https:// (for example http://192.168.1.20:8000).");
  const protocol = scheme[1].toLowerCase();
  if (protocol !== "http" && protocol !== "https") return fail("Only http:// and https:// addresses are supported.");
  const rest = scheme[2];
  if (/[\s?#]/.test(rest)) return fail("The address must not contain spaces, '?' or '#'.");
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash).replace(/\/+$/, "");
  if (authority.includes("@")) return fail("Do not put a user name or password in the address.");
  const parts = /^(.*?)(?::(\d{1,5}))?$/.exec(authority);
  const host = (parts?.[1] ?? "").toLowerCase();
  const port = parts?.[2] === undefined ? undefined : Number(parts[2]);
  if (!(HOST_NAME.test(host) || IPV6_IN_BRACKETS.test(host))) {
    return fail("The host name is not valid. Use an address like 192.168.1.20 or myserver.local (replace any YOUR_COMPUTER_IP).");
  }
  if (port !== undefined && (port < 1 || port > 65535)) return fail("The port must be between 1 and 65535.");
  if (!URL_PATH.test(path)) return fail("The address contains characters that are not allowed in a path.");
  if (protocol === "http" && !isLocalHost(host)) {
    return fail("Plain http:// is only allowed for localhost and addresses on your own network (such as 192.168.x.x). Use https:// for a server on the internet.");
  }
  return { ok: true, url: `${protocol}://${host}${port === undefined ? "" : `:${port}`}${path}` };
}

// ---------- what the server answers ----------

const INVALID_RESPONSE = "The server answered, but not in the format this app expects. Is this the Phish Guard API address?";

/** Accept only {"label": "spam" | "ham", "spam_probability": a number from 0 to 1}; anything else is an error. */
export function parseCheckResult(data: unknown): CheckResult {
  if (typeof data === "object" && data !== null) {
    const { label, spam_probability: probability } = data as Record<string, unknown>;
    // NaN and the infinities fail the range check, so they need no separate test.
    if ((label === "spam" || label === "ham") && typeof probability === "number" && probability >= 0 && probability <= 1) {
      return { label, spam_probability: probability };
    }
  }
  throw new ApiError("invalid-response", INVALID_RESPONSE);
}

function httpMessage(status: number): string {
  if (status === 404) return "The server answered, but it has no /check endpoint (HTTP 404). Is this the Phish Guard API address?";
  if (status === 400 || status === 413 || status === 422) return `The server rejected this message (HTTP ${status}).`;
  if (status === 429) return "The server says there are too many requests (HTTP 429). Wait a moment and try again.";
  if (status >= 500) return `The server had a problem (HTTP ${status}). Try again later.`;
  return `The server answered with an unexpected status (HTTP ${status}).`;
}

// ---------- sending a message ----------

/** The small part of fetch() that this file needs; tests pass in a fake. */
export type HttpResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type HttpFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<HttpResponse>;

export type CheckOptions = { fetchImpl?: HttpFetch; timeoutMs?: number };

async function send(url: string, text: string, signal: AbortSignal, fetchImpl: HttpFetch): Promise<CheckResult> {
  let response: HttpResponse;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch {
    throw new ApiError(
      "network",
      "Could not reach the server. Check the address, make sure the API is running, and that this device can reach it (same Wi-Fi for a phone).",
    );
  }
  // Only a fixed message per status is shown: whatever text the server sent is never displayed.
  if (!response.ok) throw new ApiError("http", httpMessage(response.status));
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError("invalid-response", INVALID_RESPONSE);
  }
  return parseCheckResult(data);
}

/**
 * Ask the API about one message. Always settles: it either returns a validated result or throws an
 * ApiError, and it gives up after `timeoutMs` even if the server never answers.
 */
export async function checkMessage(serverUrl: string, text: string, options: CheckOptions = {}): Promise<CheckResult> {
  const fetchImpl: HttpFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const server = validateServerUrl(serverUrl);
  if (!server.ok) throw new ApiError("invalid-url", server.message);
  if (text.trim() === "") throw new ApiError("empty-message", "Type or paste a message first.");
  if (text.length > MAX_TEXT_CHARS) {
    throw new ApiError("too-long", `The message is too long (${text.length} characters; the limit is ${MAX_TEXT_CHARS}).`);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError("timeout", `The server did not answer within ${timeoutMs / 1000} seconds. Check the address and that the API is running.`));
    }, timeoutMs);
  });
  const request = send(`${server.url}/check`, text, controller.signal, fetchImpl);
  try {
    // Promise.race also handles the losing promise, so a request that fails after the timeout is not an unhandled rejection.
    return await Promise.race([request, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
