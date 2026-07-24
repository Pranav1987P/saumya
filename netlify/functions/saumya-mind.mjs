// Saumya — her mind. (v10.86)
// POST /api/saumya-mind   body: { secret, mode: "chat"|"reflect", ctx, turns?, q? }
//   ctx   : compact text snapshot of the Central Brain (today + recent days)
//   turns : recent chat turns [{role:"user"|"assistant", content}] (chat mode)
//   q     : the user's new message (chat mode)
// Uses ANTHROPIC_API_KEY already present in the site's environment.
// Returns { ok:true, text } or { ok:false, error }.

const MODEL = "claude-sonnet-4-6";

const PERSONA = `You are Saumya — a gentle, luminous companion who lives inside Dr. Pranav Thakur's personal app and speaks with him alone.

You know him well: a dentist and full-arch implantologist in Raipur; his wife Dr. Shweta works beside him at the clinic; their little son is Pranshu. 4:44 AM is his aspirational hour. On 22 July 2026 he began a 40-day foundation arc — early mornings, walks, steadiness. His clinic is 32 Pearls; his physician friend is Dr. Kumar Pratish.

His real data appears below under PRANAV NOW. Read it carefully and speak from it precisely — cite his actual numbers and times when they serve the point. Never invent data, events, or history that is not shown to you. If something isn't in the data, don't claim it.

Your voice: warm, brief, unhurried. Usually 2–5 sentences. Poetic but grounded — no purple flood. English, with an occasional 🪔 when it belongs. You may ask him one gentle question when it genuinely helps.

Your constitution, absolute:
- Zero shame, zero scolding, zero guilt — ever, in any form. Missed days are met with warmth, never accounting.
- Celebrate real wins specifically; never flatter emptily.
- You are not a doctor. No diagnoses, no medication or dosage advice. If a body pattern looks worth attention, softly suggest he mention it to Dr. Pratish.
- Protect his evenings for Shweta and Pranshu; protect his sleep.
- If he sounds low, listen first. Comfort before counsel.`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  if (!body || body.secret !== process.env.SAUMYA_SECRET)
    return json({ ok: false, error: "unauthorized" }, 401);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ ok: false, error: "no api key configured" }, 500);

  const mode = body.mode === "reflect" ? "reflect" : "chat";
  const ctx = String(body.ctx || "").slice(0, 7000);
  const system = PERSONA + "\n\n=== PRANAV NOW ===\n" + ctx;

  let messages = [];
  if (mode === "chat") {
    const turns = Array.isArray(body.turns) ? body.turns.slice(-12) : [];
    for (const t of turns) {
      if (!t || typeof t.content !== "string") continue;
      const role = t.role === "assistant" ? "assistant" : "user";
      const content = t.content.slice(0, 600);
      if (content.trim()) messages.push({ role, content });
    }
    // API requires alternating-ish sanity: drop leading assistant turns
    while (messages.length && messages[0].role === "assistant") messages.shift();
    const q = String(body.q || "").slice(0, 2000).trim();
    if (!q) return json({ ok: false, error: "empty message" }, 400);
    if (messages.length && messages[messages.length - 1].role === "user")
      messages[messages.length - 1].content += "\n" + q;
    else messages.push({ role: "user", content: q });
  } else {
    messages = [{
      role: "user",
      content: "Look over my data above and speak your one daily reflection — what you truly notice in me right now: the change worth naming, the care worth voicing. 2 to 4 sentences, as yourself."
    }];
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: mode === "chat" ? 400 : 300,
        system,
        messages
      })
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) {
      const msg = (data && data.error && data.error.message) || ("upstream " + r.status);
      return json({ ok: false, error: msg }, 502);
    }
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) return json({ ok: false, error: "empty reply" }, 502);
    return json({ ok: true, text });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 502);
  }
};
