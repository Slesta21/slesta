/**
 * Netlify Function: pro-sheet-sync (Build 138, geplant alle 5 Minuten)
 * Holt das Pro-Sheet mit viel Zeit (geplante Funktionen dürfen 30 s laufen)
 * und legt die CSV in Supabase Storage ab. fetch-pro-sheet liest dann von
 * dort – so hängt die Seite nicht mehr daran, ob Google gerade in unter
 * 10 Sekunden antwortet.
 * Benötigt: GOOGLE_SHEET_URL, SUPABASE_SERVICE_ROLE_KEY (Bucket wird selbst angelegt).
 */
const SB_URL = (process.env.SUPABASE_URL || 'https://ddtnhnwdszeddegctlag.supabase.co').replace(/\/$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = 'pro-sheet';

function sbKopf(extra) {
  return Object.assign({ apikey: SB_KEY }, /^eyJ/.test(SB_KEY) ? { Authorization: 'Bearer ' + SB_KEY } : {}, extra || {});
}

/* gleich wie in fetch-pro-sheet.js */
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
    if (kopf.startsWith('<!doctype') || kopf.startsWith('<html') || kopf.indexOf('<head') >= 0) throw sheetFehler('sheet-not-public');
    if (text.length < 20) throw sheetFehler('sheet-empty');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw sheetFehler('sheet-timeout');
    throw e.code ? e : sheetFehler('sheet-network', e.message);
  } finally { clearTimeout(timer); }
}

async function hochladen(name, body, typ) {
  const put = () => fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + name, {
    method: 'POST', headers: sbKopf({ 'Content-Type': typ, 'x-upsert': 'true', 'Cache-Control': 'no-cache' }), body
  });
  let r = await put();
  if (r.status === 400 || r.status === 404) {
    /* Bucket fehlt noch → anlegen (privat) und nochmal */
    const txt = await r.text().catch(() => '');
    if (/bucket/i.test(txt) || r.status === 404) {
      await fetch(SB_URL + '/storage/v1/bucket', {
        method: 'POST', headers: sbKopf({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false })
      }).catch(() => 0);
      r = await put();
    }
  }
  if (!r.ok) throw new Error('storage-' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
}

exports.handler = async function () {
  const sheetUrl = process.env.GOOGLE_SHEET_URL;
  const status = { t: new Date().toISOString(), ok: false };
  if (!sheetUrl) status.fehler = 'GOOGLE_SHEET_URL fehlt';
  else if (!SB_KEY) status.fehler = 'SUPABASE_SERVICE_ROLE_KEY fehlt';
  else {
    const t0 = Date.now();
    for (const url of csvUrls(sheetUrl)) {
      const rest = 24000 - (Date.now() - t0);
      if (rest < 2000) break;
      try {
        const text = await holeEinmal(url, rest);
        await hochladen('latest.csv', text, 'text/csv; charset=utf-8');
        Object.assign(status, { ok: true, kb: Math.round(text.length / 1024), ms: Date.now() - t0 });
        delete status.fehler;
        break;
      } catch (e) { status.fehler = e.code || e.message; }
    }
    status.ms = status.ms || Date.now() - t0;
  }
  try { await hochladen('status.json', JSON.stringify(status), 'application/json'); } catch (e) { status.statusFehler = e.message; }
  console.log('pro-sheet-sync', JSON.stringify(status));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(status) };
};
