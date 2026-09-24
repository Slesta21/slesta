// Slesdrafts · Brawl-Stars-Tracking (Build 129)
/* ── gemeinsamer Teil (in bs-track.js und bs-cron.js identisch) ── */
const SB_URL = (process.env.SUPABASE_URL || 'https://ddtnhnwdszeddegctlag.supabase.co').replace(/\/$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const BS_KEY = process.env.BRAWLSTARS_API_KEY || '';
const BS_BASE = 'https://bsproxy.royaleapi.dev/v1';
const TAG_OK = /^[0289PYLQGRJCUV]{3,14}$/;

function normTag(t) { return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0'); }

async function mitZeit(p, ms) {
  let t; const z = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); });
  try { return await Promise.race([p, z]); } finally { clearTimeout(t); }
}
async function bs(path, ms) {
  const r = await mitZeit(fetch(BS_BASE + path, { headers: { Authorization: 'Bearer ' + BS_KEY, Accept: 'application/json' } }), ms || 9000);
  if (!r.ok) { const e = new Error('bs-' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function sb(path, opt) {
  opt = opt || {};
  const r = await mitZeit(fetch(SB_URL + '/rest/v1/' + path, {
    method: opt.method || 'GET',
    /* neue Schlüssel (sb_secret_…) nur im apikey-Header, alte JWT-Schlüssel (eyJ…) zusätzlich als Bearer */
    headers: Object.assign({ apikey: SB_KEY, 'Content-Type': 'application/json' }, /^eyJ/.test(SB_KEY) ? { Authorization: 'Bearer ' + SB_KEY } : {}, opt.headers || {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined
  }), 9000);
  if (!r.ok) { const txt = await r.text().catch(() => ''); throw new Error('sb-' + r.status + ' ' + txt.slice(0, 200)); }
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

/* "20260922T161500.000Z" → ISO */
function zeit(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}
function mini(p) {
  const b = p.brawler || (p.brawlers && p.brawlers[0]) || {};
  return { t: String(p.tag || '').replace('#', ''), n: p.name || '', b: b.name || '', p: b.power || 0, tr: b.trophies || 0 };
}
/* Ein Eintrag aus dem Battlelog → eine kompakte Zeile */
function spiel(it, tag) {
  const b = it.battle || {}, ev = it.event || {};
  const bt = zeit(it.battleTime); if (!bt) return null;
  const ich = p => p && String(p.tag || '').toUpperCase().replace('#', '') === tag;
  let me = null, team = [], opp = [];
  if (Array.isArray(b.teams)) {
    b.teams.forEach(t => { if (t.some(ich)) { me = t.find(ich); team = t.filter(p => !ich(p)); } else opp = opp.concat(t); });
  } else if (Array.isArray(b.players)) {
    me = b.players.find(ich); opp = b.players.filter(p => !ich(p));
  }
  if (!me) return null;
  const br = me.brawler || (me.brawlers && me.brawlers[0]) || {};
  return {
    tag, bt,
    mode: b.mode || ev.mode || 'unknown',
    map: ev.map || null,
    map_id: ev.id || null,
    typ: b.type || null,
    brawler: br.name || null,
    power: br.power || null,
    btrophies: br.trophies != null ? br.trophies : null,
    result: b.result || null,
    rank: b.rank != null ? b.rank : null,
    tchange: b.trophyChange != null ? b.trophyChange : null,
    dur: b.duration || null,
    star: !!(b.starPlayer && ich(b.starPlayer)),
    team: team.map(mini),
    opp: opp.map(mini)
  };
}
function brawlerListe(p) {
  return (p.brawlers || []).map(b => ({
    name: b.name, power: b.power || 0, trophies: b.trophies || 0, highest: b.highestTrophies || 0, rank: b.rank || 0,
    gadgets: (b.gadgets || []).length, sp: (b.starPowers || []).length, gears: (b.gears || []).length, hyper: (b.hyperCharges || []).length,
    /* v115: IDs + Namen für die Bilder (Gadgets, Star Powers, Hypercharges, Gears) */
    gL: (b.gadgets || []).map(x => ({ id: x.id, n: x.name })),
    spL: (b.starPowers || []).map(x => ({ id: x.id, n: x.name })),
    hcL: (b.hyperCharges || []).map(x => ({ id: x.id, n: x.name })),
    geL: (b.gears || []).map(x => ({ id: x.id, n: x.name, lv: x.level || 0 }))
  }));
}
function spielerZeile(p, extra) {
  return Object.assign({
    tag: normTag(p.tag), name: p.name || '', trophies: p.trophies || 0, highest: p.highestTrophies || 0,
    level: p.expLevel || 0, club: (p.club && p.club.name) || null, icon: (p.icon && p.icon.id) || null,
    wins3: p['3vs3Victories'] || 0, solo: p.soloVictories || 0, duo: p.duoVictories || 0,
    brawlers: brawlerListe(p)
  }, extra || {});
}
function heute() { return new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10); } /* Tageswechsel ≈ deutsche Zeit */

/* Spalte map_id ist neu (Build 113). Solange sie in der Datenbank fehlt, ohne sie arbeiten. */
let MAPID_OK = true;
async function battlesSpeichern(zeilen) {
  const opt = z => ({ method: 'POST', body: z, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
  if (MAPID_OK) {
    try { return await sb('bs_battles?on_conflict=tag,bt', opt(zeilen)); }
    catch (e) { if (!/map_id/.test(e.message)) throw e; MAPID_OK = false; }
  }
  return sb('bs_battles?on_conflict=tag,bt', opt(zeilen.map(z => { const c = Object.assign({}, z); delete c.map_id; return c; })));
}
async function battlesLesen(tag, off) {
  const basis = 'bt,mode,map,typ,brawler,power,btrophies,result,rank,tchange,dur,star,team,opp';
  const url = f => 'bs_battles?tag=eq.' + tag + '&select=' + f + '&order=bt.desc&limit=1000&offset=' + off;
  if (MAPID_OK) {
    try { return await sb(url(basis + ',map_id')); }
    catch (e) { if (!/map_id/.test(e.message)) throw e; MAPID_OK = false; }
  }
  return sb(url(basis));
}

/* Holt Profil + Battlelog und speichert alles. Gibt das Profil zurück. */
async function syncTag(tag, mitProfil, vorab) {
  const log = await bs('/players/%23' + tag + '/battlelog');
  const zeilen = (log.items || []).map(it => spiel(it, tag)).filter(Boolean);
  const meta = (log.items || []).map(it => metaZeile(it, tag)).filter(Boolean);
  await Promise.all([zeilen.length ? battlesSpeichern(zeilen) : null, metaSpeichern(meta).catch(() => 0)]);
  let profil = null;
  const upd = { last_fetch: new Date().toISOString(), fails: 0 };
  if (mitProfil) {
    profil = vorab || await bs('/players/%23' + tag);
    const z = spielerZeile(profil, upd);
    z.daily_day = heute();
    await sb('bs_players?on_conflict=tag', { method: 'POST', body: [z], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    await sb('bs_daily?on_conflict=tag,day', { method: 'POST', body: [{ tag, day: z.daily_day, trophies: z.trophies, br: z.brawlers.map(b => [b.name, b.power, b.trophies]) }], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  } else {
    await sb('bs_players?tag=eq.' + tag, { method: 'PATCH', body: upd, headers: { Prefer: 'return=minimal' } });
  }
  return { profil, neu: zeilen.length };
}

/* ════ v117 · Community-Meta ════
   Aus Battlelogs (Top-Spieler + getrackte Accounts) wird gezählt, wie oft welcher
   Brawler auf welcher Map gewinnt. Gespeichert werden nur Tagessummen.
   Ein Match wird über einen Schlüssel (Zeit + Map + alle Spieler) nur einmal gezählt. */
const META_TYP = { ranked: 't', soloRanked: 'r', teamRanked: 'r' };
const crypto_ = require('crypto');
function metaZeile(it, owner) {
  const b = it.battle || {}, ev = it.event || {};
  const typ = META_TYP[b.type]; if (!typ) return null;
  const map_id = ev.id, map = ev.map; if (!map_id || !map) return null;
  const bt = zeit(it.battleTime); if (!bt) return null;
  const mode = b.mode || ev.mode; if (!mode || mode === 'unknown') return null;
  const tg = p => String((p && p.tag) || '').toUpperCase().replace('#', '');
  const nm = p => (p && p.brawler && p.brawler.name) ? String(p.brawler.name).toUpperCase() : null;
  owner = normTag(owner);
  const w = [], l = [], tags = [];
  if (/showdown/i.test(mode)) {
    /* Showdown: Liste ist nach Platz sortiert – prüfen wir am eigenen Platz. Sonst nur der eigene Eintrag. */
    const cut = /duo|trio/i.test(mode) ? 2 : 4, rang = b.rank;
    if (rang == null) return null;
    const gruppen = Array.isArray(b.teams) && b.teams.length ? b.teams : (Array.isArray(b.players) ? b.players.map(p => [p]) : null);
    if (!gruppen || !gruppen.length) return null;
    const idx = gruppen.findIndex(g => g.some(p => tg(p) === owner));
    if (idx < 0) return null;
    const sortiert = idx + 1 === rang;
    (sortiert ? gruppen : [gruppen[idx]]).forEach((g, i) => {
      const platz = sortiert ? i + 1 : rang;
      g.forEach(p => { const n = nm(p); if (!n) return; tags.push(tg(p)); (platz <= cut ? w : l).push(n); });
    });
  } else {
    if (!Array.isArray(b.teams) || b.teams.length !== 2) return null;
    const [a, c] = b.teams;
    if (!a.length || a.length !== c.length || a.length > 5) return null;
    if (b.result !== 'victory' && b.result !== 'defeat') return null;
    const meinA = a.some(p => tg(p) === owner), meinC = c.some(p => tg(p) === owner);
    if (meinA === meinC) return null;
    const sieger = (meinA === (b.result === 'victory')) ? a : c, verlierer = sieger === a ? c : a;
    for (const p of sieger) { const n = nm(p); if (!n) return null; w.push(n); tags.push(tg(p)); }
    for (const p of verlierer) { const n = nm(p); if (!n) return null; l.push(n); tags.push(tg(p)); }
  }
  if (!w.length && !l.length) return null;
  const k = crypto_.createHash('md5').update(bt + '|' + map_id + '|' + typ + '|' + tags.sort().join(',')).digest('base64url');
  return { k, bt, map_id, map, mode, typ, w, l };
}
let META_OK = true;
async function metaSpeichern(zeilen) {
  if (!META_OK || !SB_KEY || !zeilen || !zeilen.length) return 0;
  let neu = 0;
  for (let i = 0; i < zeilen.length; i += 400) {
    try { neu += (await sb('rpc/bs_meta_add', { method: 'POST', body: { rows: zeilen.slice(i, i + 400) } })) || 0; }
    catch (e) { if (/sb-404|PGRST202|does not exist|Could not find/.test(e.message)) { META_OK = false; return neu; } throw e; }
  }
  return neu;
}
const LAENDER = ['DE', 'US', 'BR', 'FR', 'ES', 'IT', 'TR', 'PL', 'GB', 'MX', 'KR', 'JP', 'NL', 'AR', 'CA', 'ID', 'PH', 'VN', 'TH', 'SA', 'EG', 'CL', 'CO', 'PE', 'AT', 'CH', 'BE', 'SE', 'PT', 'UA'];
async function metaSammeln(budget, anzahl, laender) {
  const t0 = Date.now(), h = Math.floor(Date.now() / 1800e3);
  const listen = ['global'];
  for (let j = 0; j < (laender || 1); j++) listen.push(LAENDER[(h * (laender || 1) + j) % LAENDER.length]);
  let tags = [];
  const res = await Promise.allSettled(listen.map(cc => bs('/rankings/' + cc + '/players?limit=200', 4000)));
  res.forEach(r => { if (r.status === 'fulfilled') ((r.value && r.value.items) || []).forEach(p => tags.push(normTag(p.tag))); });
  tags = [...new Set(tags)].filter(t => TAG_OK.test(t));
  for (let i = tags.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = tags[i]; tags[i] = tags[j]; tags[j] = x; }
  tags = tags.slice(0, anzahl);
  const zeilen = []; let i = 0, logs = 0, fehler = 0;
  async function arbeiter() {
    while (i < tags.length && Date.now() - t0 < budget) {
      const t = tags[i++];
      try { const log = await bs('/players/%23' + t + '/battlelog', 3500); logs++; (log.items || []).forEach(it => { const z = metaZeile(it, t); if (z) zeilen.push(z); }); }
      catch (e) { fehler++; }
    }
  }
  await Promise.all(Array.from({ length: 8 }, arbeiter));
  let neu = 0, dbErr;
  try { neu = await metaSpeichern(zeilen); } catch (e) { dbErr = String(e.message).slice(0, 80); }
  return { dbErr, listen: listen.join(','), logs, fehler, zeilen: zeilen.length, neu, ms: Date.now() - t0 };
}
async function metaAufraeumen() {
  const alt = new Date(Date.now() - 3 * 864e5).toISOString(), tag = new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10);
  await sb('bs_meta_seen?bt=lt.' + encodeURIComponent(alt), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await sb('bs_meta?day=lt.' + tag, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

// ════════════════════════════════════════════════════════════════════
// bs-profil · öffentlicher Profil-Link  /p/TAG  (Umleitung in netlify.toml)
//   Liefert eine kleine Seite mit Titel, Beschreibung und Vorschaubild
//   (für WhatsApp, Discord, Instagram …) und leitet sofort zum Profil weiter.
// ════════════════════════════════════════════════════════════════════
const xa = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function zahlP(n) { return String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  let roh = String(q.tag || '').split('/')[0];
  const tag = normTag(roh), host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '';
  const basis = host ? 'https://' + host : '';
  const ziel = TAG_OK.test(tag) ? '/?p=' + tag : '/';
  let titel = 'Brawl-Stars-Profil | Slesdrafts', text = 'Profil, Brawler-Pool, Ranked-Rang und Statistiken – auf Slesdrafts.', bild = basis + '/og-image.png', ok = false;
  if (TAG_OK.test(tag) && BS_KEY) {
    try {
      const p = await bs('/players/%23' + tag, 4500);
      const top = (p.brawlers || []).slice().sort((a, b) => (b.trophies || 0) - (a.trophies || 0)).slice(0, 3).map(b => String(b.name || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()));
      titel = (p.name || '#' + tag) + ' (#' + tag + ') – Brawl-Stars-Profil | Slesdrafts';
      text = zahlP(p.trophies) + ' Pokale · Rekord ' + zahlP(p.highestTrophies) + (p.club && p.club.name ? ' · Club ' + p.club.name : '') + (top.length ? ' · Top: ' + top.join(', ') : '') + ' – Pool, Ranked-Rang & Statistiken auf Slesdrafts.';
      bild = basis + '/.netlify/functions/bs-og?tag=' + tag + '&v=' + new Date().toISOString().slice(0, 10);
      ok = true;
    } catch (e) { }
  }
  const url = basis + '/p/' + tag;
  const html = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + xa(titel) + '</title><meta name="description" content="' + xa(text) + '">'
    + '<meta property="og:type" content="profile"><meta property="og:site_name" content="Slesdrafts"><meta property="og:title" content="' + xa(titel) + '"><meta property="og:description" content="' + xa(text) + '">'
    + '<meta property="og:url" content="' + xa(url) + '"><meta property="og:image" content="' + xa(bild) + '"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
    + '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="' + xa(titel) + '"><meta name="twitter:description" content="' + xa(text) + '"><meta name="twitter:image" content="' + xa(bild) + '">'
    + '<meta name="theme-color" content="#7b6ff5"><link rel="canonical" href="' + xa(url) + '"><meta http-equiv="refresh" content="0;url=' + xa(ziel) + '">'
    + '<script>location.replace(' + JSON.stringify(ziel) + ')</script></head>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0a14;color:#ececf4;font-family:system-ui,sans-serif">'
    + '<a href="' + xa(ziel) + '" style="color:#a78bfa">Profil öffnen …</a></body></html>';
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Netlify-CDN-Cache-Control': ok ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'no-store' }, body: html };
};
