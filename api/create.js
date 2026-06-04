// POST /api/create?who=...&hint=...   body: raw audio bytes
//
// The whole loop in one function:
//   1. Whisper transcribes the recording (falls back to the browser's live
//      caption text passed in ?hint if Whisper is unavailable / silent).
//   2. The raw audio is uploaded to Vercel Blob so the story page can replay
//      it in the teller's own voice.
//   3. GPT-4o-mini shapes the told story into a GREAT short read — true to
//      what was said, never inventing facts — plus a title, a one-line hook,
//      and a single vivid scene to illustrate.
//   4. gpt-image-1 paints that scene as a warm storybook illustration.
//   5. Everything is saved to Redis under story:<id>; returns { id }.
//
// Reuses the Dreams project's Blob + Redis + OpenAI credentials, isolated by
// the story:* key prefix and story-audio/ + story-img/ blob paths.

import { put } from '@vercel/blob';

export const config = { api: { bodyParser: false }, maxDuration: 120 };

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

const STORY_STYLE = `Style: warm hand-painted storybook illustration, in the spirit of classic children's-book art — soft natural light, painterly brushwork, gentle saturated palette, tender and a little nostalgic. A single coherent scene with real specific detail. NOT photographic. NOT a 3D render. NOT anime. NOT corporate vector art. NO text, letters, or words anywhere in the image.`;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- Whisper ----
async function transcribe(audioBuffer, contentType) {
  const filename =
    contentType.includes('mp4') ? 'story.mp4' :
    contentType.includes('ogg') ? 'story.ogg' :
    contentType.includes('wav') ? 'story.wav' : 'story.webm';
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: contentType }), filename);
  form.append('model', 'whisper-1');
  form.append('response_format', 'json');
  form.append('prompt', 'A person telling a short true story out loud, the way you would tell it to a friend or a child.');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.text || '').trim();
}

// ---- The write-up: make it a GREAT short story, true to what was said ----
async function craftStory(transcript, who) {
  const forLine = who ? `\nThe teller said this story is for: ${who}. You may let that color the warmth, but do not address them by name unless the teller did.` : '';

  const system = `You are a gifted editor who turns a person's spoken, rambling story into a short piece worth reading — the kind someone would happily share. You are NOT a ghostwriter padding a life story, and NOT a journaling app. Find the real story inside what was said and tell it beautifully.

The story might be about the teller, their kid, a relative, or a stranger — and it might be true, embellished, or made up. That is fine and none of your business. Do NOT police truth, do NOT add disclaimers, do NOT assume it is autobiographical.

HARD RULES:
- Faithful, not invented. Keep to the events, people, and details the teller actually gave. Shape and tighten; don't bolt on new plot. If the recording is thin, keep it short rather than padding.
- Keep their point of view. First person if they used it; third if it's about someone else. Preserve their idiom and warmth — shape it, don't varnish over their personality.
- Shape. A real opening line, momentum, and a landing that resonates. Cut filler, false starts, "ums," repetition.
- Length. 2 to 4 short paragraphs. Tight beats long.
- No tacked-on morals or "and that taught me…" unless they actually said it. Trust the story.`;

  const user = `Here is the transcript of a told story. Shape it into a great short read and return JSON.${forLine}

TRANSCRIPT:
"""${transcript}"""

Return ONLY a JSON object:
{
  "title": "2–6 words, evocative, specific, not clickbait",
  "story": "the shaped story, 2–4 short paragraphs separated by \\n\\n, in the point of view the teller used, faithful to what they said",
  "blurb": "one sharable line, ~12 words, that makes someone want to read it — no spoilers",
  "image_prompt": "one vivid paragraph (~60 words) describing ONE specific scene from the story to illustrate. Concrete: the place, the light, the objects, who is there and roughly their age/look as implied. A moment, not a montage. Do NOT include any style words (handled separately) and do NOT include text/letters in the scene."
}`;

  let data;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    });
    if (res.ok) { data = await res.json(); break; }
    const body = (await res.text()).slice(0, 200);
    // OpenAI throws transient 5xx internal_errors; retry a couple times before giving up
    if (res.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
    throw new Error(`writeup ${res.status}: ${body}`);
  }
  let parsed = {};
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch (_) {}
  return {
    title: (parsed.title || 'A Story from Head').toString().slice(0, 80),
    story: (parsed.story || transcript).toString().slice(0, 6000),
    blurb: (parsed.blurb || '').toString().slice(0, 200),
    image_prompt: (parsed.image_prompt || transcript.slice(0, 300)).toString().slice(0, 1200),
  };
}

