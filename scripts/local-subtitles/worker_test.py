"""Worker tests require only the Python standard library, without MLX."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from worker import measure, owned_segment, transcribe_window


class TimingTests(unittest.TestCase):
    def test_stage_time_accumulates_and_counts_failed_attempts(self):
        timings = {}
        with patch('worker.time.perf_counter', side_effect=[1, 1.125, 2, 2.25]):
            with measure(timings, 'recognitionMs'):
                pass
            with self.assertRaises(ValueError):
                with measure(timings, 'recognitionMs'):
                    raise ValueError('failed inference')
        self.assertEqual(timings['recognitionMs'], 375)


class TranscriptionContextTests(unittest.TestCase):
    def test_production_adapter_passes_conversation_hint_and_preserves_recognition(self):
        samples = object()
        model = Path("/local/whisper-model")
        recognized = {"segments": [{"start": 0.2, "end": 1.7, "text": "そうなんだ。"}]}
        whisper = Mock(return_value=recognized)
        with patch.dict("sys.modules", {"mlx_whisper": SimpleNamespace(transcribe=whisper)}):
            result = transcribe_window(samples, model)

        self.assertIs(result, recognized)
        whisper.assert_called_once()
        args, options = whisper.call_args
        self.assertIs(args[0], samples)
        self.assertEqual(options["path_or_hf_repo"], str(model))
        self.assertEqual(options["language"], "ja")
        self.assertEqual(options["task"], "transcribe")
        self.assertIn("複数", options["initial_prompt"])
        self.assertIn("発話の重なり", options["initial_prompt"])
        self.assertLess(len(options["initial_prompt"]), 100)
        self.assertTrue(options["word_timestamps"])
        self.assertFalse(options["condition_on_previous_text"])
        self.assertEqual(options["no_speech_threshold"], 0.6)
        self.assertEqual(options["hallucination_silence_threshold"], 2.0)

    def test_context_is_supplied_to_each_chunk_without_becoming_caption_text(self):
        whisper = Mock(side_effect=[{"segments": []}, {"segments": []}])
        first = transcribe_window(object(), Path("/local/model"), transcriber=whisper)
        second = transcribe_window(object(), Path("/local/model"), transcriber=whisper)

        self.assertEqual(whisper.call_count, 2)
        self.assertTrue(all(call.kwargs["initial_prompt"] for call in whisper.call_args_list))
        self.assertEqual(first, {"segments": []})
        self.assertEqual(second, {"segments": []})


class ChunkOwnershipTests(unittest.TestCase):
    def test_boundary_words_keep_context_without_duplicate_captions(self):
        first = {"words": [{"word": "今日", "start": 119.2, "end": 119.8},
                           {"word": "は", "start": 119.8, "end": 120.4},
                           {"word": "晴れ。", "start": 120.4, "end": 121.2}]}
        second = {"words": [{"word": item["word"], "start": item["start"] - 118,
                             "end": item["end"] - 118} for item in first["words"]]}
        left = owned_segment(first, 0, 0, 120, 240)
        right = owned_segment(second, 118, 120, 240, 240)
        self.assertEqual(left["text"], "今日")
        self.assertEqual(right["text"], "は晴れ。")
        self.assertEqual(left["end"], 119.8)
        self.assertEqual(right["start"], 119.8)

    def test_rejects_context_only_empty_and_invalid_segments(self):
        self.assertIsNone(owned_segment({"words": [{"word": "古い", "start": 0, "end": 1}]}, 118, 120, 240, 240))
        self.assertIsNone(owned_segment({"text": "", "start": 1, "end": 2}, 0, 0, 120, 240))
        self.assertIsNone(owned_segment({"text": "bad", "start": float('nan'), "end": 2}, 0, 0, 120, 240))

    def test_clips_end_to_media_duration(self):
        cue = owned_segment({"text": "最後", "start": 9.8, "end": 10.3}, 0, 0, 11, 10)
        self.assertEqual(cue["end"], 10)


if __name__ == "__main__":
    unittest.main()


class FastTimestampRulesTests(unittest.TestCase):
    def test_gpu_rules_match_mlx_whisper_on_random_histories(self):
        try:
            import mlx.core as mx
            from mlx_whisper import decoding
            from mlx_whisper.tokenizer import get_tokenizer
        except ImportError:
            self.skipTest('mlx_whisper is installed only in the helper environment')
        import random
        import worker
        worker.install_fast_timestamp_rules()
        tokenizer = get_tokenizer(True, num_languages=100, language='ja', task='transcribe')
        begin, eot = tokenizer.timestamp_begin, tokenizer.eot
        vocab = begin + 1501
        rng = random.Random(7)
        for sample_begin in (3, 4):
            for max_initial in (None, 50):
                rules = decoding.ApplyTimestampRules(tokenizer, sample_begin, max_initial)
                for length in (0, 1, 2, 5, 12):
                    for _ in range(12):
                        rows = []
                        for _ in range(3):
                            row = [tokenizer.sot] * sample_begin
                            stamp = begin
                            for _ in range(length):
                                if rng.random() < 0.4:
                                    stamp = min(vocab - 1, stamp + rng.randint(0, 40))
                                    row.append(stamp)
                                else:
                                    row.append(rng.choice([rng.randint(0, eot - 1), eot]))
                            rows.append(row)
                        tokens = mx.array(rows)
                        logits = mx.array([[rng.uniform(-8, 8) for _ in range(vocab)] for _ in rows])
                        expected = rules._kage_original_apply(logits, tokens)
                        actual = rules.apply(logits, tokens)
                        self.assertTrue(bool(mx.array_equal(expected, actual, equal_nan=True).item()),
                                        f'mismatch at sample_begin={sample_begin} length={length}')
