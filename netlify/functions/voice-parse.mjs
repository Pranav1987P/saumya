// netlify/functions/voice-parse.mjs
//
// Turns one spoken sentence into structured records for Saumya.
//
// The key never leaves the server. Set it once in Netlify:
//   Site settings -> Environment variables -> ANTHROPIC_API_KEY
//
// The app calls this, but does NOT depend on it: if this function is missing,
// slow, or out of credit, the app falls back to its own local rules. Voice
// capture keeps working either way.

const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM = `You convert one spoken sentence from Dr Pranav Thakur into structured records for his personal app, Saumya.

He is a dentist and implantologist in Raipur, India. He owns 32 Pearls Dental Clinic. His wife Shweta is co-doctor there; his son is Pranshu. He speaks Indian English mixed with Hindi, and the speech-to-text is often mangled — read for INTENT, not literal words. Common mis-hearings: "permit"/"pubmed" = PubMed, "pain" = PIN, "imprintology" = implantology, "chart" = chat. Numbers spoken in words ("eighty thousand") should become digits (80000).

Return ONLY a JSON object. No prose, no markdown fences.

{"items":[ ... ]}

One sentence may contain several records — return one item per record. Each item is one of:

{"kind":"weight","value":<number 40-200>}
{"kind":"walk","value":<km as number, or null if not said>}
{"kind":"mood","value":"low"|"meh"|"okay"|"good"|"great"}
{"kind":"case","note":"<short clear line>","date":"YYYY-MM-DD"|null,"time":"HH:MM"|null}
{"kind":"tomorrow","note":"<short clear line>"}
{"kind":"note","note":"<short clear line>"}

Rules:
- "case" is for anything clinical: a patient, a follow-up, an estimate, a treatment. Keep any name, treatment and amount in the note.
- "tomorrow" is for something HE must do tomorrow that is not clinical.
- "note" is the fallback: thoughts, family, reminders, observations.
- Rewrite the note into clean readable English. Keep every fact. Add nothing.
- If he states a mood or how he feels, add a separate mood item as well as the note.
- If no time was spoken, time is null. If a bare hour is given and it is 1-7, assume PM — his clinic runs late.
- If you cannot tell what he meant, return a single "note" item with his words tidied.`;

function ok(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

export default async (req) => {
  if (req.method !== 'POST') return ok({ items: null, error: 'post only' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return ok({ items: null, error: 'no key configured' });

  let text = '';
  let todayKey = '';
  try {
    const body = await req.json();
    text = String(body.text || '').slice(0, 1200);
    todayKey = String(body.today || '').slice(0, 10);
  } catch {
    return ok({ items: null, error: 'bad request' });
  }
  if (!text.trim()) return ok({ items: null, error: 'empty' });

  // Give the model today's date so relative words resolve correctly.
  const dated = todayKey
    ? `Today is ${todayKey} (Asia/Kolkata). Resolve "tomorrow", "Friday", "next week" against that.\n\n${text}`
    : text;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: 'user', content: dated }]
      })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return ok({ items: null, error: 'api ' + r.status, detail: detail.slice(0, 300) });
    }

    const data = await r.json();
    const raw = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return ok({ items: null, error: 'unparseable' });
      parsed = JSON.parse(m[0]);
    }

    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 8) : null;
    if (!items || !items.length) return ok({ items: null, error: 'no items' });

    // Only let through shapes the app knows how to write.
    const KINDS = ['weight', 'walk', 'mood', 'case', 'tomorrow', 'note'];
    const MOODS = ['low', 'meh', 'okay', 'good', 'great'];
    const clean = items
      .filter(it => it && KINDS.includes(it.kind))
      .map(it => {
        const out = { kind: it.kind };
        if (it.kind === 'weight') {
          const v = Number(it.value);
          if (!(v >= 40 && v <= 200)) return null;
          out.value = v;
        } else if (it.kind === 'walk') {
          const v = Number(it.value);
          out.value = (v > 0 && v <= 100) ? v : null;
        } else if (it.kind === 'mood') {
          if (!MOODS.includes(it.value)) return null;
          out.value = it.value;
        } else {
          const n = String(it.note || '').trim().slice(0, 400);
          if (!n) return null;
          out.note = n;
          if (it.kind === 'case') {
            out.date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : null;
            out.time = /^\d{2}:\d{2}$/.test(it.time || '') ? it.time : null;
          }
        }
        return out;
      })
      .filter(Boolean);

    if (!clean.length) return ok({ items: null, error: 'nothing usable' });
    return ok({ items: clean, model: MODEL });
  } catch (e) {
    return ok({ items: null, error: String(e && e.message || e).slice(0, 200) });
  }
};

export const config = { path: '/api/voice-parse' };
