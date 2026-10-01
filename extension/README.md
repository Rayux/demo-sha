# Kage Chrome extension

## Load the update

In Chrome's extension management page, enable Developer mode and load this `extension` directory with **Load unpacked**, or reload the existing extension. Confirm version **1.7.6**, then refresh Netflix/Bilibili tabs afterward. Run `npm run subtitles:setup` once to install/update the Bilibili downloader, and restart the local subtitle helper.

This update restores **gemma2** once, as requested. Later model choices are preserved. The default local endpoint is `http://127.0.0.1:11434/v1/chat/completions`; the Ollama model must be installed and running. The local API key is optional. The website's server configuration is independent and is not modified by this extension.

**Groq backup is off by default.** A saved key alone cannot enable it. If you explicitly enable fallback in Options, failed local requests may be sent to Groq. Netflix-provided Chinese captions and dictionary readings need no LLM request.

## Subtitles and furigana

- The player's active native Japanese subtitle normally determines the displayed line. An enabled imported Bilibili track uses the player's playback time directly, including when native subtitles are unavailable. Original text appears immediately. An AI response can enrich only the still-active line; seeks, disappearing captions, disabling, and episode changes invalidate older renders.
- Furigana is always provided by bundled Kuromoji/IPADIC once its dictionary loads. It works offline and does not depend on translation completion, the model, or the optional **AI word meanings** setting. Readings also appear in the panel's selected sentence. Unknown names and ambiguous readings remain dictionary limitations; the extension does not invent missing readings. Dictionary load failures are visible in the Subtitles tab.
- On Netflix, the main-world adapter observes parsed manifest metadata and JSON XHR responses, retaining validated metadata for up to four titles even before entering the watch page. Navigation replays metadata for the exact current title and downloads one Japanese text track and one explicitly identified Traditional Chinese text track when available. It does not change the player's selected language. Simplified Chinese, forced-narrative-only tracks, image-only formats, and other titles are excluded. Native Chinese cues are selected by playback time; cue gaps remain empty rather than repeating an expired translation.
- When no usable native Chinese track is captured, the local model supplies the translation. Check **Study → Subtitles → Translation source** for the actual state. Netflix can change its manifest format or delivery method; live site compatibility is not guaranteed by fixture tests.
- Bilibili can use selectable text subtitles or generate a Japanese track by streaming the current video’s audio, or importing video/audio. Burned-in captions are not read; preparation uses the Japanese audio.

The vendor directory includes kuromoji@0.1.2, its compressed dictionary, copyright notices, and Apache-2.0 license. About 18 MB of dictionary assets are bundled so runtime readings do not send captions to another service. A small documented URL-joining patch preserves Chrome extension resource URLs.

## Bilibili without subtitles

Local video import uses **Whisper large-v3-turbo through MLX** for Japanese speech and timestamps, **Ollama** for Traditional Chinese, and the existing dictionary for furigana. New imports publish subtitles in roughly one-minute sections. Chinese translation uses up to eight lines per request, with individual retries for missing lines. Audio decoding, Whisper transcription, and local Chinese translation overlap, with up to two Whisper workers and one shared Ollama batch at a time. It requires an Apple Silicon Mac. There are no API charges. The initial setup downloads Python packages and a roughly 1.6 GB model; once installed, transcription runs offline. This does not change the main website's AI provider.

From the project root, install once and then start the helper:

```sh
npm run subtitles:setup
npm run subtitles:start
```

Keep the helper and Ollama running. The helper listens only on `127.0.0.1:8766`; the extension's existing localhost permission is used. It accepts media in bounded chunks, processes up to two videos concurrently, and deletes its uploaded media and temporary audio when processing finishes or is cancelled. The user's original file is untouched. Completed Japanese and Chinese results are saved locally for three days in `.local-subtitles/jobs` and in Chrome extension storage. No Firebase account is required.

Reopening the same video part or episode restores its saved subtitles, even after closing the tab or browser. The three-day deadline starts when processing finishes; reopening a video or editing its timing does not extend it. Chrome and the helper check for expired results every minute while running and clean up after restarting if they were closed. Expired subtitles cannot be played or recovered from the helper. Existing records use their last saved time. Storage remains bounded to 15 tracks / about 3 MiB in Chrome and 200 helper jobs, so older results can be evicted sooner when those limits are reached. Reload the extension and restart the idle helper to activate this update.

