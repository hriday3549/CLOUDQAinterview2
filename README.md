# Plain-English Browser Tests

A small CLI that asks an AI model to turn a natural-language test into grounded browser actions, executes one action at a time with Playwright, and reports `PASS` only after an explicit page assertion succeeds. It is not tied to a particular site or DOM structure.

## Setup and run

Requires Node.js 20+, an OpenRouter API key, and Playwright's Chromium browser. The default model is `google/gemma-4-31b-it:free`; set `AI_MODEL` to use another OpenRouter model.

```powershell
npm install
npx playwright install chromium
$env:OPENROUTER_API_KEY = "your-key"
npm run test-case -- "https://example.com" "Verify that the page contains the text Example Domain"
```

PHPTravels demo page example:

```powershell
npm run test-case -- "https://phptravels.com/demo" "Verify the Get your demo access form is shown"
```

On Windows PowerShell use `$env:OPENROUTER_API_KEY="..."` for the current terminal session. Optional settings: `AI_MODEL`, `MAX_STEPS` (default 15), `MODEL_TIMEOUT_MS` (default 60000), and `HEADLESS=false` to watch the browser. The URL must use HTTP or HTTPS.

For credentials, use environment placeholders in the test case, such as `fill the password with $ENV{CUSTOMER_PASSWORD}`. The runner expands placeholders only during local execution and redacts filled values from its action history. Do not put secrets directly in the test case: the test case and visible page text are sent to the configured model provider.

## What it can do

The model sees visible page text and a short inventory of visible controls, then chooses one action using accessible role, label, placeholder, visible text, or a CSS locator. The page is re-read after every action, so navigation and dynamically revealed controls can be handled. Output is JSON with `PASS`/`FAIL`, assertion evidence, and a failure reason.

The action set is intentionally small. It can click, fill, select, and assert visibility, text, or URL. It will not solve CAPTCHAs, purchase, book, send messages, publish, or delete data. Keep test cases and target sites authorized, use synthetic test data, and review workflows before running them. This is a starter tool; AI-generated locators and conclusions can be wrong, so use it as a test aid rather than a substitute for review.
