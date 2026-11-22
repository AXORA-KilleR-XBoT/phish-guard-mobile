// Run with:  npm test   (Node's built-in test runner; needs Node 22.18 or newer, which runs .ts files directly)
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ApiError,
  MAX_TEXT_CHARS,
  checkMessage,
  parseCheckResult,
  validateServerUrl,
  type ApiErrorKind,
  type HttpFetch,
  type HttpResponse,
} from "./api.ts";

const SERVER = "http://192.168.1.20:8000";

function reply(status: number, body: unknown, rawBody?: string): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (rawBody === undefined ? body : JSON.parse(rawBody)),
  };
}

/** A fake fetch that records its calls and answers with `response`. */
function fakeFetch(response: HttpResponse | Error) {
  const calls: { url: string; init: Parameters<HttpFetch>[1] }[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchImpl, calls };
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

const GOOD = { label: "spam", spam_probability: 0.93 };

describe("validateServerUrl", () => {
  const accepted: [string, string][] = [
    ["http://192.168.1.20:8000", "http://192.168.1.20:8000"],
    ["  http://192.168.1.20:8000/  ", "http://192.168.1.20:8000"], // trimmed, trailing slash removed
    ["http://10.0.2.2:8000", "http://10.0.2.2:8000"], // Android emulator
    ["http://localhost:8000", "http://localhost:8000"], // iOS simulator
    ["HTTP://LOCALHOST:8000", "http://localhost:8000"],
    ["http://127.0.0.1:8000", "http://127.0.0.1:8000"],
    ["http://[::1]:8000", "http://[::1]:8000"],
    ["http://172.16.0.1", "http://172.16.0.1"],
    ["http://172.31.255.255:8000", "http://172.31.255.255:8000"],
    ["http://169.254.1.1:8000", "http://169.254.1.1:8000"],
    ["http://my-laptop.local:8000", "http://my-laptop.local:8000"],
    ["https://example.com", "https://example.com"],
    ["https://api.example.com:8443/phish/", "https://api.example.com:8443/phish"],
    ["https://203.0.113.5", "https://203.0.113.5"],
    ["http://192.168.1.20:08000", "http://192.168.1.20:8000"], // port written with a leading zero
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      assert.deepEqual(validateServerUrl(input), { ok: true, url: expected });
    });
  }

  const refused: [string, RegExp][] = [
    ["", /Enter the server address/],
    ["   ", /Enter the server address/],
    ["192.168.1.20:8000", /must start with http/], // no scheme
    ["YOUR_COMPUTER_IP", /must start with http/],
    ["http://YOUR_COMPUTER_IP:8000", /host name is not valid/], // the old placeholder
    ["ftp://192.168.1.20", /Only http/],
    ["javascript:alert(1)", /must start with http/],
    ["file:///etc/passwd", /Only http/],
    ["http://", /host name is not valid/],
    ["http://:8000", /host name is not valid/],
    ["http://192.168.1.20:", /host name is not valid/],
    ["http://192.168.1.20:abc", /host name is not valid/],
    ["http://192.168.1.20:0", /port must be between/],
    ["http://192.168.1.20:65536", /port must be between/],
    ["http://192.168.1.20:99999", /port must be between/],
    ["http://user:secret@192.168.1.20:8000", /user name or password/],
    ["http://192.168.1.20:8000/check?x=1", /spaces, '\?' or '#'/],
    ["http://192.168.1.20:8000/#top", /spaces, '\?' or '#'/],
    ["http://192.168.1.20 :8000", /spaces/],
    ["http://192.168.1.20:8000/a b", /spaces/],
    ["http://192.168.1.20:8000/<script>", /not allowed in a path/],
    ["http://-bad-.local", /host name is not valid/],
    ["http://a..b.local", /host name is not valid/],
  ];
  for (const [input, message] of refused) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      const result = validateServerUrl(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.message, message);
    });
  }

  // Plain http:// to anything that is not local would send the message as readable text over the internet.
  const cleartextToTheInternet = [
    "http://example.com",
    "http://8.8.8.8:8000",
    "http://203.0.113.5",
    "http://172.32.0.1", // just outside 172.16.0.0/12
    "http://172.15.255.255", // just outside 172.16.0.0/12
    "http://192.169.1.1",
    "http://11.0.0.1",
    "http://localhost.evil.com", // starts like localhost, is not
    "http://evil.local.com", // contains .local, does not end with it
    "http://10.0.0.1.evil.com", // starts like a private IP, is a public host name
    "http://010.0.0.1", // leading zero: some systems read it as octal (= 8.0.0.1)
    "http://0x7f.0.0.1",
    "http://2130706433", // 127.0.0.1 written as one number
    "http://300.1.1.1",
    "http://10.300.1.1", // starts with 10. but is not an IPv4 address
    "http://myserver", // a single name without .local
  ];
  for (const input of cleartextToTheInternet) {
    it(`refuses plain http to ${input}`, () => {
      const result = validateServerUrl(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.message, /Use https/);
    });
  }

  it("allows the same non-local hosts over https", () => {
    for (const host of ["example.com", "8.8.8.8", "localhost.evil.com", "myserver"]) {
      assert.deepEqual(validateServerUrl(`https://${host}`), { ok: true, url: `https://${host}` });
    }
  });
});

