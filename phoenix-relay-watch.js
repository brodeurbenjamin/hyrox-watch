/**
 * phoenix-relay-watch — official HYROX shop monitor
 * Target: InBody HYROX Phoenix (25-28 Feb 2027), Men's Relay
 *
 * Verified against usa.hyrox.com on 13 Oct 2026:
 *   The US shop moved to a new layout at /tickets/<eventId>. You drill
 *   Category -> Class -> Gender (Relay -> Open -> Men) and each ticket renders
 *   as a button labelled "Add 1 <ticket name> to the cart". A ticket you can't
 *   buy has that button `disabled` and an "Unavailable" badge. That disabled
 *   flag is the signal: enabled button = buyable.
 *
 *   Men's Relay is a single wave: "HYROX MENS RELAY | Friday" (Fri 26 Feb),
 *   $447.30 for a team of 4. A CHARITY version may appear too; it counts.
 *
 * Alerts:
 *   URGENT — a Men's Relay ticket button is enabled.
 *   HIGH   — no Men's Relay ticket on the page at all (layout changed).
 */

import { chromium } from 'playwright';

const SHOP = 'https://usa.hyrox.com/tickets/6a69b84e9721d942e89da474';
const LABEL = "HYROX Phoenix - Men's Relay";
const DRILL = ['Relay', 'Open', 'Men'];
// Matches "HYROX MENS RELAY | Friday" and "CHARITY | HYROX MENS RELAY | ...",
// not "TEAM MEMBER" seats, which are added automatically with the team ticket.
const NAME_RE = /^(CHARITY[^|]*\| )?HYROX MEN'?S RELAY \|/i;

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

// [{ name, disabled }] for every ticket card on screen.
export async function readTickets(page) {
  return page.$$eval('button[aria-label^="Add 1 "]', (els) =>
    els.map((b) => ({
      name: b.getAttribute('aria-label').replace(/^Add 1 /, '').replace(/ to the cart$/, ''),
      disabled: b.disabled,
    }))
  );
}

export function evaluate(tickets) {
  const relay = tickets.filter((t) => NAME_RE.test(t.name));
  const buyable = relay.filter((t) => !t.disabled);
  const tier = relay.length === 0 ? 'structure' : buyable.length > 0 ? 'urgent' : 'none';
  return { relay, buyable, tier };
}

async function run() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      locale: 'en-US',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    });
    await page.goto(SHOP, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await page.getByText('Just a moment', { exact: false }).count()) {
      throw new Error('Cloudflare challenge page - blocked');
    }
    for (const label of DRILL) {
      const opt = page.getByRole('button', { name: label, exact: true }).first();
      await opt.waitFor({ state: 'visible', timeout: 25000 });
      await opt.click();
      await page.waitForTimeout(1500);
    }
    await page.waitForSelector('button[aria-label^="Add 1 "]', { state: 'attached', timeout: 20000 }).catch(() => {});

    const tickets = await readTickets(page);
    const { relay, buyable, tier } = evaluate(tickets);
    for (const t of relay) console.log(`  ${t.disabled ? 'unavailable' : 'BUYABLE    '}  ${t.name}`);

    if (tier === 'urgent') {
      await push({
        title: LABEL,
        body: `Tickets are live:\n${buyable.map((t) => t.name).join('\n')}`,
        priority: 'urgent',
        click: SHOP,
      });
      console.log('notification sent (urgent)');
    } else if (tier === 'structure') {
      await push({
        title: 'hyrox-watch: Phoenix page changed',
        body: `No Men's Relay ticket found after clicking ${DRILL.join(' > ')}. The script needs updating.`,
        priority: 'high',
        click: SHOP,
      });
      console.log(`notification sent (structure changed); tickets seen: ${JSON.stringify(tickets)}`);
    } else {
      console.log("Men's Relay: unavailable");
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (err) => {
    console.error(`FAILED: ${err.message}`);
    await push({ title: 'hyrox-watch error (Phoenix)', body: String(err.message).slice(0, 400), priority: 'high' }).catch(() => {});
    process.exit(1);
  });
}
