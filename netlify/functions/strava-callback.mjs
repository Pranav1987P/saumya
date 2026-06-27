// Saumya — Strava OAuth callback
// Strava redirects here after the athlete approves. We exchange the one-time
// code for access + refresh tokens and store them in Netlify Blobs.
import { getStore } from "@netlify/blobs";

const SITE = "https://venerable-parfait-ab7494.netlify.app";
const TOKEN_URL = "https://www.strava.com/oauth/token";

function page(title, msg, redirect) {
  const meta = redirect ? `<meta http-equiv="refresh" content="2;url=${redirect}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8">${meta}
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,system-ui,Segoe UI,sans-serif;background:#0d0d12;color:#f0e9da;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:24px}
.card{max-width:430px}h1{font-size:1.4rem;margin:0 0 .6rem}p{opacity:.82;line-height:1.55}</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}

export default async (req) => {
  const url = new URL(req.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");

  if (error) {
    return new Response(page("Strava connection cancelled", `It returned: ${error}. You can try again from Saumya.`),
      { status: 200, headers: { "content-type": "text/html" } });
  }
  if (!code) {
    return new Response(page("No code received", "Strava didn't send an authorization code. Please try connecting again."),
      { status: 400, headers: { "content-type": "text/html" } });
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response(page("Server not configured", "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET are missing in the Netlify environment variables."),
      { status: 500, headers: { "content-type": "text/html" } });
  }

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code"
    });
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const text = await resp.text();
    if (!resp.ok) {
      return new Response(page("Strava token exchange failed", `Strava returned ${resp.status}: ${text.slice(0, 300)}`),
        { status: 200, headers: { "content-type": "text/html" } });
    }
    const tok = JSON.parse(text);
    const store = getStore("saumya-tokens");
    await store.setJSON("strava", {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: (Number(tok.expires_at) || 0) * 1000, // Strava gives epoch SECONDS
      updated: Date.now()
    });
    return new Response(page("\u2705 Strava connected", "Your walks and distance will now flow into Saumya. Taking you back\u2026", `${SITE}/`),
      { status: 200, headers: { "content-type": "text/html" } });
  } catch (e) {
    return new Response(page("Something went wrong", String(e).slice(0, 300)),
      { status: 200, headers: { "content-type": "text/html" } });
  }
};

export const config = { path: "/api/strava-callback" };
