// Saumya — WHOOP body readout (recovery + strain + sleep, in one call)
// GET /api/whoop-recovery?secret=<SAUMYA_SECRET>
// Returns the member's latest recovery, today's day strain, and last night's
// sleep. Auto-refreshes the access token using the stored refresh token, so it
// keeps working without re-connecting.
// Scopes used: read:recovery, read:cycles, read:sleep (offline for refresh).
import { getStore } from "@netlify/blobs";

const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API = "https://api.prod.whoop.com/developer";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function num(x) { return (typeof x === "number" && isFinite(x)) ? x : null; }
function roundN(x) { return num(x) === null ? null : Math.round(x); }
function round1(x) { return num(x) === null ? null : Math.round(x * 10) / 10; }

async function refresh(store, tok, clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tok.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    scope: "offline"
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
    refresh_token: t.refresh_token || tok.refresh_token, // WHOOP rotates these
    scope: t.scope || tok.scope,
    expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    updated: Date.now()
  };
  await store.setJSON("whoop", updated);
  return updated;
}

// Latest record from a WHOOP collection, newest first. Try v2, fall back to v1.
// Returns null when the data isn't available (e.g. a scope wasn't granted) so one
// missing metric never breaks the others. Throws only on 401 (expired token),
// which the caller handles by refreshing once.
async function latest(accessToken, paths) {
  for (const path of paths) {
    const resp = await fetch(API + path, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (resp.status === 200) {
      const data = await resp.json();
      return (data && data.records && data.records[0]) || null;
    }
    if (resp.status === 401) throw new Error("unauthorized");
    // 403 (scope missing), 404, 429, etc: just try the next path, then give up gracefully
  }
  return null;
}

async function pullAll(accessToken) {
  const [rec, cyc, slp] = await Promise.all([
    latest(accessToken, ["/v2/recovery?limit=1", "/v1/recovery?limit=1"]),
    latest(accessToken, ["/v2/cycle?limit=1", "/v1/cycle?limit=1"]),
    latest(accessToken, ["/v2/activity/sleep?limit=1", "/v1/activity/sleep?limit=1"])
  ]);
  return { rec, cyc, slp };
}

export default async (req) => {
  const SECRET = process.env.SAUMYA_SECRET;
  if (!SECRET) return json({ ok: false, error: "SAUMYA_SECRET not set" }, 500);
  const url = new URL(req.url);
  if (url.searchParams.get("secret") !== SECRET) return json({ ok: false, error: "unauthorized" }, 401);

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;

  const store = getStore("saumya-tokens");
  let tok;
  try { tok = await store.get("whoop", { type: "json" }); } catch { tok = null; }
  if (!tok || !tok.access_token) return json({ ok: true, connected: false });

  try {
    if (Date.now() >= (tok.expires_at || 0) - 60000) {
      tok = await refresh(store, tok, clientId, clientSecret);
    }

    let data;
    try {
      data = await pullAll(tok.access_token);
    } catch (e) {
      if (String(e.message).includes("unauthorized")) {
        tok = await refresh(store, tok, clientId, clientSecret);
        data = await pullAll(tok.access_token);
      } else {
        throw e;
      }
    }

    const rec = data.rec, cyc = data.cyc, slp = data.slp;
    const rs = (rec && rec.score) || {};
    const cs = (cyc && cyc.score) || {};
    const ss = (slp && slp.score) || {};

    // Sleep hours = actual time asleep (light + deep/SWS + REM), excluding awake time.
    const stg = ss.stage_summary || {};
    let sleepHrs = null;
    const light = num(stg.total_light_sleep_time_milli);
    const deep = num(stg.total_slow_wave_sleep_time_milli);
    const rem = num(stg.total_rem_sleep_time_milli);
    if (light !== null || deep !== null || rem !== null) {
      const asleepMs = (light || 0) + (deep || 0) + (rem || 0);
      if (asleepMs > 0) sleepHrs = Math.round((asleepMs / 3600000) * 100) / 100;
    }

    return json({
      ok: true,
      connected: true,
      // recovery
      recovery: roundN(rs.recovery_score),
      hrv: roundN(rs.hrv_rmssd_milli),
      rhr: roundN(rs.resting_heart_rate),
      spo2: round1(rs.spo2_percentage),
      skinTemp: round1(rs.skin_temp_celsius),
      // strain (today's physiological cycle, 0-21)
      strain: round1(cs.strain),
      // sleep (last night)
      sleepHrs: sleepHrs,
      sleepPerf: roundN(ss.sleep_performance_percentage),
      respRate: round1(ss.respiratory_rate),
      // meta
      state: (rec && rec.score_state) || null,
      at: (rec && rec.created_at) || null
    });
  } catch (e) {
    return json({ ok: false, connected: true, error: String(e.message || e).slice(0, 200) });
  }
};

export const config = { path: "/api/whoop-recovery" };
