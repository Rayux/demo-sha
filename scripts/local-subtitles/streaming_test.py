import io
import unittest
from streaming import pcm_windows, prefetch_one


class StreamingTests(unittest.TestCase):
    def test_sections_cover_audio_once_with_two_seconds_of_shared_context(self):
        raw = b''.join(index.to_bytes(2, 'little') for index in range(1300))
        windows = list(prefetch_one(pcm_windows(io.BytesIO(raw), sample_rate=10)))
        self.assertEqual([(w['start'], w['end']) for w in windows], [(0, 60), (60, 120), (120, 130)])
        self.assertEqual([w['offset'] for w in windows], [0, 58, 118])
        self.assertEqual(windows[0]['raw'], raw[:1240])
        self.assertEqual(windows[1]['raw'], raw[1160:2440])
        self.assertEqual(windows[2]['raw'], raw[2360:])

    def test_short_pipe_reads_do_not_look_like_the_end_of_audio(self):
        class ShortReads(io.BytesIO):
            def read(self, size):
                return super().read(min(size, 7))
        raw = bytes(2600)
        windows = list(pcm_windows(ShortReads(raw), sample_rate=10))
        self.assertEqual([w['end'] for w in windows], [60, 120, 130])

    def test_empty_audio_and_exact_boundary_do_not_create_extra_sections(self):
        self.assertEqual(list(pcm_windows(io.BytesIO(b''))), [])
        windows = list(pcm_windows(io.BytesIO(bytes(2400)), sample_rate=10))
        self.assertEqual([w['end'] for w in windows], [60, 120])

    def test_limit_and_incomplete_samples_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'six hours'):
            list(pcm_windows(io.BytesIO(bytes(2600)), sample_rate=10, max_seconds=120))
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            list(pcm_windows(io.BytesIO(bytes(3))))


if __name__ == '__main__':
    unittest.main()
