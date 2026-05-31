// Saumya — log-event endpoint
// Tasker POSTs here when geofence fires (works even when phone locked / Chrome closed).
import { getStore } from "@netlify/blobs";

const VALID_EVENTS = new Set([
  'arrived_clinic', 'left_clinic',
  'arrived_home',   'left_home',
  'class_start',    'class_end',
  'woke_up'
]);

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

  const rand = Math.random().toString(36).slice(2, 6);
  const key = `${istDateKey(timestamp)}/${istHMS(timestamp)}_${event}_${rand}`;

  const store = getStore("saumya-events");
  await store.setJSON(key, { event, ts: timestamp, received: now, key });

  return new Response(JSON.stringify({ ok: true, key }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

export const config = { path: "/api/log-event" };
