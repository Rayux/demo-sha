# Local Japanese subtitles

This optional helper streams the current Bilibili video’s audio, or accepts a local video/audio file, and creates timestamped Japanese
subtitles for the Kage extension. It uses **MLX Whisper large-v3-turbo on this Mac**,
and automatically translates ready sections into Traditional Chinese through the extension's
configured local Ollama endpoint and model. The extension adds furigana with its existing dictionary. The original web app's
Groq settings are independent of this helper.

The software and model have no per-minute or API charges. You supply an Apple Silicon
Mac, disk space, and electricity. Initial installation downloads Python packages and
about 1.6 GB of model weights; transcription subsequently runs offline. There is no
cloud fallback. Accurate captions still depend on the original audio, and speech
recognition can mishear names, music, or overlapping speakers.

## Setup and use

Requirements: Apple Silicon macOS, native arm64 Python 3.10+ and Node.js 18.17+.

From the repository root:

```sh
bash scripts/local-subtitles/setup.sh
bash scripts/local-subtitles/run.sh
```

Setup is safe to rerun. It keeps its virtual environment and the pinned model in
`.local-subtitles/`. FFmpeg is included through `imageio-ffmpeg`; Homebrew is not
required. Run the helper in a normal Mac terminal so MLX can access Metal. Keep the
terminal open, reload the extension after installing its changes, and use the Study
panel's **Download audio & prepare subtitles** control while viewing the matching Bilibili episode. The helper resolves the current BV part or bangumi episode, prefers its separate audio stream, and decodes it progressively. When separate audio is absent, a combined stream at 360p or lower is allowed. **Import video / audio** still accepts a local file.

