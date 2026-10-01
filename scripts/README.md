# One-time episode import

The regular website continues to use Groq for new audio. Imported lessons live
in the separate Firestore `transcriptOverrides` collection so old browser tabs
cannot overwrite them through the normal autosave endpoint.

Run from the project root with `.env` configured and ffmpeg available:

```sh
FFMPEG=/path/to/ffmpeg node scripts/import-episodes.mjs
node scripts/import-episodes.mjs --publish
```

The first command stages timestamped Japanese, bracket-format furigana,
Traditional Chinese translations and playback ranges under `import-data/`.
Original MP3s are not changed; clips use start/end ranges into those files.
Intermediate batches are resumable. `--episodes=1,2` restricts the selection.
Review staged data before publishing; machine transcription is not a
human-verified transcript. Source audio hashes and original ASR text are retained.

Publishing validates all selected episodes, backs up existing database documents
under `import-data/backups/`, atomically writes the selected overrides in a
Firestore batch, reads them back, and writes fallback JSON files to
`transcripts/overrides/` and `public/transcripts/overrides/`.

The browser checks imported lessons before its old cache. The server checks
local override files, then Firestore overrides, then ordinary saved transcripts.
Autosaves keep using the ordinary collection. New uploads retain the existing
website workflow. Imported lessons reload the published version when reopened.

Database and disk persistence preserve data across restarts. The site and audio
still require a running server or a deployed static copy to be accessible.
Deploy both application changes and generated fallback files to use this on
another host. Keep `.env` and `import-data/` private.
