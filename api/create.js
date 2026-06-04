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
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
// cdingram/face-swap pinned version (same as Dreams). Refresh with:
//   curl -s https://api.replicate.com/v1/models/cdingram/face-swap -H "Authorization: Bearer $TOKEN" | jq -r .latest_version.id
const FACE_SWAP_VERSION = 'd1d6ea8c8be89d664a07a457526f7128109dee7030fdac424788d762c71ed111';

const STORY_STYLE = `Style: narrative oil painting — painterly, with visible brushwork and a warm, earthy palette lit by lamplight, candlelight, or soft natural light. A coherent, grounded figurative scene, observed and real but unmistakably PAINTED, in the spirit of Edward Hopper and John Singer Sargent. NOT photographic. NOT a photo. NOT generic AI art. NOT storybook or children's-book illustration. NOT digital illustration. NOT anime. NOT cartoon. NO text, letters, or words anywhere in the image.`;

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

  const system = `You are a careful transcript editor. Someone spoke a story aloud; your job is to present it in THEIR OWN WORDS, cleaned up only as much as a respectful transcriber would. You are NOT a writer. You have no literary voice. You never improve, dress up, or embellish. Preserving the teller's exact voice is the entire job — anything you add is a violation.

YOU MAY: remove filler ("um", "uh", "like", "you know", "I mean"), remove false starts and stutters, remove pure repetition, fix obvious transcription errors, add paragraph breaks, fix punctuation and capitalization.

YOU MAY NOT: add any detail, image, adjective, or phrase they didn't say; rephrase for style; upgrade their word choices; change their sentence structure; invent an opening line or a closing "landing"; make anything more vivid, poetic, dramatic, or "literary." If a sentence is plain, it stays plain. If they rambled, keep the ramble (minus the filler). When in any doubt, keep their original words verbatim.

The result must read like a faithful, lightly-cleaned transcript of exactly what they said — their voice, their words, nothing added, nothing dressed up.`;

  const user = `Here is the raw transcript of a told story. Clean it up faithfully (filler and false starts only) and return JSON.${forLine}

TRANSCRIPT:
"""${transcript}"""

Return ONLY a JSON object:
{
  "title": "2–6 words, plain and specific, drawn from the teller's own words. A label, not a flourish.",
  "story": "the teller's story IN THEIR OWN WORDS — only filler/false-starts/repetition removed and paragraph breaks added. NOT rewritten, NOT embellished, NOT restyled. It must read as what they actually said.",
  "blurb": "one plain line (~12 words) describing what the story is about, using the teller's own framing — no hype, no spoilers",
  "image_prompt": "one paragraph (~60 words) describing ONE concrete scene FROM the story to illustrate — only places, people, objects the teller actually mentioned. The place, the light, who is there and their rough age/look as stated. A moment, not a montage. Invent no new elements. No style words, no text/letters in the scene."
}`;

  let data;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2,
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

