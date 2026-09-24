// Liest ein Brawl-Stars-Profil (Brawler + Power-Level) über die offizielle Supercell-API.
// Die offizielle API erlaubt nur fest eingetragene IP-Adressen – Netlify hat wechselnde IPs.
// Deshalb geht die Anfrage über den kostenlosen RoyaleAPI-Proxy (bsproxy.royaleapi.dev).
//
// Einrichtung (einmalig):
//   1. developer.brawlstars.com → Konto → "Create New Key"
//      IP-Adresse:  45.79.218.79   (das ist der RoyaleAPI-Proxy)
//   2. Den Schlüssel in Netlify eintragen: Site settings → Environment variables
//      Name:  BRAWLSTARS_API_KEY
//   3. Neu deployen.
const CACHE = new Map();
const TAG_OK = /^[0289PYLQGRJCUV]{3,14}$/;

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const key = process.env.BRAWLSTARS_API_KEY;
  if (!key) return { statusCode: 501, headers, body: JSON.stringify({ error: 'no-key' }) };

  let tag = String((event.queryStringParameters || {}).tag || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0');
  if (!TAG_OK.test(tag)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'bad-tag' }) };

  const hit = CACHE.get(tag);
  if (hit && Date.now() - hit.t < 120000) return { statusCode: 200, headers, body: hit.body };

  try {
    const r = await fetch('https://bsproxy.royaleapi.dev/v1/players/%23' + tag, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }
    });
    if (r.status === 404) return { statusCode: 404, headers, body: JSON.stringify({ error: 'not-found' }) };
    if (r.status === 403) return { statusCode: 502, headers, body: JSON.stringify({ error: 'key-rejected' }) };
    if (r.status === 429) return { statusCode: 429, headers, body: JSON.stringify({ error: 'rate-limit' }) };
    if (r.status === 503) return { statusCode: 503, headers, body: JSON.stringify({ error: 'maintenance' }) };
    if (!r.ok) return { statusCode: 502, headers, body: JSON.stringify({ error: 'api-' + r.status }) };
    const p = await r.json();
    const body = JSON.stringify({
      tag: String(p.tag || '#' + tag),
      name: p.name || '',
      trophies: p.trophies || 0,
      icon: p.icon && p.icon.id || null,
      brawlers: (p.brawlers || []).map(b => ({
        name: b.name,
        power: b.power || 0,
        trophies: b.trophies || 0,
        gadgets: (b.gadgets || []).length,
        starPowers: (b.starPowers || []).length,
        hyper: (b.hyperCharges || []).length
      }))
    });
    CACHE.set(tag, { t: Date.now(), body });
    return { statusCode: 200, headers, body };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'network' }) };
  }
};
