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


class ResolveAudioTests(unittest.TestCase):
    def resolve(self, info, url='https://www.youtube.com/watch?v=dQw4w9WgXcQ'):
        class Downloader:
            def __init__(self, options):
                self.options = options
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def extract_info(self, page, download):
                if 'youtube.com' in page:
                    assert 'node' in self.options['js_runtimes']
                assert not download
                assert 'cookiefile' not in self.options
                return info
        with patch.dict('sys.modules', {'yt_dlp': types.SimpleNamespace(YoutubeDL=Downloader)}):
            return download.resolve_audio(url)

    def test_youtube_audio_only_direct_stream_and_safe_headers(self):
        info = {'url': 'https://rr1.googlevideo.com/videoplayback?signature=private', 'protocol': 'https',
                'duration': 120, 'vcodec': 'none', 'http_headers': {'User-Agent': 'fixture', 'Cookie': 'secret', 'Referer': 'bad\r\nheader'}}
        stream = self.resolve(info)
        self.assertEqual(stream['mode'], 'audio')
        self.assertEqual(stream['headers'], {'User-Agent': 'fixture'})
        for url in ['file:///tmp/media', 'http://127.0.0.1/audio', 'https://googlevideo.com.evil.test/audio',
                    'https://rr1.bilivideo.com/audio', 'https://rr1.googlevideo.com:444/audio']:
            with self.assertRaisesRegex(RuntimeError, 'cannot be streamed'):
                self.resolve({**info, 'url': url})
        for extra in [{'is_live': True}, {'_type': 'playlist'}, {'duration': 21601}, {'duration': None}, {'protocol': 'm3u8_native'}]:
            with self.assertRaises(RuntimeError):
                self.resolve({**info, **extra})

    def test_bilibili_keeps_its_own_cdn_allowlist(self):
        info = {'url': 'https://upos.bilivideo.com/audio.m4a', 'protocol': 'https', 'duration': 60, 'vcodec': 'none'}
        self.assertEqual(self.resolve(info, 'https://www.bilibili.com/video/BVtest')['duration'], 60)
        with self.assertRaisesRegex(RuntimeError, 'cannot be streamed'):
            self.resolve({**info, 'url': 'https://rr1.googlevideo.com/audio'}, 'https://www.bilibili.com/video/BVtest')


class ResolutionErrorTests(unittest.TestCase):
    def test_unavailable_video_does_not_claim_node_is_outdated_or_leak_signed_urls(self):
        message = download.resolution_error('YouTube', Exception('Video unavailable https://host/secret?sig=private'))
        self.assertIn('direct downloader', message)
        self.assertIn('Prepare browser audio', message)
        self.assertNotIn('Node', message)
        self.assertNotIn('private', message)
        self.assertNotIn('https:', message)

    def test_solver_and_browser_session_errors_have_distinct_actions(self):
        self.assertIn('Node 22+', download.resolution_error('YouTube', Exception('No supported JavaScript runtime')))
        self.assertIn('browser session', download.resolution_error('YouTube', Exception('Sign in to confirm you are not a bot')))
        self.assertIn('connect', download.resolution_error('YouTube', Exception('Connection timed out')))


if __name__ == '__main__':
    unittest.main()
