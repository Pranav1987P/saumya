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

// A page of records (newest first) from a WHOOP collection. Same v2->v1 fallback
// as latest(). Returns [] when unavailable so the derived signals just go null.
async function series(accessToken, bases, limit, pages = 1) {
  for (const base of bases) {
    const sep = base.includes("?") ? "&" : "?";
    let out = [], token = null, ok = false;
    for (let p = 0; p < pages; p++) {
      const u = API + base + sep + "limit=" + limit + (token ? "&nextToken=" + encodeURIComponent(token) : "");
      const resp = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (resp.status === 200) {
        ok = true;
        const d = await resp.json();
        out = out.concat((d && d.records) || []);
        token = d && d.next_token;
        if (!token) break;
      } else if (resp.status === 401) { throw new Error("unauthorized"); }
      else break; // 403/404/429/400: try next base, then give up gracefully
    }
    if (ok) return out;
  }
  return [];
}

// ~25 days is enough for a 4-day trend and a stable ~3-week baseline, and it's a
// single page (WHOOP caps limit at 25), so this stays 3 API calls like before.
const HIST = 25;

async function pullAll(accessToken) {
  let [recArr, cyc, slpArr] = await Promise.all([
    series(accessToken, ["/v2/recovery", "/v1/recovery"], HIST),
    latest(accessToken, ["/v2/cycle?limit=1", "/v1/cycle?limit=1"]),
    series(accessToken, ["/v2/activity/sleep", "/v1/activity/sleep"], HIST, 2)
  ]);
  // If a history page came back empty, never regress below the old single-record
  // behaviour — fall back to one latest record so today's readout still shows.
  if (!recArr.length) { const r = await latest(accessToken, ["/v2/recovery?limit=1", "/v1/recovery?limit=1"]); if (r) recArr = [r]; }
  if (!slpArr.length) { const s = await latest(accessToken, ["/v2/activity/sleep?limit=1", "/v1/activity/sleep?limit=1"]); if (s) slpArr = [s]; }
  return { recArr, cyc, slpArr };
}