// ---- Analysis: the story's DNA. Sharp, specific, never greeting-card. ----
async function analyze(story) {
  const system = `You are a perceptive reader — part folklorist, part essayist — who finds the deeper shape of a very short story in a sentence or two. You are precise, concrete, and grown-up. You NEVER write greeting-card sentiment, therapy-speak, "this teaches us that…", or abstract-noun mush ("presence", "connection", "the human spirit", "the power of memory"). You point at specifics in the actual story, not at the universe. You are not flattering the teller; you are seeing the story clearly. When a story rhymes with a known folktale type, motif, or archetype, name it plainly.`;

  const user = `Read this short story and return ONLY a JSON object analyzing it:
{
  "kind": "3–6 words naming the archetype, plain and specific — e.g. 'A kindness-to-a-stranger story', 'A coming-of-age dare', 'A trickster's comeuppance'",
  "motifs": ["3 to 5 short motif/theme phrases — concrete, not abstract — e.g. 'grief disguised as routine', 'the persistence of love', 'found family'"],
  "turn": "one sentence naming the hinge — the moment the story pivots",
  "echo": "1–2 sentences: what this rhymes with in folklore or the wider canon. Name a real tale-type, motif, or archetype if one fits; otherwise name the universal pattern. No name-dropping for its own sake.",
  "insight": "ONE concrete sentence pointing at a specific choice in THIS story — what the teller noticed, lingered on, or left out, and what that does. Point at the story, not the universe. Forbidden: 'this teaches/reveals/illustrates that', any life-lesson, and abstract-noun mush.",
  "next": "ONE specific, slightly nosy follow-up question that makes the teller want to tell the NEXT story — like a curious friend who wants more, pulled from a real detail in THIS story. Concrete and a little cheeky. E.g. 'When did you get drunk next?', 'Did you ever get caught?', 'When was the last time you thought about him?'. NEVER generic ('What happened next?', 'How did that make you feel?')."
}

STORY:
"""${story}"""`;

  let data;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.6,
        response_format: { type: 'json_object' },
      }),
    });
    if (res.ok) { data = await res.json(); break; }
    if (res.status >= 500 && attempt < 2) { await new Promise((r) => setTimeout(r, 700 * (attempt + 1))); continue; }
    throw new Error(`analyze ${res.status}`);
  }
  let p = {};
  try { p = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch (_) {}
  return {
    kind: (p.kind || '').toString().slice(0, 80),
    motifs: Array.isArray(p.motifs) ? p.motifs.slice(0, 5).map((m) => m.toString().slice(0, 60)) : [],
    turn: (p.turn || '').toString().slice(0, 300),
    echo: (p.echo || '').toString().slice(0, 500),
    insight: (p.insight || '').toString().slice(0, 300),
    next: (p.next || '').toString().slice(0, 200),
  };
}

// ---- Replicate face-swap (best-effort; returns null on any failure) ----
async function faceSwap(generatedBuffer, faceUrl) {
  if (!REPLICATE_TOKEN || !faceUrl) return null;
  const targetDataUrl = `data:image/png;base64,${generatedBuffer.toString('base64')}`;
  try {
    const createRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json', Prefer: 'wait=55' },
      body: JSON.stringify({ version: FACE_SWAP_VERSION, input: { input_image: targetDataUrl, swap_image: faceUrl } }),
    });
    if (!createRes.ok) { console.warn('faceswap create', createRes.status, (await createRes.text()).slice(0, 160)); return null; }
    let prediction = await createRes.json();
    let attempts = 0;
    while (prediction.status && !['succeeded', 'failed', 'canceled'].includes(prediction.status) && attempts < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      const pollUrl = prediction.urls?.get; if (!pollUrl) break;
      const pollRes = await fetch(pollUrl, { headers: { Authorization: `Bearer ${REPLICATE_TOKEN}` } });
      if (!pollRes.ok) break;
      prediction = await pollRes.json(); attempts++;
    }
    if (prediction.status !== 'succeeded') { console.warn('faceswap status', prediction.status); return null; }
    const outUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!outUrl) return null;
    const imgRes = await fetch(outUrl);
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer());
  } catch (e) { console.warn('faceswap threw', e.message); return null; }
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

    // if the teller wants a real face in it, make the scene's main figure face-forward
    const face = (req.query.face || '').toString().slice(0, 600);
    let imagePrompt = crafted.image_prompt;
    if (face) imagePrompt += `\n\nIMPORTANT: depict the main person with their face clearly visible — frontal or three-quarter view, well lit, not turned away or obscured.`;

    // illustrate + analyze in parallel (both best-effort — a story still ships without either)
    const [imgBuf0, analysis] = await Promise.all([
      generateImage(imagePrompt).catch((e) => { console.warn('image failed:', e.message); return null; }),
      analyze(crafted.story).catch((e) => { console.warn('analyze failed:', e.message); return null; }),
    ]);

    // swap the real face onto the figure (best-effort — falls back to the scene)
    let imgBuf = imgBuf0, faced = false;
    if (imgBuf0 && face && REPLICATE_TOKEN) {
      const swapped = await faceSwap(imgBuf0, face).catch((e) => { console.warn('faceswap failed:', e.message); return null; });
      if (swapped) { imgBuf = swapped; faced = true; }
    }

    let image_url = null;
    if (imgBuf) {
      try {
        const blob = await put(`story-img/${newId()}.png`, imgBuf, { access: 'public', contentType: 'image/png', token: BLOB_TOKEN });
        image_url = blob.url;
      } catch (e) { console.warn('image blob failed:', e.message); }
    }

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
      faced,
      analysis,
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