describe("parseCheckResult", () => {
  it("accepts a valid answer and keeps only the two known fields", () => {
    assert.deepEqual(parseCheckResult({ label: "ham", spam_probability: 0.12, extra: "ignored" }), {
      label: "ham",
      spam_probability: 0.12,
    });
  });

  it("accepts the boundary probabilities 0 and 1", () => {
    assert.equal(parseCheckResult({ label: "ham", spam_probability: 0 }).spam_probability, 0);
    assert.equal(parseCheckResult({ label: "spam", spam_probability: 1 }).spam_probability, 1);
  });

  const malformed: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "spam"],
    ["a number", 0.9],
    ["an array", [{ label: "spam", spam_probability: 0.9 }]],
    ["an empty object", {}],
    ["no label", { spam_probability: 0.5 }],
    ["no probability", { label: "spam" }],
    ["an unknown label", { label: "unknown", spam_probability: 0.5 }],
    ["a capitalised label", { label: "Spam", spam_probability: 0.5 }],
    ["a numeric label", { label: 1, spam_probability: 0.5 }],
    ["a null label", { label: null, spam_probability: 0.5 }],
    ["a probability written as a string", { label: "spam", spam_probability: "0.5" }],
    ["a null probability", { label: "spam", spam_probability: null }],
    ["a NaN probability", { label: "spam", spam_probability: NaN }],
    ["an infinite probability", { label: "spam", spam_probability: Infinity }],
    ["a negative probability", { label: "spam", spam_probability: -0.01 }],
    ["a probability above 1", { label: "spam", spam_probability: 1.01 }],
    ["a percentage instead of a fraction", { label: "spam", spam_probability: 93 }],
  ];
  for (const [name, data] of malformed) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseCheckResult(data), (error: unknown) => error instanceof ApiError && error.kind === "invalid-response");
    });
  }
});

describe("checkMessage: the request", () => {
  it("posts the message as JSON to <server>/check and returns the validated result", async () => {
    const { fetchImpl, calls } = fakeFetch(reply(200, GOOD));
    const result = await checkMessage("http://192.168.1.20:8000/", "Win a FREE prize now", { fetchImpl });
    assert.deepEqual(result, GOOD);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://192.168.1.20:8000/check");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: "Win a FREE prize now" });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it("accepts a message of exactly the maximum length", async () => {
    const { fetchImpl } = fakeFetch(reply(200, GOOD));
    await checkMessage(SERVER, "x".repeat(MAX_TEXT_CHARS), { fetchImpl });
  });
});

describe("checkMessage: input problems never reach the network", () => {
  const cases: [string, string, string, ApiErrorKind][] = [
    ["an empty message", SERVER, "", "empty-message"],
    ["a blank message", SERVER, " \n\t ", "empty-message"],
    ["a message that is too long", SERVER, "x".repeat(MAX_TEXT_CHARS + 1), "too-long"],
    ["an empty server address", "", "hello", "invalid-url"],
    ["the old placeholder address", "http://YOUR_COMPUTER_IP:8000", "hello", "invalid-url"],
    ["plain http to a public address", "http://example.com", "hello", "invalid-url"],
  ];
  for (const [name, server, text, kind] of cases) {
    it(`${name} -> ${kind}`, async () => {
      const { fetchImpl, calls } = fakeFetch(reply(200, GOOD));
      const error = await failureOf(checkMessage(server, text, { fetchImpl }));
      assert.equal(error.kind, kind);
      assert.equal(calls.length, 0);
    });
  }
});

