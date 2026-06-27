// Saumya — WHOOP recovery fetch
// GET /api/whoop-recovery?secret=<SAUMYA_SECRET>
// Returns the member's latest recovery score. Auto-refreshes the access token
// using the stored refresh token, so it keeps working without re-connecting.
import { getStore } from "@netlify/blobs";

const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API = "https://api.prod.whoop.com/developer";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

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

// Latest recovery, newest first. Try v2 collection, fall back to v1.
async function getRecovery(accessToken) {
  for (const path of ["/v2/recovery?limit=1", "/v1/recovery?limit=1"]) {
    const resp = await fetch(API + path, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (resp.status === 200) {
      const data = await resp.json();
      return data?.records?.[0] || null;
    }
    if (resp.status === 401) throw new Error("unauthorized");
    // any other status: try the next path
  }
  return null;
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
    let rec;
    try {
      rec = await getRecovery(tok.access_token);
    } catch (e) {
      if (String(e.message).includes("unauthorized")) {
        tok = await refresh(store, tok, clientId, clientSecret);
        rec = await getRecovery(tok.access_token);
      } else {
        throw e;
      }
    }
    if (!rec) return json({ ok: true, connected: true, recovery: null, state: "NO_DATA" });
    const s = rec.score || {};
    return json({
      ok: true,
      connected: true,
      recovery: (typeof s.recovery_score === "number") ? Math.round(s.recovery_score) : null,
      hrv: (typeof s.hrv_rmssd_milli === "number") ? Math.round(s.hrv_rmssd_milli) : null,
      rhr: (typeof s.resting_heart_rate === "number") ? Math.round(s.resting_heart_rate) : null,
      state: rec.score_state || null,
      at: rec.created_at || null
    });
  } catch (e) {
    return json({ ok: false, connected: true, error: String(e.message || e).slice(0, 200) });
  }
};

export const config = { path: "/api/whoop-recovery" };
