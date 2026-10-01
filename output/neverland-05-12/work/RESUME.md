# Episodes 5–12 processing status

All episodes 5–12 are complete locally. No Groq calls were made during the completion turn; user explicitly prohibited further Groq calls for this one-time import. Original transcription remains prior Groq Whisper output with saved corrections/gap rechecks.

Episodes 7–12: direct07.txt through direct12.txt contain Codex-written Traditional Chinese translations aligned one row per prepared segment (07 starts at id 54, retaining its initial 54 Groq draft translations). Ready JSON files are authoritative. Do not rerun enrich.mjs or prepare.py over finalized content. Dictionary furigana plus contextual fixes are saved in ready files. Quality overrides for 05/06 were merged into ready files before further repairs.

Episode 2: 71 clips had furigana repaired, preserving exact original Japanese, timing and translations. Its authoritative prepared file is import-data/prepared/neverland-tsv/*S01E02*.json. TSV and combined 1–4 TSV were regenerated from prepared files. Do not run the old 1–4 finalizer, which would restore outdated readings.

ensure-ruby.mjs verifies/fills dictionary token coverage while preserving existing valid readings; unlike the old completion script, it does not treat every kanji since the previous bracket as covered. It processes episode 2 and 5–12. A second run added zero readings. Contextual fixes include 一人/二人, 君, あの方, 呪い, 隙, 次, 今一度, 八つ当たり and 片っ端.

finalize.py validates complete clip coverage, timestamps, source MP3 SHA256, exact ruby removal, valid hiragana readings, uncertainty markers, TSV fields and Traditional Chinese conversion. It exports individual TSVs, combined 5–12 and full Season 1 (3047 clips). Published provenance distinguishes prior Groq content from direct Codex translations and local furigana.

Publication COMPLETE: scripts/publish-prepared.mjs uploaded episode 2 and 5–12 to protected Firestore overrides with backups. Deployed in commit 76e27eb74cbdf6708e9fe3c36ed85a9cc2eac461 to main. GitHub Pages run 35892519118 succeeded. verify-published.mjs --live passed full deep equality for all 9 updated lessons against Firestore and https://rayux.github.io/demo-sha/. Website import-loader tests all 5 passed. Full-season UTF-8 TSV validates 12 sources and 3047 clips.

Follow-up whole-season furigana audit: prepared JSON is now authoritative for all 12 episodes. audit-all-ruby.mjs covers all prepared files and supports numeric ordinal annotation spans. furigana-audit-fixes.json stores contextual corrections; export-audit.py validated unchanged Japanese/translations/timestamps and refreshed all individual/combined TSVs. Ready files 5–12 were synchronized. Changes: E01 61, E03 90, E04 107, E05 6, E06 4, E07 2 = 270 clips. E02 and E08–12 unchanged. Uploaded all six changes to Firestore with backups, committed and pushed 91c1c75. Deployment run 35893533177 succeeded; full live website and Firestore equality verified for all 12 episodes. No Groq calls.
