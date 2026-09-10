/**
 * hyrox-watch — HYROX Nashville Pro Men monitor (GitHub Actions edition)
 *
 * Stateless by design. One run = one check. If the ticket is available it
 * pushes a notification; if it's still sold out it prints and exits 0. Any
 * error exits non-zero so GitHub's failure emails act as the heartbeat.
 *
 * Verified 10 Sep 2026 against Nashville (sold out) vs Salt Lake City (on
 * sale). vivenu's public API exposes no inventory — Nashville's Pro Men entry
 * is byte-identical in shape to Salt Lake's buyable one, active:true and no
 * amount/sold/available. The SOLD OUT badge is computed client-side after you
 * drill Category -> Class -> Gender, and firing zero network requests. So the
 * rendered UI is the only honest signal, and that needs a real browser.
 *
 * Ground truth captured:
 *   Nashville  "SOLD OUT HYROX PRO MEN | Friday ... $207.68"
 *   Salt Lake  "HYROX PRO MEN | Friday ... $197.03" + quantity stepper
 */
 
import { chromium } from 'playwright';
 
const CHECKOUT = 'https://usa.hyrox.com/checkout/69d5351836e6061602da463d';
const TICKET_NAME = 'HYROX PRO MEN | Friday';
const NTFY_TOPIC = process.env.NTFY_TOPIC;
 
if (!NTFY_TOPIC) {
  console.error('NTFY_TOPIC not set — add it as a repository secret.');
  process.exit(1);
}
 
const browser = await chromium.launch();
let exitCode = 0;
 
try {
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  const page = await ctx.newPage();
 
  await page.goto(CHECKOUT, { waitUntil: 'networkidle', timeout: 60000 });
 
  if (await page.getByText('Just a moment', { exact: false }).count()) {
    throw new Error('Cloudflare challenge page — blocked');
  }
 
  // Cascading selector. exact:true matters: "Singles" would otherwise also
  // match the "FLEX SINGLES NASHVILLE" add-on.
  for (const label of ['Singles', 'Pro', 'Men']) {
    const opt = page.getByText(label, { exact: true }).first();
    await opt.waitFor({ state: 'visible', timeout: 25000 });
    await opt.click();
    await page.waitForTimeout(1200);
  }
 
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
 
  if (!body.includes(TICKET_NAME)) {
    throw new Error(`"${TICKET_NAME}" not on page — selector flow or naming changed`);
  }
 
  // Only inspect the 60 chars immediately before the name. The Charity Pro
  // Men ticket sits directly below and is also sold out, so a page-wide
  // search for "SOLD OUT" would report unavailable forever.
  const idx = body.indexOf(TICKET_NAME);
  const preceding = body.slice(Math.max(0, idx - 60), idx);
  const available = !/SOLD OUT/i.test(preceding);
  const price = (body.slice(idx, idx + 400).match(/\$[\d,]+\.\d{2}/) || [null])[0];
 
  console.log(`available=${available} price=${price ?? 'n/a'}`);
 
  if (available) {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST',
      headers: {
        Title: 'HYROX Nashville - PRO MEN AVAILABLE',
        Priority: 'urgent',
        Click: CHECKOUT,
      },
      body: `${TICKET_NAME} is buyable${price ? ` at ${price}` : ''}. Go now.`,
    });
    if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
    console.log('notification sent');
  }
} catch (err) {
  console.error(`CHECK FAILED: ${err.message}`);
  // Best-effort heads-up; GitHub's failure email is the real backstop.
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: 'hyrox-watch error', Priority: 'default' },
    body: err.message,
  }).catch(() => {});
  exitCode = 1;
} finally {
  await browser.close();
}
 
process.exit(exitCode);
 
