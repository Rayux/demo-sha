#!/usr/bin/env python3
"""Fetch the audio of one public Bilibili part into the helper's temporary job."""
import argparse
import json
import math
from urllib.parse import urlsplit
import os
from pathlib import Path
import sys
import time

MAX_BYTES = 4 * 1024 ** 3
MAX_DURATION = 6 * 3600
# Prefer audio only; use a combined stream up to 360p when separate audio is absent.
FORMAT = 'bestaudio/best[height<=360]'


def check_media(info, *, incomplete=False):
    if info.get('_type') in ('playlist', 'multi_video') or info.get('is_live'):
        return 'Choose one recorded Bilibili video part or episode.'
    duration = info.get('duration')
    if duration is not None and duration > MAX_DURATION:
        return 'This video exceeds the six-hour limit.'
    if (info.get('filesize') or 0) > MAX_BYTES:
        return 'This video exceeds the 4 GiB limit.'
    return None


class Logger:
    def debug(self, _message):
        pass

    def warning(self, _message):
        pass

    def error(self, _message):
        pass


def download(url, directory):
    try:
        import yt_dlp
        import imageio_ffmpeg
    except ImportError as error:
        raise RuntimeError('Install the Bilibili downloader with npm run subtitles:setup, then restart the helper.') from error

    work = directory / 'download'
    work.mkdir(mode=0o700)
    last_update = 0

    def progress(event):
        nonlocal last_update
        # Account for both DASH streams; merge may temporarily need twice this space.
        size = sum(item.stat().st_size for item in work.iterdir() if item.is_file())
        if size > MAX_BYTES:
            raise RuntimeError('The Bilibili download exceeds the 4 GiB limit.')
        now = time.monotonic()
        if now - last_update < 0.5 and event.get('status') != 'finished':
            return
        last_update = now
        total = event.get('total_bytes') or event.get('total_bytes_estimate') or 0
        fraction = min(0.99, event.get('downloaded_bytes', 0) / total) if total else 0
        print(json.dumps({'type': 'progress', 'progress': fraction,
                          'message': 'Downloading Bilibili audio…'}), flush=True)

    options = {
        'format': FORMAT,
        'outtmpl': str(work / 'video.%(ext)s'),
        'noplaylist': True,
        'playlist_items': '1',
        'match_filter': check_media,
        'break_on_reject': True,
        'max_filesize': MAX_BYTES,
        'ffmpeg_location': imageio_ffmpeg.get_ffmpeg_exe(),
        'merge_output_format': 'mkv',
        'quiet': True,
        'no_warnings': True,
        'logger': Logger(),
        'progress_hooks': [progress],
        'socket_timeout': 30,
        'retries': 3,
        'fragment_retries': 3,
        'concurrent_fragment_downloads': 1,
        'cachedir': False,
        'overwrites': False,
        'writethumbnail': False,
        'writesubtitles': False,
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=True)
    if not info or info.get('_type') in ('playlist', 'multi_video'):
        raise RuntimeError('Bilibili did not return a single playable video part.')
    files = [item for item in work.iterdir() if item.is_file() and item.suffix in ('.m4a', '.mp4', '.mkv', '.webm', '.flv', '.mp3', '.ogg', '.opus')]
    if len(files) != 1 or not 0 < files[0].stat().st_size <= MAX_BYTES:
        raise RuntimeError('Bilibili did not provide a complete audio stream under 4 GiB.')
    os.replace(files[0], directory / 'input.media')



def resolve_audio(url):
    """Resolve once; FFmpeg consumes the audio progressively without a full download."""
    try:
        import yt_dlp
    except ImportError as error:
        raise RuntimeError('Install the Bilibili downloader with npm run subtitles:setup.') from error
    page = urlsplit(url)
    if page.scheme != 'https' or page.hostname != 'www.bilibili.com' or page.username or page.password or page.port:
        raise RuntimeError('Use a Bilibili video page.')
    try:
        with yt_dlp.YoutubeDL({'format': FORMAT, 'noplaylist': True, 'playlist_items': '1',
                              'quiet': True, 'logger': Logger(), 'no_warnings': True,
                              'cachedir': False, 'socket_timeout': 30, 'retries': 3,
                              'extractor_retries': 3}) as downloader:
            info = downloader.extract_info(url, download=False)
    except Exception as error:
        raise RuntimeError('Cannot access Bilibili audio. Retry or import a local file; login-only or restricted videos may be unavailable.') from error
    if not info or check_media(info):
        raise RuntimeError(check_media(info or {}) or 'Bilibili did not provide a single audio stream.')
    duration = info.get('duration')
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise RuntimeError('Bilibili did not provide a valid duration of up to six hours.')
    stream = urlsplit(info.get('url') or '')
    # Only direct Bilibili CDN media is handed to the decoder. No playlist or local URLs.
    domains = ('bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'hdslb.com', 'akamaized.net')
    if (stream.scheme not in ('http', 'https') or stream.username or stream.password or stream.port not in (None, 80, 443)
            or not any(stream.hostname == domain or (stream.hostname or '').endswith('.' + domain) for domain in domains)
            or info.get('protocol') not in ('http', 'https')):
        raise RuntimeError('This Bilibili audio format cannot be streamed. Import a local file instead.')
    if info.get('vcodec') != 'none' and (not info.get('height') or info['height'] > 360):
        raise RuntimeError('No separate audio or low-resolution fallback is available.')
    headers = {key: str(value) for key, value in info.get('http_headers', {}).items()
               if key.lower() in ('user-agent', 'referer') and not any(c in str(value) for c in '\r\n')}
    return {'url': info['url'], 'duration': duration, 'headers': headers,
            'mode': 'audio' if info.get('vcodec') == 'none' else '360p fallback'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        download(args.url, args.directory)
    except Exception as error:
        message = str(error)
        if 'Requested format is not available' in message:
            message = 'A 360p or lower video is not available for this episode. Import a local file instead.'
        elif 'Install the Bilibili downloader' not in message:
            # Avoid saving signed CDN URLs, response bodies, or third-party diagnostics.
            message = 'Bilibili download failed. The video may require login, be region-restricted, or be temporarily unavailable. Retry or import a local file.'
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
