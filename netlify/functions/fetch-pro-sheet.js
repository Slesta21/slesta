/**
 * Netlify Function: fetch-pro-sheet (v5, Build 138: liest die Supabase-Kopie von pro-sheet-sync)
 * Now includes player names in match data so the detail modal can show
 * who played which brawler.
 */

/* Per-filter cache: { all: {data, ts}, teamsOnly: {data, ts} } */
const zlib = require('zlib');
let cacheStore = {};
/* Das Sheet aktualisiert sich alle fuenf Minuten. Bei dreissig Minuten
   Haltbarkeit stand oben ein Stand von vor Stunden — der Zwischen-
   speicher war schlicht traeger als die Quelle. */
const CACHE_TTL = 4 * 60 * 1000;
/* Share raw CSV fetch across endpoints within this window */
const CSV_TTL = 60 * 1000;
let csvCache = null;
let csvCacheTs = 0;
let csvFetching = null;

/* Aus einem Bearbeiten-/Veröffentlichen-Link einen CSV-Link machen – und eine zweite Variante als Ausweich. */
function csvUrls(raw) {
  const u = String(raw || '').trim();
  const gidM = u.match(/[#&?]gid=(\d+)/), gid = gidM ? gidM[1] : null;
  const pub = u.match(/\/spreadsheets\/d\/e\/([\w-]+)/);
  if (pub) {
    const basis = 'https://docs.google.com/spreadsheets/d/e/' + pub[1] + '/pub?output=csv' + (gid ? '&gid=' + gid : '');
    return /output=csv/.test(u) ? [u, basis] : [basis];
  }
  const id = u.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (id) {
    const exp = 'https://docs.google.com/spreadsheets/d/' + id[1] + '/export?format=csv' + (gid ? '&gid=' + gid : '');
    const gviz = 'https://docs.google.com/spreadsheets/d/' + id[1] + '/gviz/tq?tqx=out:csv' + (gid ? '&gid=' + gid : '');
    return /format=csv|out:csv|output=csv/.test(u) ? [...new Set([u, exp, gviz])] : [exp, gviz];
  }
  return [u];
}
function sheetFehler(code, detail) { const e = new Error(code + (detail ? ': ' + detail : '')); e.code = code; return e; }
async function holeEinmal(url, ms) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 Slesdrafts' } });
    if (!r.ok) throw sheetFehler('sheet-http-' + r.status);
    const text = await r.text();
    const kopf = text.slice(0, 300).trim().toLowerCase();
    /* Google liefert eine Login- oder Fehlerseite statt CSV, wenn das Sheet nicht (mehr) öffentlich ist */
    if (kopf.startsWith('<!doctype') || kopf.startsWith('<html') || kopf.indexOf('<head') >= 0) throw sheetFehler('sheet-not-public');
    if (text.length < 20) throw sheetFehler('sheet-empty');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw sheetFehler('sheet-timeout');
    throw e.code ? e : sheetFehler('sheet-network', e.message);
  } finally { clearTimeout(timer); }
}
/* Kopie in Supabase Storage – pro-sheet-sync legt sie alle 5 Minuten ab */
const SB_URL = (process.env.SUPABASE_URL || 'https://ddtnhnwdszeddegctlag.supabase.co').replace(/\/$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
function sbKopf() { return Object.assign({ apikey: SB_KEY }, /^eyJ/.test(SB_KEY) ? { Authorization: 'Bearer ' + SB_KEY } : {}); }
async function ausSpeicher(name, ms, roh) {
  if (!SB_KEY) return null;
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(SB_URL + '/storage/v1/object/pro-sheet/' + name, { headers: sbKopf(), signal: ctrl.signal });
    if (!r.ok) return null;
    const lm = Date.parse(r.headers.get('last-modified') || ''), alter = isNaN(lm) ? null : Date.now() - lm;
    if (roh) return { buf: Buffer.from(await r.arrayBuffer()), alter };
    if (/\.gz$/.test(name)) return { text: zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'), alter };
    return { text: await r.text(), alter };
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
/* CSV-Kopie: neu gzip-komprimiert, sonst die alte unkomprimierte */
async function csvKopie(ms) { return (await ausSpeicher('latest.csv.gz', ms)) || (await ausSpeicher('latest.csv', ms)); }
let csvQuelle = null;
async function vonGoogle(sheetUrl, budget) {
  const urls = csvUrls(sheetUrl), start = Date.now();
  let letzterFehler = null;
  for (const url of urls) {
    const rest = budget - (Date.now() - start);
    if (rest < 1500) break;
    try { return await holeEinmal(url, rest); } catch (e) { letzterFehler = e; }
  }
  throw letzterFehler || sheetFehler('sheet-timeout');
}
async function fetchCSV(sheetUrl, force) {
  const now = Date.now();
  if (!force && csvCache && (now - csvCacheTs) < CSV_TTL) return csvCache;
  if (!force && csvFetching) return csvFetching;
  csvFetching = (async () => {
    try {
      const kopie = await csvKopie(6000);
      /* frische Kopie (unter 8 Min.) reicht – Google nicht abwarten */
      if (!force && kopie && kopie.alter != null && kopie.alter < 8 * 60e3) {
        csvCache = kopie.text; csvCacheTs = Date.now(); csvQuelle = { von: 'speicher', alterSek: Math.round(kopie.alter / 1000) };
        return kopie.text;
      }
      try {
        const text = await vonGoogle(sheetUrl, kopie ? 5000 : 7500);
        csvCache = text; csvCacheTs = Date.now(); csvQuelle = { von: 'google' };
        return text;
      } catch (e) {
        if (kopie) {
          csvCache = kopie.text; csvCacheTs = Date.now();
          csvQuelle = { von: 'speicher-alt', alterSek: kopie.alter != null ? Math.round(kopie.alter / 1000) : null, googleFehler: e.code || e.message };
          return kopie.text;
        }
        if (csvCache) { csvQuelle = { von: 'ram-alt', googleFehler: e.code || e.message }; return csvCache; }
        throw e;
      }
    } finally {
      csvFetching = null;
    }
  })();
  return csvFetching;
}
/* Only the 6 main competitive modes — others (e.g. duels, brawl hockey,
   payload, etc.) are ignored. Filtering at the server lets us hold more
   useful matches in memory and ship a smaller response. */
const ALLOWED_MODES = new Set([
  'brawlBall', 'gemGrab', 'heist', 'hotZone', 'bounty', 'knockout',
  'Brawl Ball', 'Gem Grab', 'Heist', 'Hot Zone', 'Bounty', 'Knockout',
  'brawl_ball', 'gem_grab', 'hot_zone', 'knock_out',
  'BB', 'GG', 'HZ', 'HS', 'BO', 'KO',
  'bb', 'gg', 'hz', 'hs', 'bo', 'ko'
]);
function isAllowedMode(mode) {
  if (!mode) return false;
  if (ALLOWED_MODES.has(mode)) return true;
  const lower = String(mode).toLowerCase().replace(/[\s_-]/g, '');
  return lower === 'brawlball' || lower === 'gemgrab' || lower === 'heist' ||
         lower === 'hotzone' || lower === 'bounty' || lower === 'knockout';
}

/* Resolve mode name to short canonical code matching the client */
function resolveModeCode(mode) {
  if (!mode) return null;
  const lower = String(mode).toLowerCase().replace(/[\s_-]/g, '');
  if (lower === 'brawlball' || lower === 'bb') return 'bb';
  if (lower === 'gemgrab' || lower === 'gg') return 'gg';
  if (lower === 'hotzone' || lower === 'hz') return 'hz';
  if (lower === 'heist' || lower === 'hs') return 'hs';
  if (lower === 'bounty' || lower === 'bo') return 'bo';
  if (lower === 'knockout' || lower === 'ko') return 'ko';
  return null;
}

/* Bumped from 6000 → 10000 ... but Netlify response limit pushes back —
   keep at 6000 which works reliably. Mode allowlist still trims irrelevant
   modes before this limit kicks in, so 6000 useful matches > 6000 mixed. */
const MAX_MATCHES_RETURNED = 6000;

/* Antwort-Objekt – auch von pro-sheet-sync zum Vorrechnen benutzt */
function vorName(filter, sinceNum) { return 'resp-' + (filter === 'teams' ? 'teams' : 'all') + '-' + (sinceNum || 0) + '.json.gz'; }
function baueDaten(csvText, filter, teamScope, playerScope, modeScope, mapScope, brawlersScope, sinceNum, statsOnly) {
  const result = parseAndAggregate(csvText, filter, teamScope, playerScope, modeScope, mapScope, brawlersScope, sinceNum, statsOnly);
  return {
    lastUpdate: new Date().toISOString(),
    totalMatches: result.totalParsed,
    filter: filter,
    stats: result.stats,
    matches: result.matches,
    brawlerPlayers: result.brawlerPlayers,
    raw: result.raw || null,
    fnVersion: result.fnVersion || null,
    truncated: !!result.truncated,
    statsForNewest: (result.statsForNewest === undefined ? null : result.statsForNewest),
    returnedBytes: result.returnedBytes || null
  };
}
exports.baueDaten = baueDaten;
exports.vorName = vorName;
exports.csvUrls = csvUrls;
exports.holeEinmal = holeEinmal;

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  /* Die Antwort mit 6000 Partien ist gut 5 MB gross – Netlify erlaubt 6 MB
     inklusive Verpackung, das ging zuletzt nicht mehr durch. Komprimiert
     sind es rund 1 MB. */
  const eh = event.headers || {};
  const gzipOk = /gzip/i.test(eh['accept-encoding'] || eh['Accept-Encoding'] || '');
  function antwort(body, cache, gz) {
    const h = Object.assign({}, headers, { 'Cache-Control': cache, Vary: 'Accept-Encoding' });
    if (gzipOk && (gz || body.length > 2048)) {
      h['Content-Encoding'] = 'gzip';
      return { statusCode: 200, headers: h, isBase64Encoded: true, body: (gz || zlib.gzipSync(body, { level: 5 })).toString('base64') };
    }
    if (!body && gz) body = zlib.gunzipSync(gz).toString('utf8');
    return { statusCode: 200, headers: h, body };
  }

  try {
    const now = Date.now();
    /* Read filter param: 'all' (default) or 'teams' (only matches with known team names) */
    const params = (event.queryStringParameters || {});
    const filter = params.filter === 'teams' ? 'teams' : 'all';
    const teamScope = params.team ? String(params.team).trim() : null;
    const playerScope = params.player ? String(params.player).trim() : null;
    const modeScope = params.mode && params.mode !== 'ALL' ? String(params.mode).trim() : null;
    const mapScope = params.map && params.map !== 'ALL' ? String(params.map).trim() : null;
    const sinceNum = params.since ? (parseInt(params.since,10)||0) : 0;
    const brawlersScope = params.brawlers ? String(params.brawlers).trim() : null;
    const fresh = params.fresh === '1' || params.fresh === 'true';
    /* Nur Partien mit Spielerwerten. Der Grund ist die Obergrenze: die
       6000 zurueckgegebenen Partien waren sonst voll mit alten Zeilen
       ohne Werte, und der Filter im Browser fand danach fast nichts. */
    const statsOnly = (params.statsOnly === '1' || params.statsOnly === 'true');
    var cacheKey;
    if (teamScope) cacheKey = 'team:' + teamScope;
    else if (playerScope) cacheKey = 'player:' + playerScope;
    else if (brawlersScope) cacheKey = 'brawlers:' + filter + ':' + brawlersScope;
    else if (modeScope || mapScope) cacheKey = 'filter:' + filter + ':' + (modeScope || '') + ':' + (mapScope || '');
    else cacheKey = filter;
    if (sinceNum) cacheKey += ':since:' + sinceNum;
    if (statsOnly) cacheKey += ':stats';

    const cacheH = fresh ? 'no-store' : 'public, max-age=120, stale-while-revalidate=120';
    if (!fresh && params.diag !== '1' && cacheStore[cacheKey] && (now - cacheStore[cacheKey].ts) < CACHE_TTL) {
      const c = cacheStore[cacheKey];
      return c.gz ? antwort('', cacheH, c.gz) : antwort(JSON.stringify(c.data), cacheH);
    }
    /* Standard-Abfrage: pro-sheet-sync hat die Antwort schon fertig gerechnet */
    const standard = !teamScope && !playerScope && !modeScope && !mapScope && !brawlersScope && !statsOnly && params.diag !== '1';
    if (standard) {
      const fertig = await ausSpeicher(vorName(filter, sinceNum), 5000, true);
      if (fertig && fertig.buf.length > 100) {
        if (!cacheStore[cacheKey] || cacheStore[cacheKey].ts < now - (fertig.alter || 0)) cacheStore[cacheKey] = { gz: fertig.buf, ts: now - (fertig.alter || 0) };
        return antwort('', cacheH, fertig.buf);
      }
    }

    const sheetUrl = process.env.GOOGLE_SHEET_URL;
    /* ?diag=1 zeigt, woran es hängt – ohne die Sheet-Adresse preiszugeben */
    if (params.diag === '1') {
      const info = { build: 139, sheetUrlGesetzt: !!sheetUrl, supabaseKeyGesetzt: !!SB_KEY, varianten: sheetUrl ? csvUrls(sheetUrl).length : 0 };
      const t0 = Date.now();
      const [st, kopie] = await Promise.all([ausSpeicher('status.json', 3000), csvKopie(6000)]);
      try { info.letzterSync = st ? JSON.parse(st.text) : null; } catch (e) { info.letzterSync = null; }
      info.kopie = kopie ? { kb: Math.round(kopie.text.length / 1024), alterMin: kopie.alter != null ? Math.round(kopie.alter / 6e4) : null } : null;
      if (sheetUrl) {
        const t1 = Date.now();
        try { const text = await vonGoogle(sheetUrl, 4000); info.google = { ok: true, kb: Math.round(text.length / 1024), ms: Date.now() - t1 }; }
        catch (e) { info.google = { ok: false, fehler: e.code || e.message, ms: Date.now() - t1 }; }
      }
      const quelle = (info.google && info.google.ok) || kopie;
      if (quelle && params.voll === '1') {
        try {
          const t2 = Date.now();
          const text = kopie && (!info.google || !info.google.ok) ? kopie.text : await fetchCSV(sheetUrl, false);
          const res = parseAndAggregate(text, 'all', null, null, null, null, null, 0, false);
          info.auswertung = { ok: true, partien: res.totalParsed, zurueck: res.matches.length, mb: Math.round((res.returnedBytes || 0) / 104857.6) / 10, ms: Date.now() - t2 };
        } catch (e) { info.auswertung = { ok: false, fehler: e.message }; }
      }
      const vor = await ausSpeicher(vorName('all', parseInt(params.since, 10) || 0), 4000, true);
      info.vorgerechnet = vor ? { kb: Math.round(vor.buf.length / 1024), alterMin: vor.alter != null ? Math.round(vor.alter / 6e4) : null } : null;
      info.msGesamt = Date.now() - t0;
      return { statusCode: 200, headers: Object.assign({}, headers, { 'Cache-Control': 'no-store' }), body: JSON.stringify(info) };
    }
    if (!sheetUrl) {
      return { statusCode: 500, headers,
        body: JSON.stringify({ error: 'GOOGLE_SHEET_URL environment variable not set' }) };
    }

    const csvText = await fetchCSV(sheetUrl, fresh);
    const data = baueDaten(csvText, filter, teamScope, playerScope, modeScope, mapScope, brawlersScope, sinceNum, statsOnly);
    data.quelle = csvQuelle;
    cacheStore[cacheKey] = { data: data, ts: now };
    return antwort(JSON.stringify(data), cacheH);


  } catch (error) {
    console.error('Function error:', error.message);
    /* Google hakt: lieber den letzten guten Stand zeigen als gar nichts */
    const k = Object.keys(cacheStore).find(x => x === ((event.queryStringParameters || {}).filter === 'teams' ? 'teams' : 'all')) || Object.keys(cacheStore)[0];
    if (k && cacheStore[k] && cacheStore[k].gz) return antwort('', 'no-store', cacheStore[k].gz);
    if (k && cacheStore[k]) {
      const alt = Object.assign({}, cacheStore[k].data, { stale: true, staleSeit: new Date(cacheStore[k].ts).toISOString(), staleGrund: error.code || error.message });
      return { statusCode: 200, headers: Object.assign({}, headers, { 'Cache-Control': 'no-store' }), body: JSON.stringify(alt) };
    }
    return {
      statusCode: 502, headers,
      body: JSON.stringify({ error: 'Failed to fetch pro scrim data', code: error.code || 'unknown', message: error.message })
    };
  }
};

/* ═══ Spalten anhand der Kopfzeile finden ══════════════════════════════
   Das Sheet wurde umgestellt: is_decisive steht jetzt weit vorne, alles
   danach ist verrutscht, und Liga/Region sind ganz entfallen. Feste
   Positionen waeren dabei still falsch geworden — deshalb wird hier die
   Kopfzeile gelesen. Kennt sie die Namen nicht, gilt die alte
   Reihenfolge weiter, damit ein aelteres Sheet nicht abreisst. */
function mapColumns(headerLine){
  var raw = parseCSVLine(headerLine || '');
  var ix = {};
  for (var i = 0; i < raw.length; i++){
    var k = String(raw[i] == null ? '' : raw[i])
              .replace(/^\uFEFF/, '')
              .replace(/["']/g, '')
              .trim().toLowerCase()
              .replace(/[\s-]+/g, '_');
    /* Erster Treffer gewinnt: eine doppelt benannte Spalte soll die
       richtige davor nicht ueberschreiben. */
    if (k && !(k in ix)) ix[k] = i;
  }
  function f(){
    for (var a = 0; a < arguments.length; a++){
      var n = arguments[a];
      if (n in ix) return ix[n];
    }
    return -1;
  }
  var named = ('team1_player1_brawler' in ix) || ('team1_name' in ix);
  if (!named){
    /* Alte Reihenfolge, unveraendert */
    /* Das alte Sheet kennt weder Bans noch Werte je Spieler. Ohne
       diese leeren Eintraege liefe perSide() auf undefined und JEDE
       Zeile waere in den Fehlerzweig gelaufen — es kaeme gar nichts an. */
    var none3 = { t1:[-1,-1,-1], t2:[-1,-1,-1] };
    var per = {};
    ['starpower','gadget','kills','deaths','damage','heal','latency','supers','objective']
      .forEach(function(k){ per[k] = { t1:none3.t1.slice(), t2:none3.t2.slice() }; });
    return { named:false,
      id:0, t1:1, t2:2, r1:3, r2:4, mode:5, map:6, date:7, dec:26,
      t1p:[8,9,10], t2p:[11,12,13], t1b:[14,15,16], t2b:[17,18,19],
      t1t:[20,21,22], t2t:[23,24,25],
      t1tier:27, t1reg:28, t2tier:29, t2reg:30,
      t1b_ban:[-1,-1,-1], t2b_ban:[-1,-1,-1],
      fpBrawler:-1, t1fp:-1, t2fp:-1,
      region:-1, regionGroup:-1, setId:-1, duration:-1,
      tourId:-1, tourTitle:-1, matchType:-1,
      per: per };
  }
  return { named:true,
    id:     f('battle_id','match_id','match_tag','id'),
    t1:     f('team1_name','team1'),
    t2:     f('team2_name','team2'),
    r1:     f('team1_result','result1'),
    r2:     f('team2_result','result2'),
    mode:   f('mode','game_mode'),
    map:    f('map_name','map'),
    date:   f('battle_time','date','battle_date'),
    dec:    f('is_decisive','decisive'),
    t1p:   [f('team1_player1'),f('team1_player2'),f('team1_player3')],
    t2p:   [f('team2_player1'),f('team2_player2'),f('team2_player3')],
    t1b:   [f('team1_player1_brawler'),f('team1_player2_brawler'),f('team1_player3_brawler')],
    t2b:   [f('team2_player1_brawler'),f('team2_player2_brawler'),f('team2_player3_brawler')],
    t1t:   [f('team1_player1_tag'),f('team1_player2_tag'),f('team1_player3_tag')],
    t2t:   [f('team2_player1_tag'),f('team2_player2_tag'),f('team2_player3_tag')],
    t1tier: f('team1_tier'), t1reg: f('team1_region'),
    t2tier: f('team2_tier'), t2reg: f('team2_region'),
    /* Neu im Sheet: die echten Bans je Team. Bisher musste die Seite
       ohne sie auskommen und hat im Quiz nur Comps gezeigt. */
    t1b_ban:[f('team1_ban1'),f('team1_ban2'),f('team1_ban3')],
    t2b_ban:[f('team2_ban1'),f('team2_ban2'),f('team2_ban3')],
    /* Werte je Spieler. Alle nach demselben Muster benannt, deshalb
       reicht eine Schleife statt sechsunddreissig Einzelzeilen. */
    /* Je Wert mehrere moegliche Spaltennamen. Das Sheet schreibt
       "healing", gesucht wurde "heal" — dadurch fehlte die Heilung
       vollstaendig. Aliase verhindern, dass eine einzelne Umbenennung
       im Sheet wieder eine ganze Spalte verschluckt. */
    per: (function(){
      var ALIAS = {
        starpower: ['starpower','star_power','sp'],
        gadget:    ['gadget','gadgets'],
        kills:     ['kills','kill','takedowns','elims'],
        deaths:    ['deaths','death','deaths_count'],
        damage:    ['damage','dmg','damage_dealt'],
        heal:      ['healing','heal','heals','healing_done'],
        latency:   ['latency','ping','ms'],
        supers:    ['supers','super','supers_used'],
        objective: ['objective','objectives','obj']
      };
      var out = {};
      for (var k in ALIAS){
        var names = ALIAS[k];
        out[k] = { t1:[], t2:[] };
        for (var p = 1; p <= 3; p++){
          var a1 = names.map(function(n){ return 'team1_player'+p+'_'+n; });
          var a2 = names.map(function(n){ return 'team2_player'+p+'_'+n; });
          out[k].t1.push(f.apply(null, a1));
          out[k].t2.push(f.apply(null, a2));
        }
      }
      return out;
    })(),
    /* Wer hatte First Pick, und was war der allererste Pick? */
    fpBrawler: f('first_pick_brawler'),
    t1fp: f('team1_first_pick'), t2fp: f('team2_first_pick'),
    /* Einordnung der Partie */
    region: f('region'), regionGroup: f('region_group'),
    setId: f('set_id'), duration: f('duration'),
    tourId: f('tournament_id'), tourTitle: f('tournament_title'),
    matchType: f('match_type') };
}

function parseAndAggregate(csvText, filter, teamScope, playerScope, modeScope, mapScope, brawlersScope, sinceNum, statsOnly) {
  const teamsOnly = filter === 'teams';
  const teamScopeLower = teamScope ? teamScope.toLowerCase() : null;
  const playerScopeLower = playerScope ? playerScope.toLowerCase() : null;
  /* Resolve modeScope to canonical short code (bb/gg/hz/hs/bo/ko) */
  const modeScopeCanon = modeScope ? resolveModeCode(modeScope) : null;
  const mapScopeLower = mapScope ? mapScope.toLowerCase() : null;
  function _fnNormBr(s){ return String(s==null?'':s).toLowerCase().replace(/[^a-z0-9]/g,''); }
  const brawlersScopeSet = brawlersScope ? new Set(brawlersScope.split(',').map(s => _fnNormBr(s)).filter(Boolean)) : null;
  const singleBrawler = (brawlersScopeSet && brawlersScopeSet.size === 1) ? Array.from(brawlersScopeSet)[0] : null;
  const brawlerPlayerAgg = singleBrawler ? {} : null;
  function isKnownTeam(t) {
    if (!t) return false;
    const lower = t.toLowerCase();
    return lower !== 'unknown' && lower !== 'tbd' && lower !== '?';
  }
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return { stats: {}, matches: [], totalParsed: 0 };

  const dataLines = lines.slice(1);
  /* Spalten ueber die Kopfzeile finden, nicht ueber feste Positionen.
     Vorher war jede Position fest verdrahtet — eine eingefuegte oder
     verschobene Spalte im Sheet hat alles danach still verschoben, und
     es kamen einfach weniger oder falsche Matches an. */
  const C = mapColumns(lines[0]);
  const _sinceFmt = sinceNum ? _fnDetectFmt(dataLines, C.date) : null;
  /* So viele Spalten braucht eine Zeile mindestens, damit Teams,
     Spieler und Brawler vollstaendig drinstehen. */
  const MIN_COLS = Math.max.apply(null,
    [C.map, C.date].concat(C.t1p, C.t2p, C.t1b, C.t2b).filter(function(x){ return x >= 0; })) + 1;
  const stats = {};
  const matches = [];
  /* Rohzaehler fuer die Diagnose */
  const RAW = { rows:0, kills:0, damage:0, sample:null,
                /* Wo bleiben die Zeilen MIT Werten haengen? */
                statsRows:0, statsAfterSince:0, statsAfterMode:0, statsKept:0,
                oldestStats:0, newestStats:0 };
  let parsedCount = 0;
  let errorCount = 0;

  for (let i = 0; i < dataLines.length; i++) {
    try {
      const line = dataLines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      if (cols.length < MIN_COLS) continue;
      const at = function(ix){ return ix >= 0 ? safeStr(cols[ix]) : ''; };
      /* Zahl oder null — ein leeres Feld ist keine Null. */
      const num = function(ix){
        if (ix < 0) return null;
        var v = safeStr(cols[ix]).replace(/[^0-9.\-]/g, '');
        if (v === '' || v === '-') return null;
        var n = Number(v);
        return isFinite(n) ? n : null;
      };
      const NUMERIC = { kills:1, deaths:1, damage:1, heal:1, latency:1, supers:1, objective:1 };
      /* Kurze Schluessel und nur belegte Felder. Ausgeschrieben und mit
         allen Leerwerten wurde die Antwort 9,26 MB gross — Netlify
         verwirft ueber 6 MB, und die Seite bekam gar nichts. */
      const SHORT = { kills:'k', deaths:'d', damage:'dm', heal:'h',
                      latency:'l', supers:'s', objective:'o',
                      starpower:'sp', gadget:'g' };
      /* Ground truth: zaehlen, was in den ROHEN Zellen steht — bevor
         irgendeine Umwandlung stattfindet. Nur so laesst sich sagen, ob
         das Sheet leer ist oder die Verarbeitung etwas verschluckt. */
      if (C.per && C.per.kills){
        var _kIx = C.per.kills.t1[0];
        var _dIx = C.per.damage.t1[0];
        if (_kIx >= 0 && safeStr(cols[_kIx]) !== '') RAW.kills++;
        if (_dIx >= 0 && safeStr(cols[_dIx]) !== '') RAW.damage++;
        RAW.rows++;
        if (RAW.sample === null && _kIx >= 0){
          RAW.sample = { col:_kIx, cells:cols.length,
                         val:safeStr(cols[_kIx]), dmg:safeStr(cols[_dIx]) };
        }
      }
      const perSide = function(side){
        if (!C.per) return null;
        var out = [], any = false;
        for (var pi = 0; pi < 3; pi++){
          var o = null;
          for (var k in C.per){
            var ix = C.per[k][side][pi];
            var v = NUMERIC[k] ? num(ix) : at(ix);
            if (v === null || v === '' || v === undefined) continue;
            if (!o) o = {};
            o[SHORT[k] || k] = v;
            any = true;
          }
          out.push(o);
        }
        /* Hat kein Spieler Werte, faellt das Feld ganz weg. */
        return any ? out : null;
      };

      const matchTag = at(C.id);
      const team1 = at(C.t1);
      const team2 = at(C.t2);
      const team1Result = at(C.r1);
      const team2Result = at(C.r2);
      const mode = at(C.mode);
      const map = at(C.map);
      const date = at(C.date);

      /* Traegt diese Zeile Werte? Vor jedem Filter festhalten, damit
         sich hinterher sagen laesst, welcher Schritt sie geschluckt hat. */
      var _hasVal = false;
      try{
        if (C.per && C.per.kills){
          var _ki = C.per.kills.t1[0], _di = C.per.damage.t1[0];
          _hasVal = (_ki >= 0 && safeStr(cols[_ki]) !== '') ||
                    (_di >= 0 && safeStr(cols[_di]) !== '');
        }
      }catch(e){}
      if (_hasVal){
        RAW.statsRows++;
        var _rd = _fnRowDate(date, _sinceFmt || 'D/M/Y');
        if (_rd){
          if (!RAW.oldestStats || _rd < RAW.oldestStats) RAW.oldestStats = _rd;
          if (_rd > RAW.newestStats) RAW.newestStats = _rd;
        }
      }
      /* Beim Werte-Filter zaehlt der Stichtag nicht: sonst faellt genau
         das weg, was man sehen will. */
      if (sinceNum && !statsOnly) { var _dn = _fnRowDate(date, _sinceFmt); if (_dn && _dn < sinceNum) continue; }
      if (_hasVal) RAW.statsAfterSince++;
      if (!mode || !map) continue;
      if (!isAllowedMode(mode)) continue;
      /* Mode/Map scope filter */
      if (modeScopeCanon) {
        const modeCanon = resolveModeCode(mode);
        if (!modeCanon || modeCanon !== modeScopeCanon) continue;
      }
      if (mapScopeLower && map.toLowerCase() !== mapScopeLower) continue;
      /* If teams-only filter, skip matches where either team is unknown */
      if (teamsOnly && (!isKnownTeam(team1) || !isKnownTeam(team2))) continue;
      /* If team scope, only include matches involving that team */
      if (teamScopeLower) {
        const t1Low = team1.toLowerCase();
        const t2Low = team2.toLowerCase();
        if (t1Low !== teamScopeLower && t2Low !== teamScopeLower) continue;
      }
      if (playerScopeLower) {
        /* Check player names and tags on both teams */
        const playerCols = C.t1p.concat(C.t2p);
        const tagCols = C.t1t.concat(C.t2t);
        let playerFound = false;
        const cleanScope = playerScopeLower.replace(/^#/, '');
        for (let pi = 0; pi < playerCols.length; pi++) {
          const pn = at(playerCols[pi]).toLowerCase();
          const pt = at(tagCols[pi]).toLowerCase().replace(/^#/, '');
          if (pn === playerScopeLower || pt === cleanScope) { playerFound = true; break; }
        }
        if (!playerFound) continue;
      }

      const team1Players = C.t1p.map(at);
      const team2Players = C.t2p.map(at);
      const team1Brawlers = C.t1b.map(at).filter(b => b);
      const team2Brawlers = C.t2b.map(at).filter(b => b);
      /* Brawler scope filter: row must contain ALL specified brawlers across both teams */
      if (brawlersScopeSet && brawlersScopeSet.size > 0) {
        const allBrSet = new Set(team1Brawlers.concat(team2Brawlers).map(b => _fnNormBr(b)));
        let allFound = true;
        for (const b of brawlersScopeSet) {
          if (!allBrSet.has(b)) { allFound = false; break; }
        }
        if (!allFound) continue;
      }
      const team1PlayerTags = C.t1t.map(at);
      const team2PlayerTags = C.t2t.map(at);
      /* Complete (uncapped) per-player aggregation for a single-brawler scope */
      if (singleBrawler && team1Brawlers.length === 3 && team2Brawlers.length === 3) {
        const _rb1 = C.t1b.map(at);
        const _rb2 = C.t2b.map(at);
        const _bpSides = [
          { pl: team1Players, br: _rb1, tg: team1PlayerTags, res: team1Result, tm: team1 },
          { pl: team2Players, br: _rb2, tg: team2PlayerTags, res: team2Result, tm: team2 }
        ];
        for (let _bpS = 0; _bpS < 2; _bpS++) {
          const _sd = _bpSides[_bpS];
          let _idx = -1;
          for (let _bi = 0; _bi < _sd.br.length; _bi++) { if (_fnNormBr(_sd.br[_bi]) === singleBrawler) { _idx = _bi; break; } }
          if (_idx < 0) continue;
          const _pn = safeStr(_sd.pl[_idx]).trim();
          if (!_pn) continue;
          const _pt = safeStr(_sd.tg[_idx]).trim();
          const _won = _sd.res === 'Win';
          if (!brawlerPlayerAgg[_pn]) brawlerPlayerAgg[_pn] = { name: _pn, tag: _pt, team: _sd.tm, picks: 0, wins: 0 };
          if (_pt && !brawlerPlayerAgg[_pn].tag) brawlerPlayerAgg[_pn].tag = _pt;
          if (_sd.tm && !brawlerPlayerAgg[_pn].team) brawlerPlayerAgg[_pn].team = _sd.tm;
          brawlerPlayerAgg[_pn].picks++;
          if (_won) brawlerPlayerAgg[_pn].wins++;
        }
      }

      // Sheet row order is preserved via this index — used for stable sort
      // when matchTag is non-numeric or duplicated
      const rowOrder = i;

      matches.push({
        matchTag, team1, team2,
        team1Result, team2Result,
        mode, map, date,
        team1Players, team2Players,
        team1Brawlers, team2Brawlers,
        team1PlayerTags, team2PlayerTags,
        isDecisive: at(C.dec).toLowerCase() === 'true',
        /* Bans, First Pick und Turnier-Angaben aus dem neuen Sheet.
           Fehlt eine Spalte, bleibt das Feld leer statt falsch. */
        team1Bans: C.t1b_ban.map(at).filter(function(b){ return b; }),
        team2Bans: C.t2b_ban.map(at).filter(function(b){ return b; }),
        /* Werte je Spieler, in derselben Reihenfolge wie die Brawler:
           Stelle 0 gehoert zu Brawler 0. Zahlen kommen als Zahl, Namen
           als Text — leere Felder werden null, nicht 0, damit sich
           "nichts gemessen" von "null Schaden" unterscheiden laesst. */
        players1: perSide('t1'),
        players2: perSide('t2'),
        firstPickBrawler: at(C.fpBrawler),
        team1FirstPick: at(C.t1fp),
        team2FirstPick: at(C.t2fp),
        region: at(C.region),
        regionGroup: at(C.regionGroup),
        setId: at(C.setId),
        duration: at(C.duration),
        tournamentId: at(C.tourId),
        tournamentTitle: at(C.tourTitle),
        matchType: at(C.matchType),
        /* Liga und Region sind seit der Sheet-Umstellung nicht mehr
           enthalten. Fehlen sie, bleibt das Feld leer statt falsch. */
        team1Tier: at(C.t1tier),
        team1Region: at(C.t1reg),
        team2Tier: at(C.t2tier),
        team2Region: at(C.t2reg),
        rowOrder: rowOrder
      });

      // Aggregate stats (only counts complete 3v3 matches)
      if (team1Brawlers.length === 3 && team2Brawlers.length === 3) {
        if (!stats[mode]) stats[mode] = {};
        if (!stats[mode][map]) stats[mode][map] = { _totalMatches: 0, _bans: {} };
        if (!stats[mode][map]._bans) stats[mode][map]._bans = {};
        stats[mode][map]._totalMatches++;

        /* Die Werte je Brawler mitzaehlen. Summe und Anzahl getrennt,
           damit spaeter ein ehrlicher Schnitt entsteht: ein Spieler
           ohne gemessenen Schaden darf den Durchschnitt nicht auf null
           ziehen. */
        const addStat = function(brawler, won, st){
          if (!brawler) return;
          var e = stats[mode][map][brawler];
          if (!e){ e = stats[mode][map][brawler] = { picks:0, wins:0 }; }
          e.picks++;
          if (won) e.wins++;
          if (!st) return;
          /* Auf der Leitung stehen Kurzschluessel; hier wieder die
             sprechenden Namen, damit die Auswertung lesbar bleibt. */
          [['kills','k'],['deaths','d'],['damage','dm'],['heal','h'],
           ['supers','s'],['objective','o'],['latency','l']].forEach(function(pair){
            var v = st[pair[1]];
            if (v === null || v === undefined || !isFinite(v)) return;
            var kk = pair[0];
            if (!e[kk]) e[kk] = { sum:0, n:0 };
            e[kk].sum += v; e[kk].n++;
          });
          /* Sternkraft und Gadget als Haeufigkeit — so laesst sich
             sehen, was auf dieser Map ueblich ist. */
          [['starpower','sp'],['gadget','g']].forEach(function(pair){
            var v = st[pair[1]];
            if (!v) return;
            if (!e['_'+pair[0]]) e['_'+pair[0]] = {};
            e['_'+pair[0]][v] = (e['_'+pair[0]][v] || 0) + 1;
          });
        };

        const team1Won = team1Result === 'Win';
        team1Brawlers.forEach(function(b, i){ addStat(b, team1Won, (perSide('t1')||[])[i]); });
        const team2Won = team2Result === 'Win';
        team2Brawlers.forEach(function(b, i){ addStat(b, team2Won, (perSide('t2')||[])[i]); });

        /* Bans zaehlen — bisher gab es dazu ueberhaupt keine Zahlen. */
        C.t1b_ban.map(at).concat(C.t2b_ban.map(at)).forEach(function(b){
          if (!b) return;
          stats[mode][map]._bans[b] = (stats[mode][map]._bans[b] || 0) + 1;
        });
      }

      parsedCount++;
    } catch (rowError) {
      errorCount++;
      if (errorCount <= 5) console.warn('Row ' + i + ' parse error:', rowError.message);
    }
  }

  for (const mode in stats) {
    for (const map in stats[mode]) {
      const totalMatches = stats[mode][map]._totalMatches || 1;
      /* Aus Summe und Anzahl den Schnitt machen und die Rohwerte
         wegwerfen — sonst waechst die Antwort unnoetig. */
      for (const bn in stats[mode][map]){
        if (bn.charAt(0) === '_') continue;
        const e = stats[mode][map][bn];
        ['kills','deaths','damage','heal','supers','objective','latency'].forEach(function(k){
          if (e[k] && e[k].n){
            e['avg' + k.charAt(0).toUpperCase() + k.slice(1)] =
              Math.round((e[k].sum / e[k].n) * 10) / 10;
          }
          delete e[k];
        });
        /* Nur die haeufigste Sternkraft bzw. das haeufigste Gadget. */
        ['starpower','gadget'].forEach(function(k){
          const m2 = e['_'+k];
          if (m2){
            let best = '', bn2 = 0;
            for (const key in m2) if (m2[key] > bn2){ bn2 = m2[key]; best = key; }
            if (best) e[k === 'starpower' ? 'topStarpower' : 'topGadget'] = best;
            delete e['_'+k];
          }
        });
        if (e.avgKills != null && e.avgDeaths != null)
          e.kd = e.avgDeaths > 0 ? Math.round((e.avgKills / e.avgDeaths) * 100) / 100 : e.avgKills;
      }
      /* Bans als Quote der Partien auf dieser Map. */
      const bansRaw = stats[mode][map]._bans || {};
      const bansOut = {};
      for (const b in bansRaw){
        bansOut[b] = { bans: bansRaw[b],
                       banRate: Math.round((bansRaw[b] / totalMatches) * 1000) / 10 };
      }
      stats[mode][map]._bans = bansOut;
      for (const brawler in stats[mode][map]) {
        /* Alles mit Unterstrich ist Beiwerk, kein Brawler — sonst
           bekommt auch die Ban-Auswertung eine Siegquote verpasst. */
        if (brawler.charAt(0) === '_') continue;
        const data = stats[mode][map][brawler];
        data.winRate = data.picks > 0 ? data.wins / data.picks : 0;
        data.pickRate = data.picks / totalMatches;
        data.sampleSize = data.picks;
      }
    }
  }

  // Sort by date desc; preserve row order as tiebreaker
  /* Parse D/M/Y or M/D/Y dates to YYYYMMDD numbers for sorting.
     Auto-detects format: any first-number > 12 forces D/M/Y. */
  let dateFormat = null;
  for (const m of matches) {
    const match = String(m.date || '').match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (match) {
      if (parseInt(match[1]) > 12) { dateFormat = 'DMY'; break; }
      if (parseInt(match[2]) > 12) { dateFormat = 'MDY'; break; }
    }
  }
  if (!dateFormat) dateFormat = 'DMY';

  function parseDate(d) {
    const str = String(d || '').trim();
    // ISO: YYYY-MM-DD or YYYY/MM/DD
    let iso = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (iso) return parseInt(iso[1]) * 10000 + parseInt(iso[2]) * 100 + parseInt(iso[3]);
    // D/M/Y or M/D/Y with / . or - separators
    const m = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
    if (!m) return 0;
    let y = parseInt(m[3]); if (y < 100) y += 2000;
    const mo = dateFormat === 'DMY' ? parseInt(m[2]) : parseInt(m[1]);
    const da = dateFormat === 'DMY' ? parseInt(m[1]) : parseInt(m[2]);
    return y * 10000 + mo * 100 + da;
  }

  matches.sort(function(a, b) {
    const ad = parseDate(a.date);
    const bd = parseDate(b.date);
    if (ad !== bd) return bd - ad;
    return b.rowOrder - a.rowOrder;
  });

  /* Bug fix: when filter=all, sorting by date alone means "Unknown" team matches
     can fill the 6000 cap before all known-team matches. Result: filter=teams
     returns MORE useful matches than filter=all. Fix: stable-sort known-team
     matches to the front so the date-order is preserved within each group,
     but all known-team matches come before any partial-unknown ones. */
  if (!teamsOnly && !teamScopeLower && !playerScopeLower) {
    matches.sort(function(a, b) {
      const aKnown = (isKnownTeam(a.team1) && isKnownTeam(a.team2)) ? 0 : 1;
      const bKnown = (isKnownTeam(b.team1) && isKnownTeam(b.team2)) ? 0 : 1;
      if (aKnown !== bKnown) return aKnown - bKnown;
      const ad = parseDate(a.date);
      const bd = parseDate(b.date);
      if (ad !== bd) return bd - ad;
      return b.rowOrder - a.rowOrder;
    });
  }

  /* Vor der Kappung aussieben, nicht danach: sonst fuellen Partien ohne
     Werte die 6000 Plaetze und die mit Werten fallen hinten runter. */
  /* Vorher stand hier ein splice mit Spread ueber die ganze Liste.
     Bei zehntausenden Partien sprengt das den Aufruf-Stapel — die
     Funktion warf einen RangeError und die Seite bekam gar nichts.
     Eine zweite Liste kostet nichts und kann nicht umkippen. */
  let kept = matches;
  RAW.statsKept = 0;
  if (statsOnly){
    const hasStats = function(m){
      var L = [m.players1, m.players2];
      for (var i = 0; i < L.length; i++){
        var a = L[i] || [];
        for (var j = 0; j < a.length; j++){
          var p = a[j];
          if (!p) continue;
          if (p.k != null || p.d != null || p.dm != null || p.h != null ||
              p.s != null || p.o != null || p.l != null) return true;
        }
      }
      return false;
    };
    kept = matches.filter(hasStats);
    RAW.statsKept = kept.length;
  } else {
    try{ RAW.statsKept = matches.filter(function(m){
      var L=[m.players1,m.players2];
      for (var i=0;i<L.length;i++){ var a=L[i]||[]; for (var j=0;j<a.length;j++){ if (a[j]) return true; } }
      return false;
    }).length; }catch(e){}
  }

  /* All queries (including team-scope) capped at 6000 to respect Netlify response limit */
  let limitedMatches = kept.slice(0, MAX_MATCHES_RETURNED);
  /* Fassung der Funktion. Ohne diese Angabe laesst sich nicht sagen,
     ob ein Deployment ueberhaupt angekommen ist — die Seite kann sonst
     nur raten, warum Felder fehlen. */
  const extra = { stats, totalParsed: parsedCount, raw: RAW, fnVersion: '19.43.0',
                  brawlerPlayers: brawlerPlayerAgg ? Object.keys(brawlerPlayerAgg).map(k => brawlerPlayerAgg[k]) : null };

  /* Harte Grenze: Netlify verwirft Antworten ueber 6 MB kommentarlos,
     die Seite zeigt dann "keine Daten".

     Statt die Partien zu kuerzen werden zuerst die Spielerwerte der
     AELTEREN Partien weggelassen. Das Quiz, die Meta-Auswertung und
     Scouting brauchen die vollen 6000 Partien; die Werte interessieren
     ohnehin fast nur bei den neuesten. So bleibt beides erhalten.
     Erst wenn das nicht reicht, wird an der Zahl gedreht. */
  const LIMIT = 5.2 * 1024 * 1024;
  const size = function(){ return JSON.stringify({ matches: limitedMatches, ...extra }).length; };
  let sz = size();
  if (sz > LIMIT && !statsOnly){
    /* Von hinten die Werte abwerfen, bis es passt. */
    let keepStats = limitedMatches.length;
    let guard = 0;
    while (sz > LIMIT && keepStats > 100 && guard++ < 24){
      keepStats = Math.floor(keepStats * 0.75);
      for (let i = keepStats; i < limitedMatches.length; i++){
        if (limitedMatches[i].players1 || limitedMatches[i].players2){
          limitedMatches[i] = Object.assign({}, limitedMatches[i]);
          delete limitedMatches[i].players1;
          delete limitedMatches[i].players2;
        }
      }
      sz = size();
    }
    extra.statsForNewest = keepStats;
  }
  /* Notbremse: passt es immer noch nicht, doch die Zahl senken. */
  let guard2 = 0;
  while (sz > LIMIT && limitedMatches.length > 200 && guard2++ < 12){
    const factor = Math.max(0.55, (LIMIT / sz) * 0.95);
    limitedMatches = limitedMatches.slice(0, Math.floor(limitedMatches.length * factor));
    sz = size();
  }
  let size2 = sz;
  return { matches: limitedMatches, truncated: limitedMatches.length < kept.length,
           returnedBytes: size2, ...extra };
}

function safeStr(val) {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += char;
  }
  result.push(current);
  return result;
}


function _fnRowDate(s, fmt){
  if(!s) return 0;
  s=String(s).trim();
  var iso=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(iso) return parseInt(iso[1],10)*10000+parseInt(iso[2],10)*100+parseInt(iso[3],10);
  var m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(m){ var y=parseInt(m[3],10); if(y<100)y+=2000; var a=parseInt(m[1],10),b=parseInt(m[2],10),mo,da; if(fmt==='M/D/Y'){mo=a;da=b;}else{da=a;mo=b;} return y*10000+mo*100+da; }
  return 0;
}
function _fnDetectFmt(dataLines, dateIx){
  var ix = (dateIx == null || dateIx < 0) ? 7 : dateIx;
  var firstHigh=0, secondHigh=0;
  for(var i=0;i<dataLines.length;i++){
    var line=(dataLines[i]||'').trim(); if(!line) continue;
    var cols=parseCSVLine(line); if(cols.length<=ix) continue;
    var d=safeStr(cols[ix]); if(!d) continue;
    var m=String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if(!m) continue;
    if(parseInt(m[1],10)>12) firstHigh++;
    if(parseInt(m[2],10)>12) secondHigh++;
  }
  if(firstHigh>0 && secondHigh===0) return 'D/M/Y';
  if(secondHigh>0 && firstHigh===0) return 'M/D/Y';
  return 'D/M/Y';
}