Setup also installs/updates [yt-dlp](https://github.com/yt-dlp/yt-dlp). Existing installations must rerun setup and restart the helper once. Automatic downloads need internet and never read browser cookies. Login-only, paid, region-restricted, unavailable, or videos without a supported audio stream can fail; the panel keeps manual import available. No full video or PCM audio file is required for the progressive workflow. FFmpeg decodes into a pipe, and only the current minute, two seconds of surrounding context, and one prefetched minute are held in memory. The current section is transcribed while the next one is read; Ollama translates earlier sections concurrently. Refreshing or closing the tab after starting the job does not stop it; reopening the same video reconnects. A helper restart requires a fresh download.

The helper listens only on `127.0.0.1:8766`. Manually uploaded video and audio are copied to a temporary
job directory on this Mac and deleted when transcription completes, fails, or is
cancelled. Results persist for three days after processing finishes so closing and reopening the panel can recover them. Expired job directories are deleted automatically every minute while the helper runs, or at its next startup. Reads and translation retries reject expired results immediately. The extension also expires its saved Japanese/Chinese tracks after three days; opening the video or adjusting timing does not extend that deadline.
Interrupted transcription retains ready sections but requires downloading/importing again for the complete video.
Interrupted translation retains Japanese and completed Chinese lines; use **Retry Chinese translations**
to resume missing lines. Refreshing or closing the browser tab after upload does not stop the job.
Abandoned uploads expire after one hour without a successful chunk. The last
200 job records are retained at most; storage limits can evict older records before three days.

Use the same cut of the video that Bilibili plays. A constant timing offset can be
adjusted in the panel; different edits need matching media. Audio extraction preserves
the media's initial stream delay. Whisper works on 60-second windows with two seconds
of surrounding context. Words are assigned to windows by their timestamp midpoint to
reduce cut-off words and duplicate captions at boundaries. This is best-effort speech
recognition; captions should still be reviewed. A short Japanese context hint tells
Whisper that the audio is conversation with multiple speakers, backchannel responses,
and overlapping speech. It is not diarization or source separation and cannot ensure
every simultaneous voice is recognized. The translation prompt preserves fragments
and uncertainty and does not invent speaker identities or inaudible dialogue.

Limits: 4 GiB per file and across pending uploads/downloads, four pending jobs, six hours of
audio per file, and one transcription at a time. Decoding accepts common local video
and audio containers and disables network and playlist input. Silent media can
successfully produce an empty subtitle list. An automatic job conservatively reserves the full media budget until it finishes. Video jobs share one queue; within a job, decoding/downloading, Whisper, and one Ollama batch overlap. Model weights stay loaded across sections within the Whisper process. Cancellation stops the process group and aborts in-flight translation before cleanup. Set `KAGE_PIPELINE_PARALLEL=0` when starting the helper to defer Chinese inference until transcription finishes on lower-memory machines.

## Start automatically at login

Stop any manually started helper, then run `npm run subtitles:autostart`. The installer writes `~/Library/LaunchAgents/com.kage.local-subtitles.plist`, validates it, and loads it for the current macOS user. It uses absolute Node/Python/model paths and logs to `.local-subtitles/logs/`. No administrator access or terminal window is required. The agent starts at login and restarts after an exit. Ollama must also be running.

Use `npm run subtitles:status` to check readiness. Rerun `npm run subtitles:autostart` while idle to restart after a helper update. Use `npm run subtitles:autostart:remove` to stop and remove the login agent; transcripts, models, and manually uploaded originals are preserved. The installer refuses to interrupt active work.

## Local API

Every request must use the `localhost` or `127.0.0.1` Host with the service port.
Origin may be absent for local command-line clients or a valid `chrome-extension://`
origin. Website origins, including Bilibili itself, are rejected. The extension must
send requests through its background service worker.

`GET /health` returns `{ok:true, ready, model, token, capabilities:{translation:true,bilibiliDownload:true,progressiveSubtitles:true,audioOnly:true},processing:{sectionSeconds:60,parallelStages:true}, status, error?}`. Capabilities describe API support; missing downloader packages produce a setup error when a download runs. A fresh random
token is generated each time the helper starts; all `/jobs` requests must send it as
`X-Kage-Token`. No cookies are used. CORS is enabled only for extension origins.

| Request | Payload / result |
| --- | --- |
| `POST /jobs` | JSON `{name,size}` for uploads, or `{sourceUrl}` for a Bilibili page → `{id}` |
| `PUT /jobs/:id/audio?offset=N` | Raw bytes, at most 2 MiB per sequential chunk → `{received}` |
| `POST /jobs/:id/start` | JSON `{translation:{endpoint,model}}` → current job, queues transcription with progressive Chinese translation; retry resumes missing translations |
| `GET /jobs/:id` | Current job; poll approximately once per second |
| `DELETE /jobs/:id` | Cancels job and removes its media and transcript |

Jobs contain `id`, `name`, `size`, `received`, `state`, `progress` (0–1), `message`,
`createdAt`, and `updatedAt`. Download jobs also have a canonical `sourceUrl`. They start in `uploading` as an unstarted reservation; `/start` skips the upload check and queues the download. Only Bilibili BV pages with a positive part or a specific bangumi episode are accepted. The extension derives this URL from the sending tab, ignoring caller-supplied URLs. States are `uploading`, `queued`, `downloading`, `preparing`, `transcribing`,
`translating`, `complete`, `error`, `translation_error`, and `cancelled`. Jobs with
recognized Japanese contain `duration` in seconds and `cues: [{id,start,end,text,translation?}]`;
cue times are seconds in the original video timeline. `text` is Japanese and `translation`
is Traditional Chinese. While `state` is `preparing`, `cues` may be partial (or empty during a silent introduction). `processedThrough` marks the Japanese section boundary; `transcriptionComplete` becomes true only after the full stream and final result are verified. Do not treat partial recognition as a translation-only retry after a failure. Translation progress uses `translationCompleted` and `translationTotal`.
Legacy API clients may omit `translation` to request only Japanese. Endpoints accept
only loopback HTTP(S) for translation, reject embedded credentials and disable redirects; cloud fallback
is never used. Errors use `{error: "message"}` with an
appropriate HTTP status. Starting an already-started job is safe to retry. After a
lost upload response, read `received` before sending the next chunk.

Local paths and model can be overridden with `KAGE_SUBTITLES_DIR`,
`KAGE_SUBTITLES_PYTHON`, `KAGE_WHISPER_MODEL`, and `KAGE_FFMPEG`. The port can be
overridden with `KAGE_SUBTITLES_PORT`, but the extension expects the default 8766.

## Checks

```sh
node --test scripts/local-subtitles/server.test.mjs
python3 scripts/local-subtitles/worker_test.py
python3 scripts/local-subtitles/streaming_test.py
.local-subtitles/venv/bin/python scripts/local-subtitles/download_test.py
```

Transport tests use a deterministic fixture and temporary loopback ports. They do
not download or load an AI model. Actual inference needs the setup above and Metal
access. The model revision is pinned in `setup.sh`; changing it is deliberate.

References: [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper),
[Whisper model](https://huggingface.co/mlx-community/whisper-large-v3-turbo),
[OpenAI Whisper MIT license](https://github.com/openai/whisper/blob/main/LICENSE).

## Video queue

Up to four videos may be active or queued. Different Bilibili tabs can submit different videos; up to two videos process at a time, sharing a single Chinese translation request slot. Waiting URL jobs do not consume the separate 4 GiB local-upload allowance. The authenticated `GET /jobs` endpoint lists active jobs without transcript or model settings. In Study → Subtitles → Video queue, Stop cancels a selected job, retains ready subtitle sections, and removes temporary media. Completed jobs are unaffected by a late Stop request.

## Processing timings and translation batches

Chinese translation uses up to **8 subtitle lines per request**, with a 1,600-character limit on the requested Japanese text (a single longer line is handled alone). Both videos share one request slot. Missing or duplicated response IDs still receive individual retries; ready translations are kept and Japanese text/timing is untouched. For a manual helper run, `KAGE_TRANSLATION_BATCH_SIZE=4 npm run subtitles:start` restores the smaller batch size; values from 1 through 12 are supported.

Open **Study → Subtitles → Processing timings** to see elapsed processing, queue wait, Japanese recognition, Chinese inference, translation-slot wait, audio setup, and audio wait. These measurements are saved with the subtitles and survive reopening the video. They include failed attempts and translation retries. Recognition includes the first Whisper call's model-loading cost. Audio wait measures blocking for the next prefetched audio window, including network/decoding; it is not a separate measure of download throughput. The worker's total wall time is also recorded in the helper result as `timings.workerWallMs`.

Stages overlap, so their times must not be added to estimate overall completion time. Existing transcripts do not acquire timings retroactively. During an in-flight request, inference totals update when that request finishes; processing time continues to update while polling.

To compare batch sizes on the installed local model without using saved transcripts:

```sh
node scripts/local-subtitles/benchmark-translation.mjs --model gemma2
```

Run while the helper is idle. The benchmark warms the model, then translates the same 24 synthetic Japanese lines with batches of 4, 8, and 12, in forward and reverse order. It writes request counts, retries, timings, and all translations to `output/subtitle-performance/translation-benchmark.json`. Completeness checks do not certify semantic accuracy; review the saved translations. No model downloads or cloud requests are made.
