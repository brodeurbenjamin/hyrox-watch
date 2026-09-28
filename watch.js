/**
 * hyrox-watch — official HYROX shop monitor
 * Target: FITNESS PARK HYROX PARIS (12-20 Dec 2026), Women's Open singles
 *
 * Verified against france.hyrox.com on 28 Sep 2026:
 *   The France shop is a Next.js app (different from the US shop). The full
 *   ticket list is embedded in the page as JSON in <script id="__NEXT_DATA__">,
 *   at props.pageProps.event.tickets. Every ticket type has an `active` flag,
 *   and HYROX deactivates a wave when it sells out, which removes it from the
 *   page entirely. Right now every athlete ticket is active=false and only
 *   Spectator tickets show.
 *
 *   Women's Open waves are tagged meta.competition_class_matching_key =
 *   "SOLO_OPEN_W" and named "HYROX WOMEN | <Day>, December <n> 2026".
 *   Five days: Sun 13, Wed 16, Thu 17, Fri 18, Sun 20 Dec. Each has a
 *   regular ticket and a CHARITY version (cheaper entry plus a fundraising
 *   commitment). Both count as a Women's Open spot.
 *
 * Alert tiers:
 *   URGENT — a Women's Open ticket is active, the shop shows "Singles", and
 *            after drilling Singles -> Open -> Women the ticket name is NOT
 *            preceded by a SOLD OUT badge. (The US shop left sold-out tickets
 *            switched on and only drew the badge client-side, so "active"
 *            alone isn't trusted.) Active but badged SOLD OUT = no alert.
 *   HIGH   — a Women's Open ticket is active but the page can't confirm it
 *            (Singles not showing, or the ticket name never renders). Go look.
 *   HIGH   — the page loaded but no Women's Open tickets exist in the data
 *            at all. Structure changed; the script needs updating.
 *
 * Still runs in a real browser (Playwright) because the site sits behind
 * Cloudflare, and a real browser is much less likely to get challenged from
 * GitHub's servers than a bare HTTP request.
 */

import { chromium } from 'playwright';

const CHECKOUT = 'https://france.hyrox.com/checkout/69f0c46d9a89dd2b2f8f9525';
const LABEL = "HYROX Paris - Women's Open";
const CLASS_KEY = 'SOLO_OPEN_W';
// Backup match in case the meta tag ever disappears.
const NAME_RE = /^(CHARITY \| )?HYROX WOMEN \|/i;

const NTFY_TOPIC = process.env.NTFY_TOPIC;
if (!NTFY_TOPIC) { console.error('NTFY_TOPIC not set.'); process.exit(1); }

function asciiHeader(s) {
  return String(s)
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

async function push({ title, body, priority = 'default', click }) {
  const headers = { Title: asciiHeader(title), Priority: priority };
  if (click) headers.Click = click;
  const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, { method: 'POST', headers, body });
  if (!res.ok) console.error(`ntfy responded ${res.status}`);
}

// "HYROX WOMEN | Sunday, December 13 2026" -> "Sunday, December 13"
function dayOf(name) {
  const part = name.split('|').pop().trim();
  return part.replace(/\s+\d{4}$/, '');
}

export function evaluate(tickets, singlesVisible) {
  const wo = tickets.filter(
    (t) => t?.meta?.competition_class_matching_key === CLASS_KEY || NAME_RE.test(t?.name || '')
  );
  const active = wo.filter((t) => t.active === true);
  let tier = 'none';
  if (wo.length === 0) tier = 'structure';
  else if (active.length > 0) tier = singlesVisible ? 'urgent' : 'possible';
  return { wo, active, tier };
}

// Click through Singles -> Open -> Women (each step optional, since the Paris
// labels can't be seen while everything is switched off), then classify each
// active ticket by the 60 characters rendered right before its name.
// indexOf that skips hits which are really the tail of "CHARITY | <name>".
function findName(body, name) {
  let from = 0;
  while (true) {
    const i = body.indexOf(name, from);
    if (i === -1) return -1;
    if (/^CHARITY/i.test(name) || !/CHARITY \| $/i.test(body.slice(Math.max(0, i - 10), i))) return i;
    from = i + 1;
  }
}

