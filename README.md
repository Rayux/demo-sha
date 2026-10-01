# Kage — Japanese shadowing practice

Kage is a local-first MVP for practicing Japanese with your own MP3 or MP4 files. The interface, audio library, recordings, sentence edits, and practice history live on your Mac. AI processing is optional.

## Run it

```bash
cd /Users/ray/Desktop/shadowing
npm start
```

Open [http://localhost:4173](http://localhost:4173).

## Cloudflare hosting

Cloudflare deployment is prepared with the existing Groq and Firebase integrations.
See [CLOUDFLARE.md](CLOUDFLARE.md) for the free-plan setup, deployment commands, secrets,
and audio packaging. Publishing is a separate manual step.

The included `audio/` folder is automatically listed in the app. You can also choose any local MP3 or MP4 from the upload button.

## Optional AI features

The core player, pause-based clip scan, recording, side-by-side playback, and local history work without a key. To enable transcription, Traditional Chinese translation, grammar notes, contextual chat, and attempt transcription, add a Groq API key to `.env`, then restart the server.

```bash
# edit .env and set GROQ_API_KEY
npm start
```

Only the short active audio clip or recording that you explicitly analyze is sent to Groq. The source video/audio file remains on this computer. The app does not put the API key in the browser.

## Current MVP boundaries

- The local clip scan is flow-first: it uses pauses as the primary boundary and only falls back to short ~6-second units when music or noise masks a pause. Every clip is editable; anime dialogue sometimes needs a manual merge or split.
- Feedback is based on recognized words and timing. Pitch accent / intonation is shown as an upcoming capability rather than an untrustworthy score.
- YouTube and Bilibili links are not imported or downloaded. Use locally held media that you have permission to practice with.

## Prepared transcript overrides

The app supports a one-time prepared lesson import. A transcript document whose clips contain `start`, `end`, `japanese`, `rubyText`, and `translation` is treated as prepared: those fields and timestamps are loaded first from Firestore (with the local transcript fallback), and the pause scanner is skipped. Browser autosave cannot replace a prepared lesson. A manual “Re-analyze clip” sends the same stored audio range to Groq for comparison while keeping the prepared lesson text authoritative. New or incomplete clips continue through the normal Groq transcription and translation flow.

To publish JSON prepared by ChatGPT, place it under `import-data/prepared/` and run `node scripts/publish-prepared.mjs import-data/prepared/*.json`. The publisher checks that every source MP3 exists, timestamps are chronological, furigana preserves the Japanese text, and translations are Traditional Chinese before backing up and writing `transcriptOverrides`.

JSON is optional. ChatGPT can return a plain TSV/text file instead. Use one `SOURCE`, one `DURATION`, and rows in this shape: `CLIP<TAB>start<TAB>end<TAB>Japanese<TAB>Japanese with furigana<TAB>Traditional Chinese`. Publish it with `node scripts/publish-prepared-text.mjs path/to/episode.tsv`.