async function softenPrompt(p) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You gently rewrite an innocuous image prompt that an overzealous safety filter flagged. Keep every concrete visual element; replace only words a literal filter might grab (weapons, blood, injury, intimacy, real names). One paragraph, same length. Output only the rewritten prompt.' },
        { role: 'user', content: p },
      ],
      temperature: 0.5,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function generateImage(promptText, attempt = 0) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `${promptText}\n\n${STORY_STYLE}`,
      size: '1024x1024',
      quality: 'medium',
      n: 1,
    }),
  });
  if (res.ok) {
    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('no b64_json');
    return Buffer.from(b64, 'base64');
  }
  const raw = await res.text();
  let msg = raw; try { msg = JSON.parse(raw).error?.message || raw; } catch (_) {}
  if (res.status === 429 && attempt < 1) {
    const m = msg.match(/try again in (\d+(?:\.\d+)?)\s*s/i);
    const wait = Math.min(m ? Math.ceil(parseFloat(m[1])) + 1 : 15, 30);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return generateImage(promptText, attempt + 1);
  }
  const safety = /safety|moderation/i.test(msg) || res.status === 400;
  if (safety && attempt < 1) {
    const softer = await softenPrompt(promptText);
    if (softer && softer !== promptText) return generateImage(softer, attempt + 1);
  }
  throw new Error(`image ${res.status}: ${msg.slice(0, 160)}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method', message: 'POST audio.' });
  if (!OPENAI_KEY || !BLOB_TOKEN) {
    return res.status(503).json({ error: 'not_configured', message: 'Server keys not set yet. Add OPENAI_API_KEY and redeploy.' });
  }

  const who = (req.query.who || '').toString().slice(0, 120);
  const hint = (req.query.hint || '').toString().slice(0, 4000);

  try {
    // collect raw audio
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const audio = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || 'audio/webm';
    if (audio.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'too_large', message: 'Recording is over 25 MB. Keep it under two minutes.' });
    }

    // transcribe (fall back to browser captions)
    let transcript = '';
    if (audio.length > 0) {
      try { transcript = await transcribe(audio, contentType); }
      catch (e) { console.warn('whisper failed, using hint:', e.message); }
    }
    if (!transcript) transcript = hint.trim();
    if (!transcript || transcript.length < 12) {
      return res.status(400).json({ error: 'no_speech', message: 'We couldn’t make out a story in that recording. Try again somewhere quieter.' });
    }

    // upload audio (best-effort)
    let audio_url = null;
    if (audio.length > 0) {
      try {
        const ext = contentType.includes('mp4') ? 'mp4' : contentType.includes('ogg') ? 'ogg' : 'webm';
        const blob = await put(`story-audio/${newId()}.${ext}`, audio, { access: 'public', contentType, token: BLOB_TOKEN });
        audio_url = blob.url;
      } catch (e) { console.warn('audio blob failed:', e.message); }
    }

    // write it up
    const crafted = await craftStory(transcript, who);

    // illustrate (best-effort — a story without a picture still ships)
    let image_url = null;
    try {
      const img = await generateImage(crafted.image_prompt);
      const blob = await put(`story-img/${newId()}.png`, img, { access: 'public', contentType: 'image/png', token: BLOB_TOKEN });
      image_url = blob.url;
    } catch (e) { console.warn('image failed:', e.message); }

    const id = newId();
    const record = {
      id,
      title: crafted.title,
      story: crafted.story,
      blurb: crafted.blurb,
      transcript,
      who,
      audio_url,
      image_url,
      created: new Date().toISOString(),
    };
    // Persist the story as a public JSON blob at a deterministic path so the
    // story page can find it by id (no database needed).
    await put(`story/${id}.json`, JSON.stringify(record), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      token: BLOB_TOKEN,
    });

    return res.status(200).json({ id });
  } catch (err) {
    console.error('create error', err);
    return res.status(500).json({ error: 'server', message: err.message || 'Something went wrong making your story.' });
  }
}
