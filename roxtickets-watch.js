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
 * TARGETS (13 Oct 2026), configured per event in WATCH below:
 *   Paris   — Women's Open or Women's Pro, race days 16-21 Dec only (in Paris
 *             15-21 Dec; the 15th is arrival day).
 *   Phoenix — Men's Relay, any day.
 *
 * Category naming seen in real data: "Mens Pro", "Mens Open", "Mixed
 * Doubles", and for women "Women Open" (no s; seen in state.json 13 Oct).
 * Paris `target` accepts "Women"/"Womens" + "Open"/"Pro". `fallback` is a wider
 * net; a fallback hit alerts one priority lower and quotes the real name.
 *
 * DATES — each listing has `day`, e.g. "19-11-2026 THU". Listings outside the
 * trip window never trigger the urgent alert (they still count toward the
 * activity ping). A listing with no readable day is treated as in-window so
 * a format change can't silently hide a real ticket.
 *
 * EVENT NAME — "Paris" is assumed from how Nashville was named ("Nashville").
 * If the app labels it differently, this will quietly report 0 listings
 * forever. Check the heartbeat: if another source shows Paris listings and
 * the heartbeat still says 0, the event name is wrong.
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
 *   1. Activity alert — fires once when an event's total available count
 *      CHANGES, not on every run while a listing sits there. Stops the
 *      10-minute-forever spam the Womens Open alert deliberately still does.
 *   2. Daily heartbeat — fires once per UTC day regardless of activity, so
 *      you get a positive "still alive" signal without 144 pings a day.
 */

// What to watch per event. `target` = urgent alert; `fallback` (minus
// `exclude`) = "possible" alert; `from`/`to` = race-day window (null = any day).
const WATCH = {
  Paris: {
    label: "Women's Open/Pro",
    target: /^wom[ae]n'?s? (open|pro)$/i, // "Women Open" confirmed 13 Oct
    fallback: /\bwom[ae]n'?s?\b.*\b(open|pro)\b|\b(open|pro)\b.*\bwom[ae]n'?s?\b/i,
    exclude: /double|relay|mixed|adaptive|team|\bmen'?s?\b/i,
    from: '2026-12-16', // trip is 15-21 Dec, 15th is arrival day
    to: '2026-12-21',
  },
  // Event name and category string are pattern-based guesses ("Phoenix",
  // "Mens Relay"), not yet seen in real data. Check the heartbeat lists
  // Phoenix with a sensible count once listings exist.
  Phoenix: {
    label: "Men's Relay",
    target: /^men'?s? relay$/i,
    fallback: /\bmen'?s?\b.*\brelay\b|\brelay\b.*\bmen'?s?\b/i,
    exclude: /wom[ae]n|mixed|double|corporate/i,
    from: null,
    to: null,
  },
};
const EVENTS = Object.keys(WATCH);

// "19-11-2026 THU" -> "2026-11-19"; null if unreadable.
export function listingDate(t) {
  const m = String(t?.day || '').match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
export function inWindow(t, cfg) {
  const d = listingDate(t);
  if (d === null || !cfg.from) return true;
  return d >= cfg.from && d <= cfg.to;
}
function dayLabel(t) {
  const d = listingDate(t);
  if (!d) return 'day unknown';
  const dow = String(t.day).split(' ')[1] || '';
  return `${dow} ${Number(d.slice(8))} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7))]}`.trim();
}
export function classify(available, cfg) {
  const athletes = available.filter((t) => !t.spectator);
  const confirmed = athletes.filter((t) => cfg.target.test(t.category_name));
  const fallback = athletes.filter(
    (t) => !confirmed.includes(t) && cfg.fallback.test(t.category_name) && !cfg.exclude.test(t.category_name)
  );
  return {
    confirmed: confirmed.filter((t) => inWindow(t, cfg)),
    fallback: fallback.filter((t) => inWindow(t, cfg)),
    outOfWindow: [...confirmed, ...fallback].filter((t) => !inWindow(t, cfg)),
  };
}

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
  for (const t of listings) {
    const k = `${t.category_name} (${dayLabel(t)})`;
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, n]) => `${name} x${n}`)
    .join(', ');
}

const state = await readState();
if (!state.events) state.events = {};
// Drop events no longer watched (e.g. old Nashville entry) so the heartbeat
// and state file only reflect current targets.
for (const k of Object.keys(state.events)) if (!EVENTS.includes(k)) delete state.events[k];

let exitCode = 0;
const today = new Date().toISOString().slice(0, 10); // UTC date, e.g. "2026-09-16"
const summaryLines = [];

for (const eventName of EVENTS) {
  try {
    const listings = await fetchListings(eventName);
    const available = listings.filter((t) => t.available_for === 'available');

    const cfg = WATCH[eventName];
    const { confirmed, fallback: fallbackOnly, outOfWindow } = classify(available, cfg);

    console.log(
      `${eventName}: ${available.length} available listing(s) total, ${confirmed.length} ${cfg.label}${cfg.from ? ' in trip window' : ''}, ${fallbackOnly.length} fallback match, ${outOfWindow.length} target-division outside window`
    );

    // Full dump for visibility — every listing regardless of category. Log only,
    // never pushed as a notification. created_by (seller's real name) is
    // deliberately omitted — that's someone else's personal data, not needed
    // to see what's for sale.
    if (listings.length > 0) {
      console.log(`  all listings for ${eventName}:`);
      for (const t of listings) {
        console.log(
          `    [${t.ticket_id}] ${t.category_name.padEnd(20)} ${dayLabel(t).padEnd(11)} $${t.total}` +
            ` status=${t.available_for}${t.charity_ticket ? ' charity' : ''}${t.is_discounted ? ' discounted' : ''}`
        );
      }
    } else {
      console.log(`  no listings at all for ${eventName}`);
    }

    if (confirmed.length > 0) {
      const cheapest = confirmed.reduce((a, b) => (a.total < b.total ? a : b));
      await push({
        title: `${eventName} - ${cheapest.category_name} listing on Hybrid Tickets`,
        body:
          confirmed.map((t) => `${t.category_name}, ${dayLabel(t)}: $${t.total}`).join('\n') +
          `\nOpen the app to buy.`,
        priority: 'urgent',
      });
      console.log('notification sent (confirmed match)');
    }

    if (fallbackOnly.length > 0) {
      const cheapest = fallbackOnly.reduce((a, b) => (a.total < b.total ? a : b));
      await push({
        title: `${eventName} - possible ${cfg.label} listing`,
        body:
          `Category name isn't an exact match for ${cfg.label}, but looks close: ` +
          `"${cheapest.category_name}" (${dayLabel(cheapest)}) at $${cheapest.total}. Check the app.`,
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