1. Reload Kage in Chrome, then refresh the Bilibili video page.
2. Open **Study → Subtitles → Download audio & prepare subtitles**. The helper streams audio from only the current BV video part (`p`) or bangumi episode. If separate audio is unavailable, it can use a combined stream at 360p or lower. There is no file picker or upload step. **Import video / audio** remains available for matching local files, up to 4 GiB and six hours.
3. The first Japanese lines appear as the first minute is transcribed; Chinese follows automatically while later sections continue. The panel shows how far Japanese preparation has reached and how many lines have Chinese. You can watch ready sections before the whole video finishes. The helper uses the local endpoint and model configured in Kage Settings. The import is ready when both languages are saved; no **Whole track** click is needed for new imports. Chinese progress shows completed and total lines.
4. Expand **Processing timings** to compare recognition, translation, and waiting times; the measurements stay with the saved track. Stage times overlap and do not add up to the processing total.
5. Play or seek normally. **Use imported subtitles** switches between imported and native captions. Positive **Timing offset** values display captions later. **Edit line at playhead** corrects Japanese text and its start/end times.

Tracks are tied to a Bilibili BV video and part (`p`), or a bangumi episode (`ep`). Tracking query parameters do not change the association. Uploaded media must match the playing cut; a constant offset cannot fix omitted scenes. Whisper receives a short Japanese conversation hint mentioning multiple speakers, backchannel responses, and overlapping speech. This supplies context; it cannot separate simultaneous voices or identify speakers. Recognition and dictionary readings can still be wrong, particularly for names, music, and overlapping speech.

Automatic downloads use yt-dlp and need internet. They do not read browser cookies; login-only, paid, region-restricted, or unavailable videos may require manual import. Audio is decoded into a bounded in-memory buffer, with one extra section prefetched; no full video download or merge is needed. Separate audio is preferred regardless of video resolution. When it is absent, only a 360p-or-lower combined stream can be used. Up to four videos can be active or queued across Bilibili tabs. URL jobs do not reserve the local file-upload budget while waiting; up to two videos process at a time, sharing a single Chinese translation request slot. Local file uploads share a separate 4 GiB allowance. **Study → Subtitles → Video queue** opens expanded on Bilibili pages, lists processing videos first and waiting videos in queue order, and updates automatically. Each waiting video shows its queue position; the current video is marked **This video**. Download jobs include an **Open video** link. Use **Stop** to remove a particular job from the queue. **Stop processing** stops the current video. Ready subtitle sections are kept; temporary media is removed. Completed videos do not occupy queue slots. Rerun setup to update yt-dlp if Bilibili changes its site.

Imported-subtitle translation, preparation, and tutor requests stay local even if Groq backup is enabled for native captions. Both languages are saved with their timestamps for replay. A stopped helper does not affect already saved subtitles or furigana. Keep the helper and Ollama running until preparation finishes. Refreshing or closing the tab after the automatic job starts (or a manual file upload finishes) does not stop the helper; reopening the same page reconnects. An upload interrupted before completion must be cancelled and selected again.

If Chinese translation fails, Japanese and completed Chinese lines are retained. **Retry Chinese translations** resumes missing lines without re-uploading or retranscribing. A helper restart interrupts transcription and preserves ready sections; download or import again for the complete video. Only a fully transcribed track can resume Chinese translation without repeating transcription. Older Japanese-only imports still work with **Whole track**. Editing Japanese invalidates that line's saved Chinese so the local model can translate the corrected text; changing only timing keeps its translation.

See [local helper details](../scripts/local-subtitles/README.md) for setup and troubleshooting.

## Automatic helper startup

Run `npm run subtitles:autostart` once after stopping any manually started helper. This is a one-time setup and installs a per-user macOS login agent and starts it immediately. The helper stays running without a terminal and restarts if it exits. Keep Ollama running for Chinese translations. `npm run subtitles:status` checks it; `npm run subtitles:autostart:remove` stops and removes automatic startup without deleting saved subtitles. These commands refuse to interrupt active work. To load later helper updates, rerun `npm run subtitles:autostart` while it is idle.

## Study panel

Version 1.7.6 gives the shared study panel an iOS-inspired light appearance with grouped white cards, a segmented control, blue actions, and tighter tutor typography (1.45 line height). Expand **Timing & corrections** to adjust offsets, edit lines, or remove a saved track. Reload the extension and refresh the video tab to see the redesign; no helper restart is needed for these panel changes.

