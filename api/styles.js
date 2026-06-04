// GET /styles  — a one-off style comparison (the Dreams samples.html pattern).
// Renders the SAME scene (the gym story) in several style directions so we can
// pick what reads as "real" instead of Hallmark. Generates once, caches the
// images at fixed Blob paths; ?force=1 regenerates.

import { put, list } from '@vercel/blob';

export const config = { maxDuration: 120 };

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

const SCENE = `An elderly man, about eighty, sits alone on a worn wooden bench beside a tall window inside a gym, morning light coming through the glass. He holds a folded paper newspaper but isn't really reading it; a coffee mug sits on the bench beside him. Behind him, slightly out of focus, a few younger people lift weights. His expression is calm and a little far away — tender, but not posed. No text or letters anywhere in the image.`;

const STYLES = [
  { name: 'photo',     label: 'Documentary photo',     dir: 'Style: candid documentary photograph. Natural window light, 35mm, realistic skin and fabric texture, true-to-life muted color, shallow depth of field. Photojournalism — unposed, a real moment. NOT illustration, NOT painting, NOT a render.' },
  { name: 'hopper',    label: 'Quiet realist painting (Hopper)', dir: 'Style: realist oil painting in the spirit of Edward Hopper. Quiet American realism, hard clean morning light, restrained desaturated palette, flat planes, psychological stillness. Emotionally honest, NOT sentimental, NOT cute. NO glow.' },
  { name: 'editorial', label: 'Editorial ink & wash',   dir: 'Style: contemporary editorial illustration for a serious magazine. Confident ink linework with limited, muted watercolor wash, generous negative space, a little spare and graphic. Grown-up, NOT childlike, NOT sweet.' },
  { name: 'cinematic', label: 'Cinematic film still',    dir: 'Style: cinematic film still from a quiet independent drama. Naturalistic, slightly desaturated cool color grade, soft realistic light, subtle film grain, anamorphic feel. The look of a real frame, NOT an illustration.' },
];

async function gen(dir) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-1', prompt: `${SCENE}\n\n${dir}`, size: '1024x1024', quality: 'medium', n: 1 }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`);
  const data = await res.json();
  return Buffer.from(data.data[0].b64_json, 'base64');
}

export default async function handler(req, res) {
  if (!OPENAI_KEY || !BLOB_TOKEN) return res.status(503).send('not configured');
  const force = req.query.force === '1';

  // existing cached samples
  let existing = {};
  try {
    const { blobs } = await list({ prefix: 'style-sample/', token: BLOB_TOKEN });
    for (const b of blobs) existing[b.pathname.replace('style-sample/', '').replace('.png', '')] = b.url;
  } catch (_) {}

  const results = await Promise.all(STYLES.map(async (s) => {
    if (!force && existing[s.name]) return { ...s, url: existing[s.name] };
    try {
      const buf = await gen(s.dir);
      const blob = await put(`style-sample/${s.name}.png`, buf, { access: 'public', contentType: 'image/png', addRandomSuffix: false, token: BLOB_TOKEN });
      return { ...s, url: blob.url };
    } catch (e) { return { ...s, url: null, err: e.message }; }
  }));

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Style test — Story from Head</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Spectral:wght@400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
body{margin:0;background:#23211c;color:#efe9db;font-family:'Spectral',Georgia,serif;padding:40px 20px}
.wrap{max-width:960px;margin:0 auto}
h1{font-family:'Playfair Display',serif;font-weight:800;font-size:34px;text-align:center;margin:0 0 6px}
.sub{text-align:center;color:#b3ab9a;max-width:560px;margin:0 auto 36px;font-size:16px}
.grid{display:grid;grid-template-columns:1fr;gap:26px}
@media(min-width:680px){.grid{grid-template-columns:1fr 1fr}}
.card{background:#2c2a24;border:1px solid #3a3730;border-radius:14px;overflow:hidden}
.card img{width:100%;display:block;background:#1a1814;aspect-ratio:1/1;object-fit:cover}
.cap{padding:14px 16px}
.cap .lab{font-family:'Playfair Display',serif;font-weight:700;font-size:19px}
.cap .dir{font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9c9588;letter-spacing:.02em;margin-top:6px;line-height:1.5}
.miss{padding:40px;text-align:center;color:#c98b5a;font-family:'IBM Plex Mono',monospace;font-size:12px}
.foot{text-align:center;color:#7d766a;font-family:'IBM Plex Mono',monospace;font-size:11px;margin-top:34px;letter-spacing:.1em}
</style></head><body><div class="wrap">
<h1>Same story, four ways</h1>
<div class="sub">The gym story — “A Seat by the Window” — rendered in four directions. Which one feels real instead of like a greeting card?</div>
<div class="grid">
${results.map((r) => `<div class="card">${r.url ? `<img src="${r.url}" alt="${r.label}">` : `<div class="miss">couldn't generate — ${r.err || 'error'}</div>`}<div class="cap"><div class="lab">${r.label}</div><div class="dir">${r.dir.replace('Style: ', '')}</div></div></div>`).join('\n')}
</div>
<div class="foot">temporary tool · /styles · current live style = “warm storybook glow”</div>
</div></body></html>`);
}
