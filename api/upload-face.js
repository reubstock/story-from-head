// POST /api/upload-face   body: raw image bytes
// Uploads a headshot to Blob and returns its public URL. The browser calls
// this first (when the teller opts to "put a real face in it"), then passes
// the returned url to /api/create?face=... where Replicate swaps it onto the
// generated figure. Kept separate so /api/create can keep reading raw audio.

import { put } from '@vercel/blob';

export const config = { api: { bodyParser: false }, maxDuration: 30 };

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!BLOB_TOKEN) return res.status(503).json({ error: 'not_configured' });
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const img = Buffer.concat(chunks);
    if (!img.length) return res.status(400).json({ error: 'empty' });
    if (img.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'too_large', message: 'Photo must be under 10 MB.' });

    const ct = req.headers['content-type'] || 'image/jpeg';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const blob = await put(`story-face/${id}.${ext}`, img, { access: 'public', contentType: ct, token: BLOB_TOKEN });
    return res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error('upload-face error', err);
    return res.status(500).json({ error: 'server', message: err.message });
  }
}
