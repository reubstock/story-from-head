// GET /s/:id  (rewritten to /api/s/:id)
// Server-renders a single story page: real OG tags for link previews,
// the illustration, the shaped story, voice playback, real share links,
// and a "tell another" cue that grows the corpus.
//
// Stories are stored as public JSON blobs at story/<id>.json. We locate the
// blob by prefix (works with just the Blob token — no database).

import { list } from '@vercel/blob';

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

async function getStory(id) {
  try {
    const { blobs } = await list({ prefix: `story/${id}.json`, limit: 1, token: BLOB_TOKEN });
    const hit = blobs.find((b) => b.pathname === `story/${id}.json`) || blobs[0];
    if (!hit) return null;
    const r = await fetch(hit.url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error('getStory failed', e.message);
    return null;
  }
}

function esc(s) {
  return (s || '').toString().replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return esc(s).replace(/\n/g, ' '); }

function notFound(res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Story not found</title><style>body{font-family:Georgia,serif;background:#121417;color:#e9e7e2;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}a{color:#e07a4e}</style></head><body><div><h1>This story has wandered off.</h1><p>We couldn't find it. <a href="/">Tell one of your own →</a></p></div></body></html>`);
}

export default async function handler(req, res) {
  const id = (req.query.id || '').toString().slice(0, 64).replace(/[^a-z0-9]/gi, '');
  if (!id || !BLOB_TOKEN) return notFound(res);

  const s = await getStory(id);
  if (!s) return notFound(res);

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'story-from-head.vercel.app';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const url = `${proto}://${host}/s/${id}`;

  const title = esc(s.title || 'A Story from Head');
  const blurb = esc(s.blurb || 'A little true story, told out loud.');
  const paras = (s.story || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const storyHtml = paras.map((p) => `<p>${esc(p)}</p>`).join('\n');
  const whoLine = s.who ? `<div class="who">${esc(s.who.startsWith('for') ? s.who : 'For ' + s.who)}</div>` : '';
  const img = s.image_url ? `<img class="hero" src="${escAttr(s.image_url)}" alt="${title}" />` : '';
  const audio = s.audio_url
    ? `<div class="voice"><div class="vlab">Hear it in their voice</div><audio controls preload="none" src="${escAttr(s.audio_url)}"></audio></div>`
    : '';

  const a = s.analysis;
  const analysisHtml = a && (a.kind || a.turn || (a.motifs && a.motifs.length))
    ? `<div class="analysis">
        <div class="ahead">What you told <span>· telling earns you insight</span></div>
        ${a.kind ? `<div class="arow"><div class="alab">Kind</div><div class="aval">${esc(a.kind)}</div></div>` : ''}
        ${a.motifs && a.motifs.length ? `<div class="arow"><div class="alab">Motifs</div><div class="aval"><div class="tags">${a.motifs.map((m) => `<span>${esc(m)}</span>`).join('')}</div></div></div>` : ''}
        ${a.turn ? `<div class="arow"><div class="alab">The turn</div><div class="aval">${esc(a.turn)}</div></div>` : ''}
        ${a.echo ? `<div class="arow"><div class="alab">Echoes</div><div class="aval">${esc(a.echo)}</div></div>` : ''}
        ${a.insight ? `<div class="ainsight">${esc(a.insight)}</div>` : ''}
      </div>`
    : '';

  const shareText = encodeURIComponent(`“${s.title}” — a Story from Head. ${s.blurb || ''}`.trim());
  const smsHref = `sms:&body=${shareText}%20${encodeURIComponent(url)}`;
  const mailHref = `mailto:?subject=${encodeURIComponent(s.title + ' — a Story from Head')}&body=${shareText}%0D%0A%0D%0A${encodeURIComponent(url)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${title} — Story from Head</title>
<meta name="description" content="${blurb}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${blurb}" />
<meta property="og:url" content="${escAttr(url)}" />
${s.image_url ? `<meta property="og:image" content="${escAttr(s.image_url)}" />` : ''}
<meta name="twitter:card" content="${s.image_url ? 'summary_large_image' : 'summary'}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;1,500&family=Spectral:ital,wght@0,400;0,500;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  :root{--bg:#121417;--paper:#1a1d21;--ink:#e9e7e2;--muted:#9aa1a8;--faint:#6b7177;--line:rgba(255,255,255,.10);--line-strong:rgba(255,255,255,.20);--rust:#e07a4e;--leaf:#7fa87a;--shadow:0 1px 0 rgba(0,0,0,.3),0 26px 50px -30px rgba(0,0,0,.8);--serif:'Spectral',Georgia,serif;--display:'Playfair Display',Georgia,serif;--mono:'IBM Plex Mono',ui-monospace,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--serif);font-size:19px;line-height:1.66;-webkit-font-smoothing:antialiased}
  ::selection{background:var(--rust);color:#fff5ec}
  a{color:inherit}
  .bar{border-bottom:1px solid var(--line)}
  .bar-in{display:flex;align-items:center;padding:14px 24px;max-width:720px;margin:0 auto}
  .mark{font-family:var(--display);font-weight:800;font-size:17px;display:flex;align-items:center;gap:9px;text-decoration:none}
  .mark .dot{width:9px;height:9px;border-radius:50%;background:var(--rust)}
  .wrap{max-width:720px;margin:0 auto;padding:0 24px}
  article{padding:34px 0 10px}
  .kicker{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--rust);text-align:center}
  h1{font-family:var(--display);font-weight:800;font-size:clamp(32px,6vw,52px);line-height:1.04;letter-spacing:-.015em;text-align:center;margin:.4em 0 .3em}
  .who{text-align:center;font-family:var(--mono);font-size:12px;letter-spacing:.06em;color:var(--muted);margin-bottom:26px}
  img.hero{width:100%;border-radius:14px;border:1px solid var(--line);box-shadow:var(--shadow);margin:6px 0 30px;background:#1f2329}
  .body p{margin:0 0 1.15em}
  .analysis{margin:36px 0 8px;padding:24px;background:var(--paper);border:1px solid var(--line);border-radius:14px}
  .analysis .ahead{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--rust);margin-bottom:16px}
  .analysis .ahead span{color:var(--faint)}
  .arow{display:grid;grid-template-columns:1fr;gap:3px;padding:12px 0;border-top:1px solid var(--line)}
  @media(min-width:560px){.arow{grid-template-columns:118px 1fr;gap:16px}}
  .arow:first-of-type{border-top:0}
  .alab{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding-top:3px}
  .aval{font-size:16.5px;color:var(--ink);line-height:1.5}
  .tags{display:flex;flex-wrap:wrap;gap:7px}
  .tags span{font-family:var(--mono);font-size:12px;border:1px solid var(--line-strong);border-radius:6px;padding:5px 9px;color:var(--ink)}
  .ainsight{margin-top:18px;padding-top:16px;border-top:1px dashed var(--line-strong);font-family:var(--display);font-style:italic;font-size:19px;line-height:1.45;color:var(--ink)}
  .voice{margin:30px 0 8px;padding:18px;background:var(--paper);border:1px solid var(--line);border-radius:13px;text-align:center}
  .voice .vlab{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
  .voice audio{width:100%;max-width:420px}
  .rule{height:1px;background:var(--line);border:0;margin:34px 0}
  .share{text-align:center}
  .share .lab{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:14px}
  .sharebtns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .sharebtns a,.sharebtns button{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--line-strong);border-radius:999px;padding:11px 18px;text-decoration:none;background:transparent;color:var(--ink);cursor:pointer;transition:.16s}
  .sharebtns a:hover,.sharebtns button:hover{background:var(--ink);color:var(--paper);border-color:var(--ink)}
  .next{text-align:center;margin:40px 0 12px}
  .next a{display:inline-block;font-family:var(--mono);font-size:13px;letter-spacing:.12em;text-transform:uppercase;background:var(--rust);color:#fff5ec;text-decoration:none;padding:15px 28px;border-radius:999px;transition:.16s}
  .next a:hover{background:#9a3514}
  .next .sub{font-style:italic;color:var(--muted);font-size:15px;margin-top:14px}
  footer{padding:30px 0 50px;text-align:center}
  footer .sig{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
</style>
</head>
<body>
<header class="bar"><div class="bar-in"><a class="mark" href="/"><span class="dot"></span>Story from Head</a></div></header>
<main class="wrap">
  <article>
    <div class="kicker">A story from head</div>
    <h1>${title}</h1>
    ${whoLine}
    ${img}
    <div class="body">${storyHtml}</div>
    ${audio}
    ${analysisHtml}
    <hr class="rule" />
    <div class="share">
      <div class="lab">Send it to someone</div>
      <div class="sharebtns">
        <a href="${escAttr(smsHref)}">Text it</a>
        <a href="${escAttr(mailHref)}">Email it</a>
        <button type="button" onclick="copyLink(this)">Copy link</button>
      </div>
    </div>
    <div class="next">
      <a href="/">Tell another →</a>
      <div class="sub">One story cues the next. Build a few and they’ll start to find each other.</div>
    </div>
  </article>
</main>
<footer><div class="sig">Story from Head</div></footer>
<script>
  function copyLink(btn){
    var u=${JSON.stringify(url)};
    function done(){var o=btn.textContent;btn.textContent='Copied ✓';setTimeout(function(){btn.textContent=o;},1600);}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(u).then(done,done);}else{done();}
  }
</script>
</body>
</html>`);
}
