// Natürliche Vorlesestimme für den Slesdrafts-Assistenten.
// Nutzt – je nachdem welcher Schlüssel in Netlify gesetzt ist –
//   ELEVENLABS_API_KEY  (klingt am menschlichsten, Stimme per ELEVENLABS_VOICE_ID)
//   OPENAI_API_KEY      (gpt-4o-mini-tts, weibliche Stimme „nova“/„shimmer“)
// Ohne Schlüssel antwortet die Funktion mit 501 und die Seite nutzt die Browser-Stimme.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  const lang = body.lang === 'en' ? 'en' : 'de';
  if (!text) return { statusCode: 400, body: 'Kein Text' };
  const eleven = process.env.ELEVENLABS_API_KEY, openai = process.env.OPENAI_API_KEY;
  const ok = (buf) => ({ statusCode: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' }, body: Buffer.from(buf).toString('base64'), isBase64Encoded: true });
  try {
    if (eleven) {
      const voice = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // „Sarah“ – warm, weiblich
      const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voice, {
        method: 'POST',
        headers: { 'xi-api-key': eleven, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } })
      });
      if (r.ok) return ok(await r.arrayBuffer());
    }
    if (openai) {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + openai, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: process.env.OPENAI_VOICE || 'nova', input: text, format: 'mp3',
          instructions: lang === 'de' ? 'Sprich natürliches, freundliches Deutsch wie eine entspannte Gaming-Coachin. Englische Brawler- und Map-Namen englisch aussprechen.' : 'Speak like a friendly, relaxed esports coach. Natural and warm.' })
      });
      if (r.ok) return ok(await r.arrayBuffer());
    }
    return { statusCode: 501, body: 'no-tts-key' };
  } catch (e) { return { statusCode: 502, body: 'tts-error' }; }
};
