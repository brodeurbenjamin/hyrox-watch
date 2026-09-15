/**
 * roxtickets-watch — Hybrid Tickets (roxtickets.app) monitor
 *
 * Unlike the HYROX/vivenu checker, this one hits a real JSON API directly —
 * no browser needed. Captured via mitmproxy on 15 Sep 2026:
 *
 *   GET https://roxtickets.app/api/tickets/getTickets?event=["<EventName>"]&my_tickets=0
 *   Authorization: Bearer <JWT>
 *
 * Each entry in `ticketData` is one individual seller's listing (this is a
 * peer marketplace, not an inventory feed) with category, price, and status.
 *
 * CONFIRMED — a Pro Men listing on roxtickets.app uses:
 *   category_type: "mens", category_name: "Mens Pro"
 * (captured 15 Sep 2026 from a real Men's Pro listing response). PRO_MEN_RE
 * matches that exact string. FALLBACK_RE stays loose, in case HYROX or the
 * app ever renames the category — a fallback hit still alerts, just at a
 * lower priority so an unexpected string doesn't masquerade as confirmed.
 *
 * TOKEN — the captured JWT has no `exp` claim, so I can't tell you how long
 * it lasts. It may be a long-lived session or it may die whenever the app
 * decides. On a 401 this script says so explicitly rather than reporting
 * "no tickets" — re-run the mitmproxy capture and update the ROX_TOKEN
 * secret if that happens.
 *
 * PRIVACY — each listing includes the seller's real name (`created_by`).
 * That belongs to them, not to this monitor. Deliberately never logged,
 * never pushed in a notification, never written anywhere.
 *
 * STATE — unlike the HYROX checker, this one needs memory: an "activity"
 * alert only means something if we know what the count was last time. State
 * lives in ./state.json, committed back to the repo by the workflow after
 * each run (see roxtickets-watch.yml). Two things use it:
 *   1. Activity alert — fires once when Nashville's total available count
 *      CHANGES, not on every run while a listing sits there. Stops the
 *      10-minute-forever spam the Pro Men alert deliberately still does.
 *   2. Daily heartbeat — fires once per UTC day regardless of activity, so
 *      you get a positive "still alive" signal without 144 pings a day.
 */

const EVENTS = ['Nashville']; // add more event names here later, e.g. ['Nashville', 'Anaheim']

const PRO_MEN_RE = /^mens pro$/i; // confirmed exact string
const FALLBACK_RE = /\bpro\b.*\bmens?\b|\bmens?\b.*\bpro\b/i; // loose net if the string ever changes
const EXCLUDE_RE = /double|relay|mixed|women/i;

const STATE_FILE = './state.json';

const NTFY_TOPIC = process.env.NTFY_TOPIC;
const ROX_TOKEN = process.env.ROX_TOKEN;

if (!NTFY_TOPIC) { console.error('NTFY_TOPIC not set.'); process.exit(1); }
if (!ROX_TOKEN) { console.error('ROX_TOKEN not set.'); process.exit(1); }

function asciiHeader(s) {
  return String(s)
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

async function push({ title, body, priority = 'default' }) {
  return fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: asciiHeader(title), Priority: priority },
    body,
  });
}

async function fetchListings(eventName) {
  const url = `https://roxtickets.app/api/tickets/getTickets?event=${encodeURIComponent(JSON.stringify([eventName]))}&my_tickets=0`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${ROX_TOKEN}`,
      'User-Agent': 'roxtickets-watch/1.0 (personal listing monitor)',
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`AUTH FAILED (${res.status}) — token likely expired. Re-capture and update ROX_TOKEN.`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for event=${eventName}`);

  const body = await res.json();
  if (!Array.isArray(body.ticketData)) throw new Error('response shape changed — no ticketData array');
  return body.ticketData;
}

async function readState() {
  try {
    const fs = await import('fs/promises');
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { events: {}, lastHeartbeat: null };
  }
}

