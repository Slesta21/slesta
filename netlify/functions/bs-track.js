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
  /* Star-Spieler der Runde in den Team-/Gegner-Daten markieren (s: 1) */
  const starTag = b.starPlayer ? String(b.starPlayer.tag || '').toUpperCase().replace('#', '') : '';
  const mk = p => { const m = mini(p); if (starTag && m.t.toUpperCase() === starTag) m.s = 1; return m; };
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
    team: team.map(mk),
    opp: opp.map(mk)
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

/* Ranked-Elo steht nicht im Battlelog (dort nur die Rang-Stufe 1–22), sondern im Profil.
   Jeder neue Stand landet in bs_ranked. Solange die Tabelle fehlt, ohne sie arbeiten. */
let RANKED_OK = true;
function rankedAus(p) {
  if (!p || p.rankedElo == null) return null;
  const n = v => v != null ? v : null;
  return { elo: p.rankedElo, rank: n(p.rankedRank), season: n(p.rankedSeasonId), s_elo: n(p.highestSeasonRankedElo), s_rank: n(p.highestSeasonRankedRank), a_elo: n(p.highestAllTimeRankedElo), a_rank: n(p.highestAllTimeRankedRank) };
}
function rankedFehler(e) { if (/bs_ranked/.test(e.message)) RANKED_OK = false; }
async function rankedLetzter(tag) {
  if (!RANKED_OK) return null;
  try { const r = await sb('bs_ranked?tag=eq.' + tag + '&select=t,elo,rank&order=t.desc&limit=1'); return (r && r[0]) || null; }
  catch (e) { rankedFehler(e); return null; }
}
async function rankedSpeichern(tag, p, letzter) {
  const r = rankedAus(p);
  if (!r || !RANKED_OK || (letzter && letzter.elo === r.elo && letzter.rank === r.rank)) return;
  try { await sb('bs_ranked', { method: 'POST', body: [Object.assign({ tag, t: new Date().toISOString() }, r)], headers: { Prefer: 'return=minimal' } }); }
  catch (e) { rankedFehler(e); }
}
async function rankedVerlauf(tag) {
  if (!RANKED_OK) return [];
  try { return (await sb('bs_ranked?tag=eq.' + tag + '&select=t,elo,rank,season,s_elo,s_rank,a_elo,a_rank&order=t.asc&limit=3000')) || []; }
  catch (e) { rankedFehler(e); return []; }
}

/* Elo der Mitspieler und Gegner: einmal während das Set läuft (vorher) und direkt nach dem Set-Ende (nachher)
   aus ihrem Profil festhalten → daraus ergibt sich ihre genaue Elo-Änderung für dieses Set. */
async function andereElo(zeilen) {
  if (!RANKED_OK) return;
  const rk = zeilen.filter(z => z.typ === 'soloRanked').sort((a, b) => a.bt < b.bt ? 1 : -1);
  if (!rk.length) return;
  const key = z => (z.opp || []).map(p => p.t).sort().join(',');
  const set = [];
  for (const z of rk) {
    if (set.length && (key(z) !== key(set[0]) || Date.parse(set[set.length - 1].bt) - Date.parse(z.bt) > 25 * 6e4)) break;
    set.push(z);
  }
  let w = 0, l = 0;
  set.forEach(z => { if (z.result === 'victory') w++; else if (z.result === 'defeat') l++; });
  const fertig = w >= 2 || l >= 2, ende = Date.parse(set[0].bt), start = Date.parse(set[set.length - 1].bt) - 5 * 6e4;
  if (fertig && (Date.now() - ende > 20 * 6e4 || Date.now() - ende < 90e3)) return; /* nach dem Set 90 s warten, bis die neue Elo im Profil steht */
  const tags = [...new Set([].concat(...set.map(z => (z.team || []).concat(z.opp || []).map(p => normTag(p.t)))))].filter(t => TAG_OK.test(t));
  if (!tags.length) return;
  let da;
  try { da = await sb('bs_ranked?tag=in.(' + tags.join(',') + ')&t=gte.' + encodeURIComponent(new Date(fertig ? ende + 90e3 : start).toISOString()) + '&select=tag'); }
  catch (e) { rankedFehler(e); return; }
  const hat = new Set((da || []).map(r => r.tag));
  await Promise.all(tags.filter(t => !hat.has(t)).slice(0, 5).map(async t => {
    try {
      const r = rankedAus(await bs('/players/%23' + t, 4000));
      if (r) await sb('bs_ranked', { method: 'POST', body: [Object.assign({ tag: t, t: new Date().toISOString() }, r)], headers: { Prefer: 'return=minimal' } });
    } catch (e) { rankedFehler(e); }
  }));
}

