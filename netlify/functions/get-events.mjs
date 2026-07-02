// Saumya — get-events endpoint
// Saumya polls this on open / visibility-change.
// GET /api/get-events?since=<epoch_ms>&secret=<secret>
import { getStore } from "@netlify/blobs";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDateKey = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

export default async (req) => {
  const SECRET = process.env.SAUMYA_SECRET;
  if (!SECRET) return new Response("Server misconfigured: SAUMYA_SECRET not set", { status: 500 });

  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  const since = Number(url.searchParams.get("since")) || 0;

  if (secret !== SECRET) return new Response("Unauthorized", { status: 401 });

  const store = getStore("saumya-events");
  const now = Date.now();

  // Read the FULL 7-day retention window (oldest → newest), so skipping the
  // app for a few days never loses the in-between days. Server-side dedup
  // keeps at most ~1 arrival + 1 departure per event type per day, so this
  // is still only ~50 small blobs at worst.
  const prefixes = [];
  for (let i = 6; i >= 0; i--) prefixes.push(istDateKey(now - i * 24 * 60 * 60 * 1000));

  const keys = [];
  for (const prefix of prefixes) {
    try {
      const { blobs } = await store.list({ prefix: prefix + "/" });
      for (const b of blobs || []) keys.push(b.key);
    } catch (e) { console.error('list failed', prefix, e); }
  }

  const events = [];
  await Promise.all(keys.map(async (key) => {
    try {
      const rec = await store.get(key, { type: "json" });
      if (rec && typeof rec.ts === 'number' && rec.ts > since) {
        events.push({ event: rec.event, ts: rec.ts, received: rec.received });
      }
    } catch (e) { console.error('get failed', key, e); }
  }));
  events.sort((a, b) => a.ts - b.ts);

  // Fire-and-forget cleanup of blobs older than 7 days
  cleanupOldEvents(store, now).catch(err => console.error('cleanup err:', err));

  return new Response(JSON.stringify({ ok: true, events, serverTime: now }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
};

async function cleanupOldEvents(store, now) {
  const keep = new Set();
  for (let i = 0; i < 7; i++) keep.add(istDateKey(now - i * 24 * 60 * 60 * 1000));
  const { blobs } = await store.list();
  for (const b of blobs || []) {
    const datePart = b.key.split('/')[0];
    if (!keep.has(datePart)) await store.delete(b.key);
  }
}

export const config = { path: "/api/get-events" };
