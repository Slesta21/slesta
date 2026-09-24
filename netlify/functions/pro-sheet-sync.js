/**
 * Netlify Function: pro-sheet-sync (Build 142, geplant alle 5 Minuten)
 * Holt das Pro-Sheet mit viel Zeit (geplante Funktionen dürfen 30 s laufen)
 * und legt die CSV in Supabase Storage ab. fetch-pro-sheet liest dann von
 * dort – so hängt die Seite nicht mehr daran, ob Google gerade in unter
 * 10 Sekunden antwortet.
 * Benötigt: GOOGLE_SHEET_URL, SUPABASE_SERVICE_ROLE_KEY (Bucket wird selbst angelegt).
 */
const SB_URL = (process.env.SUPABASE_URL || 'https://ddtnhnwdszeddegctlag.supabase.co').replace(/\/$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
const BUCKET = 'pro-sheet';
/* öffentlicher Bucket nur für die fertigen Antworten – die Seite lädt sie direkt, falls die Netlify-Funktion hakt */
const BUCKET_OEFF = 'pro-public';

function sbKopf(extra) {
  return Object.assign({ apikey: SB_KEY }, /^eyJ/.test(SB_KEY) ? { Authorization: 'Bearer ' + SB_KEY } : {}, extra || {});
}

/* Auswertung und Sheet-Abruf kommen aus fetch-pro-sheet.js – so rechnen beide gleich */
const PS = require('./fetch-pro-sheet.js');
const zlib = require('zlib');
const crypto = require('crypto');

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

async function hochladen(name, body, typ, oeff) {
  const bucket = oeff ? BUCKET_OEFF : BUCKET;
  const put = () => fetch(SB_URL + '/storage/v1/object/' + bucket + '/' + name, {
    method: 'POST', headers: sbKopf({ 'Content-Type': typ, 'x-upsert': 'true', 'Cache-Control': 'no-cache' }), body
  });
  let r = await put();
  if (r.status === 400 || r.status === 404) {
    /* Bucket fehlt noch → anlegen (privat) und nochmal */
    const txt = await r.text().catch(() => '');
    if (/bucket/i.test(txt) || r.status === 404) {
      await fetch(SB_URL + '/storage/v1/bucket', {
        method: 'POST', headers: sbKopf({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: bucket, name: bucket, public: !!oeff })
      }).catch(() => 0);
      r = await put();
    }
  }
  if (!r.ok) throw new Error('storage-' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 160));
}

exports.handler = async function () {
  const sheetUrl = process.env.GOOGLE_SHEET_URL;
  const t0 = Date.now();
  const status = { t: new Date().toISOString(), build: 148, ok: false, schritt: 'start' };
  /* letzter Stand – unverändertes Sheet wird nicht neu ausgewertet (spart Netlify-Rechenzeit) */
  let vorher = null;
  try { const r = await fetch(SB_URL + '/storage/v1/object/public/' + BUCKET_OEFF + '/status.json?t=' + Date.now()); if (r.ok) vorher = JSON.parse(await r.text()); } catch (e) {}
  /* Zwischenstand öffentlich ablegen – die Seite zeigt ihn im Fehler-Banner an.
     Bricht der Job mittendrin ab (Zeitlimit), sieht man so, wo. */
  const melde = async (schritt) => {
    status.schritt = schritt; status.ms = Date.now() - t0;
    try { await hochladen('status.json', JSON.stringify(status), 'application/json', true); } catch (e) { status.statusFehler = e.message; }
  };
  if (!sheetUrl) status.fehler = 'GOOGLE_SHEET_URL fehlt';
  else if (!SB_KEY) status.fehler = 'SUPABASE_SERVICE_ROLE_KEY fehlt';
  else {
    await melde('sheet-laden');
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
      status.hash = crypto.createHash('sha1').update(text).digest('hex');
      const alterVoll = vorher && vorher.tVoll ? Date.now() - Date.parse(vorher.tVoll) : Infinity;
      if (vorher && vorher.ok && vorher.hash === status.hash && vorher.seit === seit && alterVoll < 11 * 36e5) {
        Object.assign(status, { ok: true, kb: Math.round(text.length / 1024), seit, tVoll: vorher.tVoll, vorgerechnet: vorher.vorgerechnet, unveraendert: true });
        await melde('unveraendert');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status) };
      }
      status.tVoll = new Date().toISOString();
      status.kb = Math.round(text.length / 1024); status.msSheet = Date.now() - t0; status.seit = seit;
      await melde('auswerten');
      /* Standard-Antworten vorrechnen: wichtigste zuerst, solange Zeit ist */
      status.vorgerechnet = [];
      for (const [filter, s] of [['all', seit], ['teams', seit], ['all', 0]]) {
        if (status.vorgerechnet.length && Date.now() - t0 > 18000) break;
        try {
          const data = PS.baueDaten(text, filter, null, null, null, null, null, s, false);
          data.quelle = { von: 'vorgerechnet' };
          await hochladen(PS.vorName(filter, s), zlib.gzipSync(JSON.stringify(data), { level: 6 }), 'application/gzip', true);
          status.vorgerechnet.push(filter + '-' + s);
          status.ok = true;
          await melde('vorgerechnet-' + filter + '-' + s);
        } catch (e) { status.vorFehler = e.message; }
      }
      if (Date.now() - t0 < 24000) {
        try { await hochladen('latest.csv.gz', zlib.gzipSync(text, { level: 5 }), 'application/gzip'); } catch (e) { status.csvFehler = e.message; }
      }
    }
  }
  await melde(status.ok ? 'fertig' : 'fehler');
  console.log('pro-sheet-sync', JSON.stringify(status));
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(status) };
};
