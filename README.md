# Kage — learn Japanese from the videos you watch

Kage is a free Chrome extension that adds **Japanese subtitles with furigana and
Traditional Chinese translations** to videos on **YouTube, Bilibili, Anime1.me,
and Netflix**. You can also ask an **AI tutor** about any line ("what does this
particle mean?") while you watch.

The subtitles are made on your own Mac, so your videos and audio never leave
your computer. Only the questions you ask the tutor are sent to an online AI
service (Groq).

You do not need to know how to code. Setup takes about 30–45 minutes, once.
Follow the steps in order, and copy each command exactly.

---

## What you need

- **A Mac with Apple Silicon** (M1, M2, M3, M4 or newer).
  To check: click the Apple menu at the top left, then **About This Mac**.
  It should say **Chip: Apple M…**. On an Intel Mac or on Windows, the automatic
  subtitles will not work (Netflix subtitles and the tutor still do).
- **Google Chrome**
- **About 10 GB of free space** and an internet connection during setup

---

## Step 1 — Install three free programs

Install each one like any other Mac app:

1. **Node.js** — go to [nodejs.org](https://nodejs.org), click the big
   **LTS** download button, open the downloaded file, and click **Continue**
   until it finishes.
2. **Python** — go to [python.org/downloads](https://www.python.org/downloads/),
   click **Download Python 3.12** (or newer), open the file, and click
   **Continue** until it finishes. When a Finder window opens afterwards,
   double-click **Install Certificates.command** inside it.
3. **Ollama** (makes the Chinese translations) — go to
   [ollama.com/download](https://ollama.com/download), download the Mac app,
   drag it into **Applications**, and open it once. A small llama icon appears
   at the top of your screen; leave it running.

---

## Step 2 — Open Terminal

Terminal is the Mac app where you type the commands below.

1. Press **Command + Space**, type **Terminal**, and press **Return**.
2. For each grey box below: copy it, click in the Terminal window, paste with
   **Command + V**, and press **Return**.
3. Wait until the command finishes (a new line with a `%` or `$` appears)
   before pasting the next one.

---

## Step 3 — Download Kage

```bash
git clone https://github.com/Rayux/demo-sha.git ~/Documents/Kage
```

This puts Kage in a folder called **Kage** inside your **Documents** folder.
Keep it there: Kage remembers this location.

If your Mac asks to install **command line developer tools**, click **Install**,
wait for it to finish, and then paste the command above again.

---

## Step 4 — Set up the subtitle maker

Paste these one at a time. The first one takes 5–15 minutes because it
downloads the speech-recognition model (about 1.6 GB). It is done when it says
**Ready.**

```bash
cd ~/Documents/Kage
```

```bash
npm run subtitles:setup
```

```bash
npm run subtitles:autostart
```

The last command starts the subtitle maker now and every time you log in to
your Mac, so you never need to open Terminal again.

Then download the translation model (about 5 GB):

```bash
ollama pull gemma2
```

---

## Step 5 — Add Kage to Chrome

1. In Chrome, type `chrome://extensions` in the address bar and press **Return**.
2. Turn on **Developer mode** (the switch at the top right).
3. Click **Load unpacked**.
4. Open **Documents → Kage**, select the folder named **extension**, and click
   **Select**.
5. Click the puzzle-piece icon in Chrome's toolbar and pin **Kage** so it is
   always visible.

Chrome may show a note about developer-mode extensions. That is normal for
extensions installed this way.

---

## Step 6 — Turn on the AI tutor (optional)

The tutor needs a free key from Groq. Everything else works without it.

1. Go to [console.groq.com](https://console.groq.com) and sign in (a Google
   account works).
2. Click **API Keys**, then **Create API Key**, and copy the key.
3. In Chrome, right-click the **Kage** icon and choose **Options**.
4. Paste the key into **Groq API key** and click **Save Settings**.

Keep your key private, like a password. Each person should create their own.

---

## Using Kage

1. Open a video on **YouTube**, **Bilibili**, or **Anime1.me**.
2. Kage starts preparing subtitles straight away. The first lines are ready
   within a few seconds, and the rest is prepared faster than you can watch.
3. Press play. Japanese subtitles with furigana and Chinese translations appear
   on the video.
4. Click the round **Kage** button with the book icon on the page to open the
   **Study** panel. On the **Tutor** tab you can type a question, or tap
   **Particle**, **Verb form**, or **Slang**.

On **Netflix**, choose **Japanese** subtitles in the Netflix player; Kage adds
the translations.

Clicking the Kage icon in Chrome's toolbar turns Kage on or off.

Subtitles you have prepared are saved for 3 days, so reopening a video is
instant.

---

## Updating Kage

When there is a new version, open Terminal and paste:

```bash
cd ~/Documents/Kage && git pull && npm run subtitles:autostart
```

Then go to `chrome://extensions` and click the circular reload arrow on the
Kage card, and refresh any open video tabs.

---

## If something goes wrong

**"Cannot reach the local helper"** — the subtitle maker is not running. Paste:

```bash
cd ~/Documents/Kage && npm run subtitles:autostart
```

**"command not found: npm"** — Node.js is not installed yet, or Terminal was
open while you installed it. Install Node.js (Step 1), then quit Terminal
completely (**Command + Q**), open it again, and repeat the step that failed.

**"This local transcription setup requires an Apple Silicon Mac"** — this Mac
cannot make subtitles. Netflix subtitles and the tutor still work.

**Subtitles appear but without Chinese** — make sure the Ollama llama icon is at
the top of your screen, and that `ollama pull gemma2` finished.

**The tutor asks for a Groq API key** — do Step 6.

**I don't want Kage to start preparing on every video** — right-click the Kage
icon, choose **Options**, untick **Prepare subtitles as soon as a video opens**,
and click **Save Settings**. Then use **Download audio & prepare subtitles** in
the Study panel when you want subtitles.

**Something else** — open the Study panel and look at the **Subtitles** tab; it
explains most problems in plain words.

---

## Removing Kage

```bash
cd ~/Documents/Kage && npm run subtitles:autostart:remove
```

Then remove Kage at `chrome://extensions`, delete the **Kage** folder in
Documents, and (optionally) remove the translation model with
`ollama rm gemma2`.

---

## Privacy

- Video audio and the subtitles made from it stay on your Mac.
- Chinese translations are made on your Mac by Ollama.
- Questions to the tutor, together with the subtitle line you are asking about,
  are sent to Groq using your own key.
- Please use Kage only with videos you are allowed to watch.

---

## For developers

### Practice app

The repository also contains a shadowing practice web app for your own MP3 or
MP4 files. Put files in the `audio/` folder, then:

```bash
npm install
npm start
```

Open [http://localhost:4173](http://localhost:4173). The core player,
pause-based clip scan, recording, side-by-side playback, and local history work
without a key. To enable transcription, Traditional Chinese translation, grammar
notes, contextual chat, and attempt transcription, copy `.env.example` to `.env`,
set `GROQ_API_KEY`, and restart. Only the short clip or recording you analyze is
sent to Groq; the API key is never sent to the browser.

Current boundaries:

- The clip scan uses pauses as the primary boundary and falls back to short
  ~6-second units when music or noise masks a pause. Every clip is editable.
- Feedback is based on recognized words and timing; pitch accent is not scored.

Prepared transcripts: a transcript whose clips contain `start`, `end`,
`japanese`, `rubyText`, and `translation` is treated as prepared and skips the
pause scanner. Publish JSON from `import-data/prepared/` with
`node scripts/publish-prepared.mjs import-data/prepared/*.json`, or a TSV with
rows `CLIP<TAB>start<TAB>end<TAB>Japanese<TAB>Japanese with furigana<TAB>Traditional Chinese`
using `node scripts/publish-prepared-text.mjs path/to/episode.tsv`.

### Hosting

See [CLOUDFLARE.md](CLOUDFLARE.md) for deploying the practice app to Cloudflare.

### Extension and subtitle helper

See [extension/README.md](extension/README.md) and
[scripts/local-subtitles/README.md](scripts/local-subtitles/README.md).
Tests: `npm run test:extension` and `npm run test:playback`.
