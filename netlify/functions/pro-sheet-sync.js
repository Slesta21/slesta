/**
 * Netlify Function: pro-sheet-sync (Build 139, geplant alle 5 Minuten)
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

/* Auswertung und Sheet-Abruf kommen aus fetch-pro-sheet.js – so rechnen beide gleich */
const PS = require('./fetch-pro-sheet.js');
const zlib = require('zlib');

/* Stichtag der Seite (SD_CUTOFF in index.html) – danach fragt die Seite standardmäßig */
async function stichtag() {
  const basis = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://slesdraft.netlify.app';
  try {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 3000);
    const html = await fetch(basis + '/', { signal: ctrl.signal }).then(r => r.text()).finally(() => clearTimeout(t));
    const m = html.match(/SD_CUTOFF="(\d{4})-(\d{2})-(\d{2})"/);
    if (m) return parseInt(m[1] + m[2] + m[3], 10);
  } catch (e) {}
  return 20260916;
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
  const t0 = Date.now();
  if (!sheetUrl) status.fehler = 'GOOGLE_SHEET_URL fehlt';
  else if (!SB_KEY) status.fehler = 'SUPABASE_SERVICE_ROLE_KEY fehlt';
  else {
    const [text, seit] = await Promise.all([(async () => {
      for (const url of PS.csvUrls(sheetUrl)) {
        const rest = 15000 - (Date.now() - t0);
        if (rest < 2000) break;
        try { return await PS.holeEinmal(url, rest); } catch (e) { status.fehler = e.code || e.message; }
      }
      return null;
    })(), stichtag()]);
    if (text) {
      delete status.fehler;
      status.ok = true; status.kb = Math.round(text.length / 1024); status.msSheet = Date.now() - t0; status.seit = seit;
      try { await hochladen('latest.csv.gz', zlib.gzipSync(text, { level: 5 }), 'application/gzip'); } catch (e) { status.csvFehler = e.message; }
      /* Standard-Antworten vorrechnen: wichtigste zuerst, solange Zeit ist */
      status.vorgerechnet = [];
      for (const [filter, s] of [['all', seit], ['teams', seit], ['all', 0]]) {
        if (Date.now() - t0 > 20000) break;
        try {
          const data = PS.baueDaten(text, filter, null, null, null, null, null, s, false);
          data.quelle = { von: 'vorgerechnet' };
          await hochladen(PS.vorName(filter, s), zlib.gzipSync(JSON.stringify(data), { level: 6 }), 'application/gzip');
          status.vorgerechnet.push(filter + '-' + s);
        } catch (e) { status.vorFehler = e.message; }
      }
    }
  }
  status.ms = Date.now() - t0;
  try { await hochladen('status.json', JSON.stringify(status), 'application/json'); } catch (e) { status.statusFehler = e.message; }
  console.log('pro-sheet-sync', JSON.stringify(status));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(status) };
};
