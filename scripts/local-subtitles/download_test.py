import contextlib
import io
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import download


class DownloadTests(unittest.TestCase):
    def test_media_limits(self):
        for info in ({'_type': 'playlist'}, {'_type': 'multi_video'}, {'is_live': True},
                     {'duration': 21601}, {'filesize': download.MAX_BYTES + 1}):
            self.assertIsNotNone(download.check_media(info))
        self.assertIsNone(download.check_media({'duration': 120}))

    def run_download(self, callback):
        class Downloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(self, url, download):
                return callback(self.options, url)

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.dict('sys.modules', {
                'yt_dlp': types.SimpleNamespace(YoutubeDL=Downloader),
                'imageio_ffmpeg': types.SimpleNamespace(get_ffmpeg_exe=lambda: '/fixture/ffmpeg'),
            }):
                download.download('https://www.bilibili.com/video/BVtest?p=2', root)
            return (root / 'input.media').read_bytes()

    def test_fetches_one_part_with_video_and_audio_and_hands_off_media(self):
        def extract(options, url):
            self.assertTrue(options['noplaylist'])
            self.assertEqual(options['format'], 'bestaudio/best[height<=360]')
            self.assertEqual(options['ffmpeg_location'], '/fixture/ffmpeg')
            self.assertNotIn('cookiesfrombrowser', options)
            self.assertNotIn('cookiefile', options)
            self.assertEqual(url, 'https://www.bilibili.com/video/BVtest?p=2')
            Path(options['outtmpl'].replace('%(ext)s', 'mkv')).write_bytes(b'merged-video-audio')
            with contextlib.redirect_stdout(io.StringIO()) as output:
                options['progress_hooks'][0]({'status': 'finished', 'downloaded_bytes': 20, 'total_bytes': 20})
            self.assertIn('"type": "progress"', output.getvalue())
            return {'duration': 60}
        self.assertEqual(self.run_download(extract), b'merged-video-audio')

    def test_missing_or_unmerged_media_cannot_reach_transcription(self):
        for extensions in ([], ['mp4', 'mkv']):
            def extract(options, url):
                for ext in extensions:
                    Path(options['outtmpl'].replace('%(ext)s', ext)).write_bytes(b'part')
                return {'duration': 60}
            with self.assertRaisesRegex(RuntimeError, 'complete audio'):
                self.run_download(extract)

    def test_unknown_sizes_are_still_bounded_during_transfer(self):
        def extract(options, url):
            Path(options['outtmpl'].replace('%(ext)s', 'mp4.part')).write_bytes(b'too large')
            options['progress_hooks'][0]({'status': 'downloading'})
        with patch.object(download, 'MAX_BYTES', 3):
            with self.assertRaisesRegex(RuntimeError, '4 GiB'):
                self.run_download(extract)

    def test_real_selector_caps_resolution_and_keeps_audio(self):
        import yt_dlp
        formats = [
            {'format_id': 'audio', 'url': 'https://example.com/audio.m4a', 'vcodec': 'none', 'acodec': 'mp4a', 'ext': 'm4a'},
            {'format_id': '360', 'url': 'https://example.com/360.mp4', 'height': 360, 'vcodec': 'avc1', 'acodec': 'none', 'ext': 'mp4'},
            {'format_id': '1080', 'url': 'https://example.com/1080.mp4', 'height': 1080, 'vcodec': 'avc1', 'acodec': 'none', 'ext': 'mp4'},
        ]
        with yt_dlp.YoutubeDL({'format': download.FORMAT, 'quiet': True, 'no_warnings': True}) as downloader:
            selected = downloader.process_ie_result({'id': 'fixture', 'extractor': 'fixture', 'title': 'fixture', 'formats': formats}, download=False)
        self.assertEqual(selected['format_id'], 'audio')
        with yt_dlp.YoutubeDL({'format': download.FORMAT, 'quiet': True, 'logger': download.Logger()}) as downloader:
            with self.assertRaises(yt_dlp.utils.ExtractorError):
                downloader.process_ie_result({'id': 'fixture', 'extractor': 'fixture', 'title': 'fixture', 'formats': [formats[2]]}, download=False)


if __name__ == '__main__':
    unittest.main()
