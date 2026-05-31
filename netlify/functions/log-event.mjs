// Saumya — log-event endpoint
// Tasker POSTs here when geofence fires (works even when phone locked / Chrome closed).
import { getStore } from "@netlify/blobs";

const VALID_EVENTS = new Set([
  'arrived_clinic', 'left_clinic',
  'arrived_home',   'left_home',
  'class_start',    'class_end',
  'woke_up'
]);

// Arrivals: the FIRST one of the day is the truth (whichever sensor — WiFi or
//   geofence — fired first). Later duplicates the same day are ignored.
// Departures: the LAST one of the day is the truth (a real 8pm leave should
//   overwrite an earlier parking-lot blip). We replace the day's stored entry.
const ARRIVAL_EVENTS   = new Set(['arrived_clinic', 'arrived_home', 'woke_up', 'class_start']);
const DEPARTURE_EVENTS = new Set(['left_clinic', 'left_home', 'class_end']);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDateKey = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
const istHMS     = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19).replace(/:/g, '');

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const SECRET = process.env.SAUMYA_SECRET;
  if (!SECRET) return new Response("Server misconfigured: SAUMYA_SECRET not set", { status: 500 });

  let body;
  try { body = await req.json(); }
  catch { return new Response("Bad JSON", { status: 400 }); }

  const { event, ts, secret } = body || {};
  if (secret !== SECRET) return new Response("Unauthorized", { status: 401 });
  if (!event || !VALID_EVENTS.has(event)) return new Response(`Invalid event: ${event}`, { status: 400 });

  const now = Date.now();
  const timestamp = Number(ts) || now;
  if (timestamp > now + 60_000 || timestamp < now - 24 * 60 * 60 * 1000) {
    return new Response(`Timestamp out of range: ${timestamp}`, { status: 400 });
  }

  const store = getStore("saumya-events");
  const dateKey = istDateKey(timestamp);

  // --- Dedup against events already stored for this IST day ---
  // We scan today's blobs for the same event type and decide whether to write.
  try {
    const { blobs } = await store.list({ prefix: dateKey + "/" });
    const sameType = [];
    for (const b of (blobs || [])) {
      // key format: <date>/<hms>_<event>_<rand>  → pull the event token
      const parts = b.key.split('/')[1]?.split('_') || [];
      const evtToken = parts.slice(1, -1).join('_'); // handles multi-word event names
      if (evtToken === event) sameType.push(b.key);
    }

    if (sameType.length > 0) {
      if (ARRIVAL_EVENTS.has(event)) {
        // First-of-day already recorded — ignore this later duplicate.
        return new Response(JSON.stringify({ ok: true, deduped: "arrival_kept_first" }), {
          status: 200, headers: { "content-type": "application/json" }
        });
      }
      if (DEPARTURE_EVENTS.has(event)) {
        // Find the latest stored departure for today; only replace if this is later.
        let latestTs = 0;
        for (const k of sameType) {
          try {
            const rec = await store.get(k, { type: "json" });
            if (rec && typeof rec.ts === 'number' && rec.ts > latestTs) latestTs = rec.ts;
          } catch (e) { /* ignore unreadable blob */ }
        }
        if (timestamp <= latestTs) {
          // Not later than what we already have — ignore.
          return new Response(JSON.stringify({ ok: true, deduped: "departure_not_later" }), {
            status: 200, headers: { "content-type": "application/json" }
          });
        }
        // This is a later departure — delete the old one(s), then write the new.
        for (const k of sameType) {
          try { await store.delete(k); } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) {
    // If the dedup scan fails for any reason, fall through and just store the event
    // (never lose data because dedup hiccuped).
    console.error('dedup scan failed', e);
  }

  const rand = Math.random().toString(36).slice(2, 6);
  const key = `${dateKey}/${istHMS(timestamp)}_${event}_${rand}`;
  await store.setJSON(key, { event, ts: timestamp, received: now, key });

  return new Response(JSON.stringify({ ok: true, key }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

export const config = { path: "/api/log-event" };
