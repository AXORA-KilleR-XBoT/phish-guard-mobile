# Phish Guard Mobile

A small mobile app (Expo, React Native, TypeScript) that sends one message to a separately running
Phish Guard API (the `phish-guard` project, which lives in its own repository) and shows the spam
score that the API returns.

> **Safety note:** this is an educational demo. The model behind it is an SMS spam classifier, not a
> complete phishing detector. A low score does **not** mean that a message or a link is safe, and
> the app never says so. Do not rely on it to decide whether to open a link or share personal data.

<!-- Placeholders to replace before publishing (search for YOUR):
     - YOUR_GITHUB_USERNAME in the badge below (remove the comment markers after the repository exists)
     - YOUR NAME in LICENSE (the Expo template's own copyright line stays)
     - after publishing phish-guard, link its name in the first paragraph to
       https://github.com/YOUR_GITHUB_USERNAME/phish-guard
[![CI](https://github.com/YOUR_GITHUB_USERNAME/phish-guard-mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_USERNAME/phish-guard-mobile/actions/workflows/ci.yml)
-->

## What problem it solves

Checking a suspicious text message should take a few seconds and should not require a laptop. The
app is the thin client: it takes the message, asks the API, validates the answer and explains it. All
machine learning stays in the API.

```text
Expo app (this repository) --POST /check, JSON--> Phish Guard API (FastAPI) --> scikit-learn model
```

| File | Purpose |
| --- | --- |
| `App.tsx` | The screen: address field, message field, result card, error messages. |
| `api.ts` | Address validation, the request with a timeout, and validation of the response. It imports nothing from React Native, so Node can test it directly. |
| `api.test.ts` | Unit tests for `api.ts`, run with Node's built-in test runner. |

## Features

- **Configurable server address.** Type it into the app, or preset it with `EXPO_PUBLIC_API_URL`
  (see below). There is no built-in address.
- **The address is checked before anything is sent.** Plain `http://` is accepted only for
  `localhost` and private-network addresses (`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `169.254.x`,
  `*.local`). Any other server must use `https://`, because `http://` sends the message as readable text.
- **The answer is checked too.** Only `{"label": "spam" | "ham", "spam_probability": 0..1}` is
  accepted. Anything else is reported as an unexpected answer.
- **Useful error messages** for: empty message, message over 10,000 characters, unreachable server,
  no answer within 8 seconds, HTTP errors (404, 422, 429, 5xx, ...) and malformed answers. Text sent
  by the server is never shown, so a misconfigured server cannot put its own messages (or error
  details) on the screen.
- **No stale results and no endless spinner.** Editing the address or the message clears the old
  result. The inputs are locked while a request runs, and the request always ends (answer, error or timeout).

## Prerequisites

- Node.js 22.18 or newer (22 LTS) and npm. The tests run TypeScript with Node's built-in support.
- A running Phish Guard API (Python 3.11 or newer; see the `phish-guard` project).
- To try it on a phone: the Expo Go app. Or use an Android emulator / iOS simulator.

## Setup and run

**1. Start the API.** In the `phish-guard` project folder (macOS / Linux):

```bash
python3 -m venv .venv && source .venv/bin/activate
python -m pip install -r requirements.txt
python download_data.py
python phishguard.py train --data data/sms.tsv --model model.joblib
uvicorn api:app --host 0.0.0.0 --port 8000
```

On Windows (PowerShell) the differences are `py -m venv .venv` and `.venv\Scripts\Activate.ps1`.
These Windows commands were not run while preparing this project.

`--host 0.0.0.0` lets other devices on your network reach the API, which is what a physical phone
needs. The API has **no login**, so use it only on a network you trust and stop it when you are done.
For an emulator or simulator on the same computer, `--host 127.0.0.1` is enough.

**2. Start the app.** In this folder:

```bash
npm ci
npx expo start
```

**3. Enter the server address in the app.** Which address works depends on where the app runs:

| Where the app runs | Server URL to type |
| --- | --- |
| Android emulator | `http://10.0.2.2:8000` (the emulator's name for your computer) |
| iOS simulator | `http://localhost:8000` |
| Physical phone | `http://<your computer's LAN IP>:8000`, on the same Wi-Fi as the computer |

On a phone, `localhost` means the phone itself, never your computer. Find your computer's LAN IP with
`ipconfig` (Windows), `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux). If it does not work,
first open `http://<that address>:8000/docs` in the phone's browser: if that page does not load,
the problem is the network or a firewall, not the app.

**Optional: preset the address.** Copy `.env.example` to `.env`, put your address in it, and start
with `npx expo start --clear`. The `--clear` matters: Metro caches the value, so a changed
address is ignored without it. `.env` is ignored by git.

## HTTP, HTTPS and hosted servers

- `http://` is fine for local development on a trusted network. It is unencrypted: anyone on that
  network can read the message. The app shows a reminder when the address starts with `http://`.
- A hosted API must be served over `https://`; the app refuses plain `http://` to public addresses.
  The Phish Guard API itself does not do TLS: put it behind a reverse proxy that does.
- Android and iOS restrict plain-HTTP traffic in standalone (store) builds by default. The `http://`
  examples above are meant for development with Expo Go. This was not tested here; the app has not
  been built as a standalone app.

## Tests and checks

```bash
npm run typecheck                         # TypeScript, strict mode
npm test                                  # unit tests for api.ts (Node's test runner)
npx expo export --platform android        # bundles the JavaScript; needs no emulator or phone
```

The same commands run in GitHub Actions (`.github/workflows/ci.yml`), with read-only repository
permissions and the actions pinned to full commit SHAs.

What the tests cover: address validation (including addresses that only look local, such as
`localhost.evil.com`), response validation, request details, HTTP errors, malformed answers,
network failures, timeouts and unhandled rejections.

What they do **not** cover: the React components, a real phone or emulator, and the app talking to the
real API. The API was tested on its own (see its README), but the app and the API have not been run
against each other as an automated end-to-end test.

## Security and privacy

- The message you type is sent to the server address you enter. Do not submit sensitive messages to a
  server you do not control. The app has no analytics and stores nothing on the device.
- There is no authentication, so anyone who can reach your API can use it.
- On 2026-10-13, `npm audit` (run on the committed lock file) reported 23 findings: 16 high, 7 moderate,
  none critical. They trace back to three advisories in packages that Expo's command line tools and the
  Metro bundler depend on: `braces` (denial of service with deeply nested glob patterns), `node-forge`
  (an RSA signature check) and `uuid` (a buffer bounds check). The app's own code uses none of them
  directly. `npm audit fix --force` would move Expo to version 44, a major downgrade, so it was not
  applied. Re-run `npm audit` before you publish, and watch for Expo patch releases.

## Limitations and roadmap

- Component tests for the screen (React Native Testing Library) and an end-to-end run on an
  emulator against the real API.
- Remember the last server address on the device (this needs a storage library, so it was left out).
- Accessibility review with a screen reader, and right-to-left layout.
- A production build (for example with EAS) over HTTPS.
- Automated dependency updates (Dependabot) and a decision about the `npm audit` findings above.

## Credits

Started from the Expo project template: the icons in `assets/`, `index.ts`, `app.json` and
`tsconfig.json` derive from it (MIT, 650 Industries, Inc.). See `LICENSE`. Replace the template
icons with your own artwork if you want a distinctive app.