/* Holt Profil + Battlelog und speichert alles. Gibt das Profil zurück. */
async function syncTag(tag, mitProfil, vorab) {
  const log = await bs('/players/%23' + tag + '/battlelog');
  const zeilen = (log.items || []).map(it => spiel(it, tag)).filter(Boolean);
  const meta = (log.items || []).map(it => metaZeile(it, tag)).filter(Boolean);
  await Promise.all([zeilen.length ? battlesSpeichern(zeilen) : null, metaSpeichern(meta).catch(() => 0)]);
  await andereElo(zeilen).catch(() => 0);
  let profil = null;
  const upd = { last_fetch: new Date().toISOString(), fails: 0 };
  /* Profil (für die Elo) auch dann holen, wenn seit dem letzten Elo-Stand Ranked gespielt wurde */
  const rkZeit = zeilen.filter(z => z.typ === 'soloRanked').reduce((m, z) => z.bt > m ? z.bt : m, '');
  const letzter = rkZeit || mitProfil ? await rankedLetzter(tag) : null;
  /* so lange nachmessen, bis ein Stand mind. 90 s nach der letzten Ranked-Runde da ist (Brawl Stars aktualisiert die Elo mit Verzögerung) */
  const rkNeu = !!rkZeit && RANKED_OK && (!letzter || Date.parse(letzter.t) < Date.parse(rkZeit) + 90e3);
  if (mitProfil) {
    profil = vorab || await bs('/players/%23' + tag);
    const z = spielerZeile(profil, upd);
    z.daily_day = heute();
    await sb('bs_players?on_conflict=tag', { method: 'POST', body: [z], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
    await sb('bs_daily?on_conflict=tag,day', { method: 'POST', body: [{ tag, day: z.daily_day, trophies: z.trophies, br: z.brawlers.map(b => [b.name, b.power, b.trophies]) }], headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  } else {
    if (rkNeu) { try { profil = await bs('/players/%23' + tag); } catch (e) { } }
    await sb('bs_players?tag=eq.' + tag, { method: 'PATCH', body: upd, headers: { Prefer: 'return=minimal' } });
  }
  if (profil) await rankedSpeichern(tag, profil, rkNeu ? null : letzter);
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
// bs-track · Account-Tab von Slesdrafts
//   GET ?tag=XXXX[&sync=1][&peek=1]  → Profil + gespeicherte Matches + Tagesverlauf
//   Nicht bestätigte Accounts werden nur live angezeigt (letzte 25 Matches).
//   claim=start / claim=check&token=… → Account per Profilbild-Wechsel bestätigen, dann wird getrackt.
// Beim ersten Aufruf wird der Tag registriert; danach holt bs-cron alle
// 30 Minuten automatisch neue Matches (die API zeigt nur die letzten 25).
// Benötigt: BRAWLSTARS_API_KEY, SUPABASE_SERVICE_ROLE_KEY (+ SQL-Datei).
// Ohne Supabase-Schlüssel: nur die letzten 25 Matches, nichts gespeichert.
// ════════════════════════════════════════════════════════════════════
const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const crypto = require('crypto');
/* v115: Nur eigene Accounts werden getrackt. Beweis: Profilbild innerhalb weniger
   Minuten ändern. Der Start-Zustand steckt signiert im Token – keine Extra-Tabelle nötig. */
const GEHEIM = process.env.CLAIM_SECRET || ('sd|' + SB_KEY + '|' + BS_KEY);
function signiere(o) { const body = Buffer.from(JSON.stringify(o)).toString('base64url'); return body + '.' + crypto.createHmac('sha256', GEHEIM).update(body).digest('base64url'); }
function pruefe(tok) {
  const [body, sig] = String(tok || '').split('.'); if (!body || !sig) return null;
  const soll = crypto.createHmac('sha256', GEHEIM).update(body).digest('base64url');
  if (sig.length !== soll.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(soll))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
}
const FRIST = 120000, GUELTIG = 420000;   /* 2 Min. zum Ändern, bis 7 Min. warten wir auf Brawl Stars */
const aus = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (!BS_KEY) return aus(501, { error: 'no-key' });
  const q = event.queryStringParameters || {};
  const tag = normTag(q.tag);
  if (!TAG_OK.test(tag)) return aus(400, { error: 'bad-tag' });

  try {
    /* ── ohne Datenbank: nur live ── */
    if (!SB_KEY) {
      const [p, log] = await Promise.all([bs('/players/%23' + tag), bs('/players/%23' + tag + '/battlelog')]);
      const battles = (log.items || []).map(it => spiel(it, tag)).filter(Boolean);
      return aus(200, { speicher: false, player: spielerZeile(p), battles, daily: [], ranked: rankedAus(p), rankedVerlauf: [] });
    }

    /* ── mit Datenbank ── */
    const vorh = await sb('bs_players?tag=eq.' + tag + '&select=tag,last_fetch,added_at,daily_day');
    const row = vorh && vorh[0];

    /* ── Account bestätigen (Profilbild ändern) ── */
    if (q.claim === 'start') {
      if (row) return aus(200, { schon: true });
      const p = await bs('/players/%23' + tag);
      const t = Date.now(), icon = (p.icon && p.icon.id) || 0;
      return aus(200, { token: signiere({ tag, icon, t }), icon, name: p.name || '', start: t, frist: FRIST, gueltig: GUELTIG });
    }
    if (q.claim === 'check') {
      const v = pruefe(q.token);
      if (!v || v.tag !== tag) return aus(400, { error: 'bad-token' });
      if (row) return aus(200, { ok: true, schon: true });
      if (Date.now() - v.t > GUELTIG) return aus(410, { error: 'expired' });
      const p = await bs('/players/%23' + tag);
      const icon = (p.icon && p.icon.id) || 0;
      if (icon === v.icon) return aus(200, { ok: false, icon });
      if (Date.now() - v.t > GUELTIG) return aus(410, { error: 'expired' });
      await sb('bs_players?on_conflict=tag', { method: 'POST', body: [{ tag, last_seen: new Date().toISOString() }], headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
      await syncTag(tag, true, p);
      return aus(200, { ok: true });
    }
    /* Nicht bestätigte Accounts: nur live anschauen, nichts speichern (v115) */
    if (!row) {
      const [p, log] = await Promise.all([bs('/players/%23' + tag), bs('/players/%23' + tag + '/battlelog')]);
      const battles = (log.items || []).map(it => spiel(it, tag)).filter(Boolean);
      return aus(200, { speicher: false, peek: true, player: spielerZeile(p), battles, daily: [], ranked: rankedAus(p), rankedVerlauf: [] });
    }
    /* live=1: der offene Ranked-Tab fragt etwa jede Minute nach – dann schon nach 50 s neu holen */
    const alt = !row || !row.last_fetch || (Date.now() - Date.parse(row.last_fetch)) > (q.live === '1' ? 50e3 : 150e3);
    let player = null, ranked = null;
    if (!row || q.sync === '1' && alt) {
      /* erst prüfen, ob es den Spieler gibt – ungültige IDs werden nie gespeichert */
      const vorab = await bs('/players/%23' + tag);
      if (!row) await sb('bs_players?on_conflict=tag', { method: 'POST', body: [{ tag, last_seen: new Date().toISOString() }], headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } });
      const s = await syncTag(tag, true, vorab);
      player = s.profil ? spielerZeile(s.profil) : null;
      ranked = rankedAus(s.profil);
    }
    await sb('bs_players?tag=eq.' + tag, { method: 'PATCH', body: { last_seen: new Date().toISOString() }, headers: { Prefer: 'return=minimal' } });

    const [prow, daily, rkVerlauf] = await Promise.all([
      sb('bs_players?tag=eq.' + tag + '&select=*'),
      sb('bs_daily?tag=eq.' + tag + '&select=day,trophies,br&order=day.asc&limit=400'),
      rankedVerlauf(tag)
    ]);
    if (!ranked && rkVerlauf.length) ranked = rkVerlauf[rkVerlauf.length - 1];
    const battles = [];
    for (let off = 0; off < 6000; off += 1000) {
      const teil = await battlesLesen(tag, off);
      battles.push.apply(battles, teil || []);
      if (!teil || teil.length < 1000) break;
    }
    /* Elo-Schnappschüsse der Mitspieler und Gegner aus den letzten 14 Tagen (für die Elo-Änderung pro Set) */
    let rankedAndere = {};
    if (RANKED_OK) {
      const grenze14 = Date.now() - 14 * 864e5, andere = new Set();
      battles.forEach(b => { if (b.typ === 'soloRanked' && Date.parse(b.bt) >= grenze14) (b.team || []).concat(b.opp || []).forEach(p => { const t = normTag(p.t); if (TAG_OK.test(t)) andere.add(t); }); });
      const liste = [...andere].slice(0, 250);
      if (liste.length) {
        try {
          const rows = await sb('bs_ranked?tag=in.(' + liste.join(',') + ')&t=gte.' + encodeURIComponent(new Date(grenze14).toISOString()) + '&select=tag,t,elo&order=t.asc&limit=5000');
          (rows || []).forEach(r => { (rankedAndere[r.tag] = rankedAndere[r.tag] || []).push([r.t, r.elo]); });
        } catch (e) { rankedFehler(e); }
      }
    }
    const pr = (prow && prow[0]) || {};
    if (!player) player = { tag, name: pr.name, trophies: pr.trophies, highest: pr.highest, level: pr.level, club: pr.club, icon: pr.icon, wins3: pr.wins3, solo: pr.solo, duo: pr.duo, brawlers: pr.brawlers || [] };
    return aus(200, { speicher: true, seit: pr.added_at, letzte: pr.last_fetch, player, battles, daily: daily || [], ranked, rankedVerlauf: rkVerlauf, rankedAndere });
  } catch (e) {
    const st = e.status;
    if (st === 404) return aus(404, { error: 'not-found' });
    if (st === 403) return aus(502, { error: 'key-rejected' });
    if (st === 429) return aus(429, { error: 'rate-limit' });
    if (st === 503) return aus(503, { error: 'maintenance' });
    if (/^sb-/.test(e.message)) return aus(500, { error: 'db', info: e.message.slice(0, 160) });
    return aus(502, { error: 'network', info: String(e.message || e).slice(0, 120) });
  }
};
