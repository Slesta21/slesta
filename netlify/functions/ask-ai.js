exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { statusCode: 200, body: JSON.stringify({ error: 'API-Key fehlt. Setze ANTHROPIC_API_KEY in Netlify.' }) };
  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Bad JSON' }; }
  let messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  messages = messages.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length < 4000);
  if (!messages.length) return { statusCode: 200, body: JSON.stringify({ error: 'Keine Nachricht.' }) };
  const system = "Du bist der Assistent von Slesdrafts, einem Tool fuer Brawl Stars Draft-Vorbereitung und kompetitive Analyse (Team FA_Slizz). Antworte hilfreich, schlau und kompakt. Du kennst Brawl Stars gut: Brawler, Modi (Brawl Ball, Gem Grab, Heist, Hotzone, Bounty, Knockout), Maps, Draften (Picks/Bans/First-Pick), Counter und Synergien. Wenn jemand nach dem Tool fragt: es kann Drafts simulieren, Pro-Stats auswerten, Gegner scouten und Team-Drafts gemeinsam vorbereiten. Antworte in der Sprache des Nutzers (Deutsch oder Englisch).";
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system, messages })
    });
    const data = await r.json();
    if (data.error) return { statusCode: 200, body: JSON.stringify({ error: (data.error.message || 'API-Fehler') }) };
    const text = (data.content || []).map(b => b.text || '').join('').trim();
    return { statusCode: 200, body: JSON.stringify({ text: text || '...' }) };
  } catch (e) { return { statusCode: 200, body: JSON.stringify({ error: 'Verbindungsfehler zur API.' }) }; }
};
