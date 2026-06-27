// Saumya — Strava daily distance
// GET /api/strava-sync?secret=<SAUMYA_SECRET>
// Returns today's total distance (km) from Strava activities, IST day-bounded.
// Auto-refreshes the access token (Strava tokens expire every ~6 hours).
import { getStore } from "@netlify/blobs";

const TOKEN_URL = "https://www.strava.com/oauth/token";
const ACT_URL = "https://www.strava.com/api/v3/athlete/activities";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

// Midnight IST today, expressed as a UTC epoch in seconds (Strava's `after` filter).
function istStartOfTodayEpochSec(now) {
  const ist = new Date(now + IST_OFFSET_MS);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  const istMidnightUtcMs = Date.UTC(y, m, d, 0, 0, 0) - IST_OFFSET_MS;
  return Math.floor(istMidnightUtcMs / 1000);
}

async function refresh(store, tok, clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!resp.ok) throw new Error(`refresh ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const t = await resp.json();
  const updated = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || tok.refresh_token,
    expires_at: (Number(t.expires_at) || 0) * 1000,
    updated: Date.now()
  };
  await store.setJSON("strava", updated);
  return updated;
}

export default async (req) => {
  const SECRET = process.env.SAUMYA_SECRET;
  if (!SECRET) return json({ ok: false, error: "SAUMYA_SECRET not set" }, 500);
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  const store = getStore("saumya-tokens");
  let tok;
  try { tok = await store.get("strava", { type: "json" }); } catch { tok = null; }
  if (!tok || !tok.access_token) return json({ ok: true, connected: false });

  try {
    if (Date.now() >= (tok.expires_at || 0) - 60000) {
      tok = await refresh(store, tok, clientId, clientSecret);
    }
    const now = Date.now();
    const after = istStartOfTodayEpochSec(now);
    const fetchActs = (t) => fetch(`${ACT_URL}?after=${after}&per_page=50`, { headers: { Authorization: `Bearer ${t}` } });

    let resp = await fetchActs(tok.access_token);
    if (resp.status === 401) {
      tok = await refresh(store, tok, clientId, clientSecret);
      resp = await fetchActs(tok.access_token);
    }
    if (!resp.ok) return json({ ok: false, connected: true, error: `activities ${resp.status}` });

    const acts = await resp.json();
    let meters = 0, count = 0, walkMeters = 0;
    for (const a of (Array.isArray(acts) ? acts : [])) {
      const dist = Number(a.distance) || 0;
      meters += dist;
      count++;
      if (a.type === "Walk" || a.sport_type === "Walk") walkMeters += dist;
    }
    return json({
      ok: true,
      connected: true,
      km: Math.round(meters / 100) / 10,        // total km today, 1 decimal
      walkKm: Math.round(walkMeters / 100) / 10,
      activities: count,
      at: now
    });
  } catch (e) {
    return json({ ok: false, connected: true, error: String(e.message || e).slice(0, 200) });
  }
};

export const config = { path: "/api/strava-sync" };
