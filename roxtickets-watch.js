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
 */

const EVENTS = ['Nashville']; // add more event names here later, e.g. ['Nashville', 'Anaheim']

// Permissive on purpose — tighten once a real Pro Men listing shows the exact string.
const PRO_MEN_RE = /^mens pro$/i; // confirmed exact string
const FALLBACK_RE = /\bpro\b.*\bmens?\b|\bmens?\b.*\bpro\b/i; // loose net if the string ever changes
const EXCLUDE_RE = /double|relay|mixed|women/i;

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

let exitCode = 0;

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

    if (confirmed.length === 0 && fallbackOnly.length === 0 && available.length > 0) {
      // Something's listed for this event, just not the division we want.
      // Worth a quiet ping — the raw category names help refine PRO_MEN_RE.
      const names = [...new Set(available.map((t) => t.category_name))];
      console.log(`  categories present: ${names.join(', ')}`);
    }
  } catch (err) {
    console.error(`${eventName}: FAILED — ${err.message}`);
    await push({ title: `roxtickets-watch error (${eventName})`, body: err.message, priority: 'high' }).catch(() => {});
    exitCode = 1;
  }
}

process.exit(exitCode);
