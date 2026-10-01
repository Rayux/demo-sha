# Local subtitle performance check

Measured on Apple M1 Pro, 32 GiB RAM, using the existing gemma2 model. 2026-10-01T18:05:45.655Z.

24 synthetic Japanese dialogue lines per pass; warm-up excluded; two passes per size in forward and reverse order. Timings include response validation and fallback requests.

| Batch size | Mean elapsed | Requests per pass | Retry requests per pass |
| --- | --- | --- | --- |
| 4 | 44.28 s | 7, 11 | 1, 5 |
| 8 | 31.89 s | 3, 3 | 0, 0 |
| 12 | 33.29 s | 2, 2 | 0, 0 |

Selected 8 lines: 28.0% less elapsed translation time than 4 in this sample. This does not measure whole-video speed or predict performance during two concurrent Whisper jobs. All runs returned all 24 IDs after fallbacks. Models, prompts, temperatures, and output token limits were unchanged.

Manual review found semantic inaccuracies in all sizes. For example, the request not to tell Tanaka yet was mistranslated across sizes. One 8-line run dropped “second” from the turn directions and another omitted Wednesday from its confirmation. These are not claims of equivalent translation quality; larger batches need continued review on real subtitle tracks. Eight lines is a moderate default with bounded input and existing missing-ID fallbacks.
