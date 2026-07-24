// Saumya — live SURGICAL research feed (zygoma / pterygoid / paranasal / graftless full-arch).
// Searches PubMed for clinically-relevant papers in Pranav's niche, then pulls each
// paper's CONCLUSION from the abstract so the feed shows the surgical takeaway,
// not just the title. Free, no API key. Runs server-side (no CORS). Netlify caches 6h.
//
// Deploy: netlify/functions/pubmed.mjs. App fetches /api/pubmed (falls back to /.netlify/functions/pubmed).

const TERM =
  '(zygomatic implant*[tiab] OR pterygoid implant*[tiab] OR "quad zygoma"[tiab] ' +
  'OR "quad zygomatic"[tiab] OR subperiosteal implant*[tiab] ' +
  // paranasal / pyriform-rim / transnasal family (Bernardis' graftless maxilla work)
  'OR paranasal implant*[tiab] OR transnasal implant*[tiab] ' +
  'OR "pyriform rim"[tiab] OR "piriform rim"[tiab] ' +
  'OR (atrophic maxilla*[tiab] AND implant*[tiab]) ' +
  'OR (edentulous maxilla*[tiab] AND (zygoma*[tiab] OR pterygoid[tiab]))) ' +
  'NOT "quality of life"[ti] NOT "in vitro"[ti] NOT survey[ti] NOT questionnaire[ti]';

function clean(s){
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x?[0-9a-f]+;/gi, '')
    .replace(/\s+/g, ' ').trim();
}

function conclusionFrom(block){
  // prefer a structured CONCLUSION section
  var m = block.match(/<AbstractText[^>]*Label="[^"]*(?:CONCLUSION|RESULT|FINDING|SUMMARY)[^"]*"[^>]*>([\s\S]*?)<\/AbstractText>/i);
  var txt = '';
  if (m) { txt = clean(m[1]); }
  else {
    var all = block.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g) || [];
    if (all.length) {
      var last = clean(all[all.length - 1].replace(/<[^>]*AbstractText[^>]*>/g, ''));
      // take the last 1-2 sentences of the last block
      var parts = last.split(/(?<=[.!?])\s+/);
      txt = parts.slice(Math.max(0, parts.length - 2)).join(' ');
    }
  }
  if (txt.length > 300) txt = txt.slice(0, 297).replace(/\s+\S*$/, '') + '\u2026';
  return txt;
}

export default async () => {
  const H = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=21600',
  };
  try {
    const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
    const es = await fetch(base + 'esearch.fcgi?db=pubmed&retmax=6&sort=date&retmode=json&term=' + encodeURIComponent(TERM));
    const sj = await es.json();
    const ids = (sj && sj.esearchresult && sj.esearchresult.idlist) || [];
    if (!ids.length) return new Response(JSON.stringify({ papers: [] }), { headers: H });

    const su = await fetch(base + 'esummary.fcgi?db=pubmed&retmode=json&id=' + ids.join(','));
    const suj = await su.json();
    const r = (suj && suj.result) || {};

    // abstracts -> conclusions
    var takeaway = {};
    try {
      const ef = await fetch(base + 'efetch.fcgi?db=pubmed&rettype=abstract&retmode=xml&id=' + ids.join(','));
      const xml = await ef.text();
      const blocks = xml.split('<PubmedArticle>').slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var pm = blocks[i].match(/<PMID[^>]*>(\d+)<\/PMID>/);
        if (pm) takeaway[pm[1]] = conclusionFrom(blocks[i]);
      }
    } catch (e) {}

    const papers = ids.map((id) => {
      const p = r[id];
      if (!p) return null;
      return {
        title: clean(p.title),
        journal: p.fulljournalname || p.source || '',
        date: p.pubdate || '',
        url: 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/',
        takeaway: takeaway[id] || '',
      };
    }).filter(Boolean);

    return new Response(JSON.stringify({ papers }), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ papers: [], error: String(e) }), { headers: H });
  }
};