The eye button below the subtitle drag handle hides or shows the Chinese subtitle line and translation status. Both controls appear on hover or keyboard focus. Dragged subtitle positions scale with the player and remain inside its bounds. Entering or exiting fullscreen immediately reattaches captions to the correct player, including while paused. Chinese boxes match the Japanese box width; longer translations wrap inside it. Japanese and furigana remain visible. This display preference is saved across videos and reloads; translations keep preparing and remain available in the study panel. Reload the extension and refresh video tabs to load the update; this UI update does not require restarting the helper.

Click **Study** to automatically explain the current sentence. The selected sentence stays fixed while playback continues. Answers stream into the panel as they are generated; Particle/Verb form/Slang prompts and the input stay available. Sending a question interrupts the current answer. Closing the panel cancels unfinished tutor work. Use **Use current line** to choose a new sentence without losing the conversation. Enter sends; Shift+Enter adds a line; Escape closes. The panel follows fullscreen containers and isolates typing from player hotkeys.

**Subtitles** displays the translation source, dictionary status, and preparation controls. Native Chinese availability disables unnecessary translation preparation.

## Background preparation and replay

For local translations, leave Japanese subtitles enabled and play a line so the captured track can be matched to the selected native language. **Next 10 lines** prepares the ten cues after the current position. **Whole track** prepares upcoming dialogue first, then earlier lines in the captured file. The file can be partial if the site delivers segmented subtitles. Keep the tab open and the computer awake; pausing playback lets preparation build a buffer.

**Stop** stops further manual scheduling. The current batch may finish, and normal rolling preloading remains available. Seeking, changing episode, selected track, provider settings, or disabling the extension cancels manual preparation. Reopening/reloading the tab does not automatically restart an unfinished whole-track job; start it again to reuse completed results and continue.

Normal look-ahead covers up to 24 upcoming cues within two minutes and continues through caption gaps once the Japanese track is matched. With **AI word meanings** off, preparation translates up to four lines per model request and sends completed results directly to the page's display cache. Explicit result IDs preserve subtitle alignment. Models that cannot produce a valid batch fall back to individual requests, retaining completed results. AI word meanings retains individual detailed requests.

One local inference runs at a time. Current dialogue can cancel unrelated speculative inference, and obsolete foreground requests are aborted. A current line already in a batch shares its result. Cancelled work never triggers Groq backup; only malformed translation output gets one format retry, while network/authentication failures do not. Tutor requests move ahead of queued subtitle work and cancel unrelated speculative extension preparation. A typed question interrupts the panel’s previous answer. A running foreground subtitle finishes before the tutor starts. The separate local import helper has its own translation queue and can still compete for Ollama while an import is being prepared. Cancellation requests depend on the local server honouring client disconnects.

Batch preparation reduces request overhead; it cannot guarantee zero delay on the first uncached line or when the model translates slower than dialogue arrives. It needs a captured Japanese text track to prepare future lines. The native Chinese track is optional. For dense dialogue on a slow local model, pause and use **Next 10 lines** or **Whole track** to build a buffer.

Completed translations persist in Chrome extension storage, bounded to 8,000 entries or approximately 6 MB. Oldest entries are evicted. Model, endpoint, output mode, fallback setting, target language and text form the cache key. Rewinding reuses a completed translation unless it was evicted or its settings changed. Fast-forwarding beyond prepared lines still requires translation.

## Verification

Run from the repository root:

```sh
npm run test:extension
```

The tests cover timing, stale responses, repeated cues, local-only provider routing, cache persistence, batch preparation and ID alignment, cancellation and resumption, subtitle-language changes, navigation/XHR manifest capture, native Chinese timing, and furigana retention. Model requests and Netflix metadata are fixtures; they verify behavior rather than measure real model speed.

`tests/preview.html` is a standalone development fixture with mocked model responses and the real bundled dictionary. Serve the `extension` directory on localhost and open `/tests/preview.html` to review the panel and dictionary loading. It is not loaded by the production manifest.

`tests/import-preview.html` previews the imported-track panel, timing controls, subtitle gaps and editor with a synthetic saved Bilibili track. Model responses are mocked; no media upload or external inference is performed. The service tests use loopback HTTP and a fixture worker; they need permission to listen on localhost. Actual MLX/Metal transcription must be checked separately on a Mac outside restricted sandboxes.

Before relying on a build, test live Netflix/Bilibili playback, pause/resume, seeking, changing subtitle language, fullscreen, and next episode. Existing audio/subtitle mismatches on the platform cannot be corrected by following native timing.