export async function checkBadges(page, active) {
  for (const label of ['Singles', 'Open', 'Women']) {
    const opt = page.getByText(label, { exact: true }).first();
    try {
      await opt.waitFor({ state: 'visible', timeout: 8000 });
      await opt.click();
      await page.waitForTimeout(1200);
    } catch {
      console.log(`  drill step "${label}" not found, continuing`);
    }
  }
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const buyable = [], soldOut = [], missing = [];
  for (const t of active) {
    const full = t.name.replace(/\s+/g, ' ');
    const short = full.split(',')[0]; // "HYROX WOMEN | Sunday"
    let idx = findName(body, full);
    if (idx === -1) idx = findName(body, short);
    if (idx === -1) { missing.push(t); continue; }
    // Only this ticket's own badge: cut the look-back window at the previous
    // ticket's price, so a SOLD OUT on the row above doesn't bleed in.
    let preceding = body.slice(Math.max(0, idx - 60), idx);
    // Boundary = a price or the year at the end of the previous ticket's name.
    const prices = [...preceding.matchAll(/[€$]\s?\d[\d.,]*|\d[\d.,]*\s?€|\b20\d\d\b/g)];
    if (prices.length) {
      const last = prices[prices.length - 1];
      preceding = preceding.slice(last.index + last[0].length);
    }
    (/SOLD OUT|AUSVERKAUFT|COMPLET|[EÉ]PUIS[EÉ]/i.test(preceding) ? soldOut : buyable).push(t);
  }
  return {
    buyable, soldOut, missing,
    toJSON() { return { buyable: buyable.map((t) => t.name), soldOut: soldOut.map((t) => t.name), missing: missing.map((t) => t.name) }; },
  };
}

async function run() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    });
    await page.goto(CHECKOUT, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#__NEXT_DATA__', { state: 'attached', timeout: 30000 });

    const tickets = await page.evaluate(() => {
      const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
      return d?.props?.pageProps?.event?.tickets ?? null;
    });
    if (!Array.isArray(tickets)) throw new Error('ticket list missing from page data - site structure changed');

    // Give the client a moment to render categories, then see what's shown.
    await page.waitForTimeout(3000);
    const bodyText = await page.evaluate(() => document.body.innerText);
    const singlesVisible = /\bSingles\b/.test(bodyText);

    let { wo, active, tier } = evaluate(tickets, singlesVisible);

    // The US shop kept sold-out tickets switched ON and only drew a SOLD OUT
    // badge after drilling Category -> Class -> Gender. If Paris ever does the
    // same, "active" alone would cry wolf. So when something is active, drill
    // in and read the badge in front of each ticket name.
    if (tier === 'urgent') {
      const verdict = await checkBadges(page, active);
      console.log(`badge check: ${JSON.stringify(verdict)}`);
      if (verdict.buyable.length > 0) {
        active = verdict.buyable;
      } else if (verdict.soldOut.length === active.length) {
        tier = 'none'; // every active one renders SOLD OUT: capacity-full, stay quiet
      } else {
        tier = 'possible'; // couldn't find them on screen: tell a human to look
      }
    }

    console.log(`tickets in data: ${tickets.length}, active: ${tickets.filter((t) => t.active).length}`);
    console.log(`Singles category visible: ${singlesVisible}`);
    for (const t of wo) console.log(`  ${t.active ? 'ACTIVE ' : 'off    '} EUR${t.price}  ${t.name}`);

    if (tier === 'urgent' || tier === 'possible') {
      const days = [...new Set(active.map((t) => dayOf(t.name) + (/^CHARITY/i.test(t.name) ? ' (charity)' : '')))];
      await push({
        title: tier === 'urgent' ? LABEL : `${LABEL} - possible`,
        body:
          (tier === 'urgent' ? 'Tickets are live:\n' : 'Marked active but the Singles category is not showing yet - check now:\n') +
          days.join('\n'),
        priority: tier === 'urgent' ? 'urgent' : 'high',
        click: CHECKOUT,
      });
      console.log(`notification sent (${tier})`);
    } else if (tier === 'structure') {
      await push({
        title: 'hyrox-watch: Paris page changed',
        body: "No Women's Open tickets found in the page data. The script needs updating.",
        priority: 'high',
        click: CHECKOUT,
      });
      console.log('notification sent (structure changed)');
    } else {
      console.log("Women's Open: all sold out");
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (err) => {
    console.error(`FAILED: ${err.message}`);
    await push({ title: 'hyrox-watch error (Paris)', body: String(err.message).slice(0, 400), priority: 'high' }).catch(() => {});
    process.exit(1);
  });
}
