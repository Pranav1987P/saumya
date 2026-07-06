// Saumya — live "latest research" feed.
// Pulls the newest zygomatic / pterygoid / full-arch implant papers from PubMed
// (NCBI E-utilities, free & public). Runs server-side so there is no CORS issue
// and no API key is needed. Netlify caches the result for 6 hours.
//
// Deploy: place this file at  netlify/functions/pubmed.mjs  in your repo.
// The app fetches it at /api/pubmed (and falls back to /.netlify/functions/pubmed).

const TERM =
  '((zygomatic implant) OR (pterygoid implant) OR (all-on-4) OR (all-on-x) ' +
  'OR (full-arch implant) OR (graftless full arch)) AND (dental OR maxilla OR implant)';

export default async () => {
  const H = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=21600',
  };
  try {
    const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
    const esRes = await fetch(
      base + 'esearch.fcgi?db=pubmed&retmax=8&sort=date&retmode=json&term=' +
        encodeURIComponent(TERM)
    );
    const esJson = await esRes.json();
    const ids = (esJson && esJson.esearchresult && esJson.esearchresult.idlist) || [];
    if (!ids.length) return new Response(JSON.stringify({ papers: [] }), { headers: H });

    const suRes = await fetch(
      base + 'esummary.fcgi?db=pubmed&retmode=json&id=' + ids.join(',')
    );
    const suJson = await suRes.json();
    const r = (suJson && suJson.result) || {};

    const papers = ids
      .map((id) => {
        const p = r[id];
        if (!p) return null;
        return {
          title: String(p.title || '').replace(/<[^>]+>/g, '').trim(),
          journal: p.fulljournalname || p.source || '',
          date: p.pubdate || '',
          url: 'https://pubmed.ncbi.nlm.nih.gov/' + id + '/',
        };
      })
      .filter(Boolean);

    return new Response(JSON.stringify({ papers }), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ papers: [], error: String(e) }), { headers: H });
  }
};