function median(a) {
  if (!a.length) return null;
  const b = a.slice().sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
function parseTime(x) { const t = Date.parse(x); return isFinite(t) ? t : 0; }

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

    const recArr = data.recArr || [];
    const slpArr = data.slpArr || [];
    const cyc = data.cyc;

    // Recovery history: scored records only, newest first.
    const recScored = recArr
      .filter(r => r && r.score_state === "SCORED" && r.score)
      .sort((a, b) => parseTime(b.updated_at || b.created_at) - parseTime(a.updated_at || a.created_at));
    const rec = recScored[0] || recArr[0] || null;
    const scores = recScored.map(r => num(r.score.recovery_score)).filter(v => v !== null);
    const hrvs = recScored.map(r => num(r.score.hrv_rmssd_milli)).filter(v => v !== null);
    const rhrs = recScored.map(r => num(r.score.resting_heart_rate)).filter(v => v !== null);

    // Sleep history: night sleeps only (naps excluded), newest first.
    const nights = slpArr
      .filter(s => s && s.nap !== true)
      .sort((a, b) => parseTime(b.end || b.start) - parseTime(a.end || a.start));
    const slp = nights[0] || slpArr[0] || null;

    // Naps were being discarded here, which meant a morning like "up at 7:30,
    // back down at 8:45, properly up at 11:30" reached Saumya as a single night
    // ending at 7:58 — and the day was then scored from a time he was still
    // asleep. Naps are kept now, and lastSleepEnd answers the only question the
    // app really needs: when did your last sleep of any kind end.
    const IST_OFFSET_MS = 5.5 * 3600000;
    const istKey = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
    const todayIst = istKey(Date.now());

    const napsToday = slpArr
      .filter(s => s && s.nap === true && s.end && istKey(parseTime(s.end)) === todayIst)
      .sort((a, b) => parseTime(a.end) - parseTime(b.end))
      .map(s => {
        const st = s.score && s.score.stage_summary ? s.score.stage_summary : {};
        const asleepMs = (num(st.total_light_sleep_time_milli) || 0)
                       + (num(st.total_slow_wave_sleep_time_milli) || 0)
                       + (num(st.total_rem_sleep_time_milli) || 0);
        return {
          start: s.start || null,
          end: s.end || null,
          hrs: asleepMs > 0 ? Math.round((asleepMs / 3600000) * 100) / 100 : null
        };
      });

    // --- 30-day sleep chart data: asleep hours per IST day, naps separate ---
    // A record's day = the IST date its sleep ENDED (the morning you woke).
    // Asleep time from stage summary; if unscored yet, fall back to end-start.
    const histMap = {};
    for (const s of slpArr) {
      if (!s || !s.end) continue;
      const key = istKey(parseTime(s.end));
      const st2 = s.score && s.score.stage_summary ? s.score.stage_summary : {};
      let ms = (num(st2.total_light_sleep_time_milli) || 0)
             + (num(st2.total_slow_wave_sleep_time_milli) || 0)
             + (num(st2.total_rem_sleep_time_milli) || 0);
      if (!(ms > 0)) { const a = parseTime(s.start), b = parseTime(s.end); if (a && b && b > a) ms = b - a; }
      if (!(ms > 0)) continue;
      const hrs = Math.round(ms / 36000) / 100;
      const e = histMap[key] || (histMap[key] = { d: key, night: 0, nap: 0 });
      if (s.nap === true) e.nap = Math.round((e.nap + hrs) * 100) / 100;
      else e.night = Math.round((e.night + hrs) * 100) / 100;
    }
    const history = Object.values(histMap).sort((a, b) => (a.d < b.d ? -1 : 1)).slice(-30);

    // The latest end across night sleep and naps.
    let lastSleepEnd = (slp && slp.end) || null;
    for (const n of napsToday) {
      if (n.end && (!lastSleepEnd || parseTime(n.end) > parseTime(lastSleepEnd))) lastSleepEnd = n.end;
    }
    const resps = nights.map(s => num(s.score && s.score.respiratory_rate)).filter(v => v !== null);

    // --- Derived deductions (only when there's enough history to be honest) ---
    // Recovery trend: last up-to-4 scores, oldest -> newest, plus a direction.
    let recoveryTrend = null, recoveryDir = null;
    if (scores.length >= 3) {
      const last4 = scores.slice(0, 4).reverse();
      recoveryTrend = last4.map(roundN);
      const n = last4.length;
      const recent = (last4[n - 1] + last4[n - 2]) / 2;
      const prior = (last4[0] + last4[1]) / 2;
      recoveryDir = recent <= prior - 8 ? "falling" : (recent >= prior + 8 ? "rising" : "steady");
    }
    // HRV vs personal baseline (median of prior scored days; need >=5 prior + today).
    let hrvBaseline = null, hrvDelta = null;
    if (hrvs.length >= 6) {
      const base = median(hrvs.slice(1));
      if (base !== null) { hrvBaseline = roundN(base); hrvDelta = roundN(hrvs[0] - base); }
    }
    // Resting-HR vs personal baseline (median of prior scored days; need >=5 prior + today).
    // rhrFlag trips when today's resting HR is >=5 bpm above your usual — a classic
    // early sign of illness, strain, or stress.
    let rhrBaseline = null, rhrDelta = null, rhrFlag = null;
    if (rhrs.length >= 6) {
      const base = median(rhrs.slice(1));
      if (base !== null) { rhrBaseline = roundN(base); rhrDelta = roundN(rhrs[0] - base); rhrFlag = (rhrs[0] - base) >= 5; }
    }
    // Respiratory-rate tripwire: today vs prior-night baseline (need >=5 prior + today).
    let respBaseline = null, respDelta = null, respFlag = null;
    if (resps.length >= 6) {
      const base = median(resps.slice(1));
      if (base !== null) { respBaseline = round1(base); respDelta = round1(resps[0] - base); respFlag = (resps[0] - base) >= 1.0; }
    }

    const rs = (rec && rec.score) || {};
    const cs = (cyc && cyc.score) || {};
    const ss = (slp && slp.score) || {};

    // Sleep stages (milliseconds -> minutes). Asleep = light + deep/SWS + REM.
    const stg = ss.stage_summary || {};
    const toMin = (ms) => (num(ms) === null ? null : Math.round(ms / 60000));
    const lightMs = num(stg.total_light_sleep_time_milli);
    const deepMs = num(stg.total_slow_wave_sleep_time_milli);
    const remMs = num(stg.total_rem_sleep_time_milli);
    let sleepHrs = null;
    if (lightMs !== null || deepMs !== null || remMs !== null) {
      const asleepMs = (lightMs || 0) + (deepMs || 0) + (remMs || 0);
      if (asleepMs > 0) sleepHrs = Math.round((asleepMs / 3600000) * 100) / 100;
    }

    // Sleep need + debt (milliseconds -> minutes)
    const need = ss.sleep_needed || {};
    const needMin = (num(need.baseline_milli) !== null)
      ? toMin((need.baseline_milli || 0) + (need.need_from_sleep_debt_milli || 0)
            + (need.need_from_recent_strain_milli || 0) + (need.need_from_recent_nap_milli || 0))
      : null;

    // Calories: WHOOP gives kilojoules on the cycle. kcal = kJ / 4.184
    const kj = num(cs.kilojoule);
    const calories = (kj === null) ? null : Math.round(kj / 4.184);

    return json({
      ok: true,
      connected: true,
      // recovery
      recovery: roundN(rs.recovery_score),
      hrv: roundN(rs.hrv_rmssd_milli),
      rhr: roundN(rs.resting_heart_rate),
      spo2: round1(rs.spo2_percentage),
      skinTemp: round1(rs.skin_temp_celsius),
      // strain + energy (today's physiological cycle)
      strain: round1(cs.strain),
      avgHr: roundN(cs.average_heart_rate),
      calories: calories,
      // sleep (last night)
      sleepStart: (slp && slp.start) || null,   // ISO — when sleep began
      sleepEnd: (slp && slp.end) || null,       // ISO — when the night sleep ended
      naps: napsToday,                           // today's naps, oldest first
      history: history,                          // last 30 IST days: {d, night, nap} hrs
      lastSleepEnd: lastSleepEnd,                // ISO — end of the LAST sleep of any kind
      sleepHrs: sleepHrs,                        // hours actually asleep
      timeInBedMin: toMin(stg.total_in_bed_time_milli),
      awakeMin: toMin(stg.total_awake_time_milli),
      lightMin: toMin(lightMs),
      deepMin: toMin(deepMs),
      remMin: toMin(remMs),
      sleepNeedMin: needMin,
      sleepDebtMin: toMin(need.need_from_sleep_debt_milli),
      sleepPerf: roundN(ss.sleep_performance_percentage),
      sleepEff: roundN(ss.sleep_efficiency_percentage),
      sleepConsistency: roundN(ss.sleep_consistency_percentage),
      respRate: round1(ss.respiratory_rate),
      // derived deductions (null until ~a week of history exists)
      recoveryTrend: recoveryTrend,
      recoveryDir: recoveryDir,
      hrvBaseline: hrvBaseline,
      hrvDelta: hrvDelta,
      respBaseline: respBaseline,
      respDelta: respDelta,
      respFlag: respFlag,
      rhrBaseline: rhrBaseline,
      rhrDelta: rhrDelta,
      rhrFlag: rhrFlag,
      // meta
      state: (rec && rec.score_state) || null,
      at: (rec && rec.created_at) || null
    });
  } catch (e) {
    return json({ ok: false, connected: true, error: String(e.message || e).slice(0, 200) });
  }
};

export const config = { path: "/api/whoop-recovery" };