async function writeState(state) {
  const fs = await import('fs/promises');
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function categoryBreakdown(listings) {
  const counts = {};
  for (const t of listings) counts[t.category_name] = (counts[t.category_name] || 0) + 1;
  return Object.entries(counts)
    .map(([name, n]) => `${name} x${n}`)
    .join(', ');
}

const state = await readState();
if (!state.events) state.events = {};

let exitCode = 0;
const today = new Date().toISOString().slice(0, 10); // UTC date, e.g. "2026-09-16"
const summaryLines = [];

for (const eventName of EVENTS) {
  try {
    const listings = await fetchListings(eventName);
    const available = listings.filter((t) => t.available_for === 'available');

    const confirmed = available.filter((t) => PRO_MEN_RE.test(t.category_name) && !EXCLUDE_RE.test(t.category_name));
    const fallbackOnly = available.filter(
      (t) => !confirmed.includes(t) && FALLBACK_RE.test(t.category_name) && !EXCLUDE_RE.test(t.category_name)
    );

    console.log(
      `${eventName}: ${available.length} available listing(s) total, ${confirmed.length} confirmed Pro Men, ${fallbackOnly.length} fallback match`
    );

    // Full dump for visibility — every listing regardless of category. Log only,
    // never pushed as a notification. created_by (seller's real name) is
    // deliberately omitted — that's someone else's personal data, not needed
    // to see what's for sale.
    if (listings.length > 0) {
      console.log(`  all listings for ${eventName}:`);
      for (const t of listings) {
        console.log(
          `    [${t.ticket_id}] ${t.category_name.padEnd(20)} $${t.total}` +
            ` status=${t.available_for}${t.charity_ticket ? ' charity' : ''}${t.is_discounted ? ' discounted' : ''}`
        );
      }
    } else {
      console.log(`  no listings at all for ${eventName}`);
    }

    if (confirmed.length > 0) {
      const cheapest = confirmed.reduce((a, b) => (a.total < b.total ? a : b));
      await push({
        title: `${eventName} - MENS PRO listing found on Hybrid Tickets`,
        body: `${confirmed.length} listing(s). Cheapest: $${cheapest.total} total (ticket ${cheapest.ticket_id}).\nOpen the app to buy.`,
        priority: 'urgent',
      });
      console.log('notification sent (confirmed match)');
    }

    if (fallbackOnly.length > 0) {
      const cheapest = fallbackOnly.reduce((a, b) => (a.total < b.total ? a : b));
      await push({
        title: `${eventName} - possible Pro Men listing (unconfirmed category)`,
        body:
          `Category name doesn't match the known "Mens Pro" string, but looks close: ` +
          `"${cheapest.category_name}" at $${cheapest.total}. Check the app.`,
        priority: 'high',
      });
      console.log('notification sent (fallback match — verify category name)');
    }

    // Activity alert — fires only when the total available count for this
    // event CHANGES from last run. Not on every run while it sits non-zero,
    // otherwise this becomes the every-10-minutes spam we're avoiding.
    const prevCount = state.events[eventName]?.available ?? null;
    if (prevCount !== available.length) {
      const breakdown = available.length > 0 ? categoryBreakdown(available) : '(none)';
      const direction = prevCount === null ? 'baseline' : available.length > prevCount ? 'increased' : 'decreased';
      console.log(`  activity: ${prevCount ?? 'n/a'} -> ${available.length} (${direction})`);
      // Skip the very first-ever run (prevCount === null) — that's just
      // establishing the baseline, not a real change worth a ping.
      if (prevCount !== null) {
        await push({
          title: `${eventName} - listing activity on Hybrid Tickets`,
          body: `Available listings ${direction}: ${prevCount} -> ${available.length}.\n${breakdown}`,
          priority: 'default',
        });
        console.log('notification sent (activity change)');
      }
    }

    state.events[eventName] = { available: available.length, categories: categoryBreakdown(available) };
    summaryLines.push(`${eventName}: ${available.length} available (${categoryBreakdown(available) || 'none'})`);
  } catch (err) {
    console.error(`${eventName}: FAILED — ${err.message}`);
    await push({ title: `roxtickets-watch error (${eventName})`, body: err.message, priority: 'high' }).catch(() => {});
    exitCode = 1;
  }
}

// Daily heartbeat — once per UTC calendar day, regardless of activity.
// This is the "yes, it's still running" signal. A missing heartbeat for a
// day means something broke — check the Actions tab.
if (state.lastHeartbeat !== today && exitCode === 0) {
  await push({
    title: 'roxtickets-watch heartbeat',
    body: `Still checking every 10 min.\n${summaryLines.join('\n')}`,
    priority: 'min',
  });
  state.lastHeartbeat = today;
  console.log('heartbeat sent');
}

await writeState(state);
process.exit(exitCode);
