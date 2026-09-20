# Kage — Japanese shadowing practice

Kage is a local-first MVP for practicing Japanese with your own MP3 or MP4 files. The interface, audio library, recordings, sentence edits, and practice history live on your Mac. AI processing is optional.

## Run it

```bash
cd /Users/ray/Desktop/shadowing
npm start
```

Open [http://localhost:4173](http://localhost:4173).

The included `audio/` folder is automatically listed in the app. You can also choose any local MP3 or MP4 from the upload button.

## Optional AI features

The core player, pause-based clip scan, recording, side-by-side playback, and local history work without a key. To enable transcription, Traditional Chinese translation, grammar notes, contextual chat, and attempt transcription, add a Google AI Studio key to `.env`, then restart the server.

```bash
# edit .env and set GEMINI_API_KEY
npm start
```

Only the short active audio clip or recording that you explicitly analyze is sent to Gemini. The source video/audio file remains on this computer. The app does not put the API key in the browser.

## Current MVP boundaries

- The local clip scan is flow-first: it uses pauses as the primary boundary and only falls back to short ~6-second units when music or noise masks a pause. Every clip is editable; anime dialogue sometimes needs a manual merge or split.
- Feedback is based on recognized words and timing. Pitch accent / intonation is shown as an upcoming capability rather than an untrustworthy score.
- YouTube and Bilibili links are not imported or downloaded. Use locally held media that you have permission to practice with.
