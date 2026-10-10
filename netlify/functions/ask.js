// ProductScout secure AI proxy for Netlify.
// Your API keys live ONLY in Netlify's environment variables, never in the web page.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY   (add the ones you have)
//   ACCESS_CODE               optional: visitors must type this code to use the tool
//   RATE_LIMIT_PER_10MIN      optional: max AI calls per visitor per 10 minutes (default 60)
//   ANTHROPIC_MODEL, OPENAI_MODEL, GEMINI_MODEL, DEEPSEEK_MODEL   optional model overrides

const MODELS = () => ({
  claude: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  gemini: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  deepseek: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
});
const KEYS = () => ({
  claude: process.env.ANTHROPIC_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY
});

// Simple best-effort limiter (resets when the function instance restarts).
const hits = new Map();
function limited(ip) {
  const max = parseInt(process.env.RATE_LIMIT_PER_10MIN || '60', 10);
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 600000);
  if (arr.length >= max) { hits.set(ip, arr); return true; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

async function post(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 24000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const em = j && j.error;
      throw new Error(String((em && (em.message || em)) || 'HTTP ' + r.status));
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function callEngine(engine, key, prompt, img64) {
  const model = MODELS()[engine];
  if (engine === 'claude') {
    const content = [];
    if (img64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img64 } });
    content.push({ type: 'text', text: prompt });
    const j = await post('https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 3000, messages: [{ role: 'user', content }] });
    return (j.content || []).map((p) => p.text || '').join('');
  }
  if (engine === 'openai' || engine === 'deepseek') {
    const url = engine === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.deepseek.com/chat/completions';
    const content = img64 && engine === 'openai'
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img64 } }]
      : prompt;
    const j = await post(url, { Authorization: 'Bearer ' + key },
      { model, messages: [{ role: 'user', content }], response_format: { type: 'json_object' } });
    return j.choices[0].message.content;
  }
  if (engine === 'gemini') {
    const parts = [{ text: prompt }];
    if (img64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: img64 } });
    const j = await post('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      { 'x-goog-api-key': key },
      { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json' } });
    return j.candidates[0].content.parts.map((p) => p.text || '').join('');
  }
  throw new Error('Unknown engine');
}

function clean(msg, key) {
  let m = String(msg || 'AI request failed');
  if (key) m = m.split(key).join('***');
  return m.replace(/(sk-|AIza|AQ\.)[A-Za-z0-9_\-.]+/g, '***').slice(0, 200);
}

exports.handler = async (event) => {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj)
  });
  const keys = KEYS();
  const engines = Object.keys(keys).filter((k) => keys[k]);

  if (event.httpMethod === 'GET') return json(200, { engines, needsCode: !!process.env.ACCESS_CODE });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }

  if (process.env.ACCESS_CODE && b.code !== process.env.ACCESS_CODE) return json(401, { error: 'Access code required or wrong' });

  const h = event.headers || {};
  const ip = h['x-nf-client-connection-ip'] || h['client-ip'] || h['x-forwarded-for'] || 'unknown';
  if (limited(ip)) return json(429, { error: 'Too many requests. Please wait a few minutes and try again.' });

  const engine = b.engine, prompt = b.prompt, img64 = b.img64 || null;
  if (!engines.includes(engine)) return json(400, { error: 'That AI is not connected on this site' });
  if (typeof prompt !== 'string' || !prompt || prompt.length > 40000) return json(400, { error: 'Invalid request' });
  if (img64 && (typeof img64 !== 'string' || img64.length > 2000000)) return json(400, { error: 'Image is too large' });

  try {
    const text = await callEngine(engine, keys[engine], prompt, img64);
    return json(200, { text });
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'The AI took too long. Please try again.' : clean(e && e.message, keys[engine]);
    return json(502, { error: msg });
  }
};