describe("checkMessage: when the server or the network misbehaves", () => {
  it("reports an unreachable server as a network error", async () => {
    const { fetchImpl } = fakeFetch(new TypeError("Network request failed"));
    const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl }));
    assert.equal(error.kind, "network");
    assert.match(error.message, /Could not reach the server/);
  });

  const statuses: [number, RegExp][] = [
    [400, /rejected this message \(HTTP 400\)/],
    [404, /no \/check endpoint \(HTTP 404\)/],
    [413, /rejected this message \(HTTP 413\)/],
    [422, /rejected this message \(HTTP 422\)/],
    [429, /too many requests \(HTTP 429\)/],
    [500, /server had a problem \(HTTP 500\)/],
    [503, /server had a problem \(HTTP 503\)/],
    [302, /unexpected status \(HTTP 302\)/],
    [401, /unexpected status \(HTTP 401\)/],
  ];
  for (const [status, message] of statuses) {
    it(`explains HTTP ${status}`, async () => {
      const { fetchImpl } = fakeFetch(reply(status, GOOD));
      const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl }));
      assert.equal(error.kind, "http");
      assert.match(error.message, message);
    });
  }

  it("never shows text sent by the server", async () => {
    const secret = "Traceback (most recent call last): File /srv/app/api.py line 42 secret-token";
    const { fetchImpl } = fakeFetch(reply(500, { detail: secret }));
    const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl }));
    assert.doesNotMatch(error.message, /Traceback|secret|api\.py/);
  });

  it("rejects an answer that is not JSON", async () => {
    const { fetchImpl } = fakeFetch(reply(200, null, "<html>Welcome to nginx</html>"));
    const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl }));
    assert.equal(error.kind, "invalid-response");
  });

  const wrongShapes: unknown[] = [null, [], "spam", { label: "spam" }, { label: "maybe", spam_probability: 0.5 }, { label: "spam", spam_probability: 7 }];
  for (const body of wrongShapes) {
    it(`rejects an answer shaped like ${JSON.stringify(body)}`, async () => {
      const { fetchImpl } = fakeFetch(reply(200, body));
      const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl }));
      assert.equal(error.kind, "invalid-response");
    });
  }

  it("gives up when the server never answers (the call always settles)", async () => {
    const fetchImpl: HttpFetch = () => new Promise<HttpResponse>(() => {}); // never settles, ignores the abort signal
    const started = Date.now();
    const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl, timeoutMs: 30 }));
    assert.equal(error.kind, "timeout");
    assert.match(error.message, /did not answer/);
    assert.ok(Date.now() - started < 1000);
  });

  it("aborts the request when the timeout fires", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: HttpFetch = (_url, init) =>
      new Promise<HttpResponse>((_resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl, timeoutMs: 30 }));
    assert.equal(error.kind, "timeout"); // not "network", although the aborted fetch also failed
    assert.equal(signal?.aborted, true);
  });

  it("gives up when the answer starts but the body never finishes", async () => {
    const stalled: HttpResponse = { ok: true, status: 200, json: () => new Promise<unknown>(() => {}) };
    const { fetchImpl } = fakeFetch(stalled);
    const error = await failureOf(checkMessage(SERVER, "hello", { fetchImpl, timeoutMs: 30 }));
    assert.equal(error.kind, "timeout");
  });

  it("a late failure after the timeout does not become an unhandled rejection", async () => {
    let unhandled = 0;
    const count = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", count);
    try {
      const fetchImpl: HttpFetch = (_url, init) =>
        new Promise<HttpResponse>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => setTimeout(() => reject(new Error("late failure")), 10));
        });
      await failureOf(checkMessage(SERVER, "hello", { fetchImpl, timeoutMs: 20 }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(unhandled, 0);
    } finally {
      process.off("unhandledRejection", count);
    }
  });

  it("does not leave a timer running after a normal answer", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const before = timers();
    const { fetchImpl } = fakeFetch(reply(200, GOOD));
    await checkMessage(SERVER, "hello", { fetchImpl, timeoutMs: 60_000 });
    assert.equal(timers(), before); // a forgotten 60 s timer would keep the app's event loop busy
  });
});
