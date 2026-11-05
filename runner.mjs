#!/usr/bin/env node
import { OpenRouter } from '@openrouter/sdk';
const [url, ...caseParts] = process.argv.slice(2);
const testCase = caseParts.join(' ').trim();
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.AI_MODEL || 'google/gemma-4-31b-it:free';
const maxSteps = Number(process.env.MAX_STEPS || 15);

if (!url || !testCase) {
  console.error('Usage: npm run test-case -- <url> "<plain-English test case>"');
  process.exit(2);
}
if (!apiKey) {
  console.error('FAIL: OPENROUTER_API_KEY is required. Set it in the environment; never put it in the test case.');
  process.exit(2);
}
const openrouter = new OpenRouter({ apiKey });
const { chromium } = await import('playwright');
try {
  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
} catch {
  console.error(`FAIL: Invalid URL: ${url}`);
  process.exit(2);
}
if (!Number.isInteger(maxSteps) || maxSteps < 1) {
  console.error('FAIL: MAX_STEPS must be a positive integer.');
  process.exit(2);
}

const tools = `Allowed actions: click, fill, select, assert_visible, assert_text, assert_url, done, fail.
Each response must be exactly one JSON object with keys: action and optional by, name, value, text, url, reason.
For by use role, label, placeholder, text, or css. Prefer accessible roles/labels and exact visible text.
Use one action per response, then re-evaluate the updated page. A passing result requires explicit assertion(s) that prove the requested outcome.
Do not invent credentials, solve CAPTCHAs, purchase, book, send messages, publish, or delete data. For secrets use literal placeholders like $ENV{CUSTOMER_PASSWORD}; never ask for or expose their values in model output. Stop if a required secret is unavailable or an action would have a consequential external effect.`;

async function askModel(messages) {
  const response = await openrouter.chat.send({
    chatRequest: {
      model,
      temperature: 0,
      responseFormat: { type: 'json_object' },
      messages
    }
  }, {
    timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 60000)
  });
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Model API returned no message content.');
  return JSON.parse(content);
}

function locator(page, by, name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('The model returned an empty locator.');
  switch (by) {
    case 'role': {
      const split = name.indexOf(':');
      if (split < 1) throw new Error('Role locator must be "role: accessible name".');
      return page.getByRole(name.slice(0, split).trim(), { name: name.slice(split + 1).trim(), exact: true });
    }
    case 'label': return page.getByLabel(name, { exact: true });
    case 'placeholder': return page.getByPlaceholder(name, { exact: true });
    case 'text': return page.getByText(name, { exact: true });
    case 'css': return page.locator(name);
    default: throw new Error(`Unsupported locator type: ${by}`);
  }
}

function expandEnv(value) {
  if (typeof value !== 'string') throw new Error('Expected a string value.');
  return value.replace(/\$ENV\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (process.env[key] == null) throw new Error(`Required environment variable ${key} is not set.`);
    return process.env[key];
  });
}

let browser;
const evidence = [];
let passed = false;
let failure = '';
try {
  browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const history = [];
  for (let step = 1; step <= maxSteps; step++) {
    const snapshot = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    const controls = await page.locator('input,textarea,select,button,a,[role=button],[role=link],[role=checkbox],[role=radio]').evaluateAll(els => els
      .filter(e => e.getClientRects().length)
      .slice(0, 100)
      .map(e => ({ tag: e.tagName.toLowerCase(), type: e.getAttribute('type'), role: e.getAttribute('role'), label: e.getAttribute('aria-label'), text: (e.innerText || e.value || e.getAttribute('placeholder') || '').trim().slice(0, 120) })));
    const plan = await askModel([
      { role: 'system', content: `You are a cautious browser test planner. Translate the given test case into the next single browser action based only on page evidence. ${tools}` },
      { role: 'user', content: JSON.stringify({ target: url, testCase, step, priorActions: history, currentUrl: page.url(), visibleText: snapshot.slice(0, 10000), visibleControls: controls }) }
    ]);
    if (!plan || typeof plan.action !== 'string') throw new Error('Model returned no action.');
    const action = plan.action.toLowerCase();
    if (action === 'done') { passed = history.some(x => x.startsWith('PASS assertion:')); break; }
    if (action === 'fail') throw new Error(plan.reason || 'The model could not safely complete the test.');
    if (action === 'click') {
      const target = locator(page, plan.by, plan.name);
      if (await target.count() !== 1) throw new Error(`Click locator was ambiguous or missing: ${plan.by} ${plan.name}`);
      await target.click({ timeout: 8000 }); history.push(`Clicked ${plan.by} ${plan.name}`);
    } else if (action === 'fill') {
      const target = locator(page, plan.by, plan.name);
      if (await target.count() !== 1) throw new Error(`Fill locator was ambiguous or missing: ${plan.by} ${plan.name}`);
      await target.fill(expandEnv(plan.value), { timeout: 8000 }); history.push(`Filled ${plan.by} ${plan.name} (value redacted)`);
    } else if (action === 'select') {
      const target = locator(page, plan.by, plan.name);
      if (await target.count() !== 1) throw new Error(`Select locator was ambiguous or missing: ${plan.by} ${plan.name}`);
      await target.selectOption({ label: plan.value }, { timeout: 8000 }); history.push(`Selected option in ${plan.by} ${plan.name}`);
    } else if (action === 'assert_visible') {
      const target = locator(page, plan.by, plan.name);
      if (await target.count() !== 1 || !(await target.isVisible())) throw new Error(`Expected visible element not found: ${plan.by} ${plan.name}`);
      const proof = `PASS assertion: visible ${plan.by} ${plan.name}`; history.push(proof); evidence.push(proof);
    } else if (action === 'assert_text') {
      const needle = String(plan.text ?? '');
      if (!needle || !snapshot.toLowerCase().includes(needle.toLowerCase())) throw new Error(`Expected page text was not found: ${needle}`);
      const proof = `PASS assertion: page contains "${needle}"`; history.push(proof); evidence.push(proof);
    } else if (action === 'assert_url') {
      if (!new RegExp(plan.url).test(page.url())) throw new Error(`URL assertion failed: ${page.url()} did not match ${plan.url}`);
      const proof = `PASS assertion: URL matched ${plan.url}`; history.push(proof); evidence.push(proof);
    } else {
      throw new Error(`Unsupported action: ${plan.action}`);
    }
    await page.waitForTimeout(350);
  }
  if (!passed && !failure) failure = history.length >= maxSteps ? `Stopped at MAX_STEPS=${maxSteps} without a completed assertion.` : 'The model ended without a passing assertion.';
} catch (error) {
  failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  if (browser) await browser.close();
}

const result = { result: passed ? 'PASS' : 'FAIL', testCase, url, evidence, ...(passed ? {} : { reason: failure || 'No explicit passing assertion.' }) };
console.log(JSON.stringify(result, null, 2));
process.exitCode = passed ? 0 : 1;
