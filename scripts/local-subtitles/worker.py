#!/usr/bin/env python3
"""MLX Whisper worker. Reads local, Bilibili, or YouTube audio and emits timestamped sections.

Only setup.sh downloads model weights. This worker requires a complete local model
and forces Hugging Face offline mode. Remote audio still needs network access.
"""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from streaming import pcm_windows, prefetch_one

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
MAX_DURATION = 6 * 3600
SAMPLE_RATE = 16000
CHUNK_SECONDS = 60
# Whisper pads every window to 30 s, so a 30 s opening section costs about a
# third of a 60 s one and the first lines appear several seconds sooner.
FIRST_SECONDS = 30
FOLLOW_IDLE_SECONDS = 120
CONTEXT_SECONDS = 2
# Whisper treats this as transcription context, not a system instruction. It can
# bias recognition toward conversation, but cannot separate simultaneous voices
# or identify speakers. Keep it short to reduce the chance of prompt-like captions.
CONVERSATION_CONTEXT = "日本語の会話、複数の話者、相づち、発話の重なり"
decoder = None


@contextmanager
def measure(timings, stage):
    started = time.perf_counter()
    try:
        yield
    finally:
        timings[stage] = timings.get(stage, 0) + (time.perf_counter() - started) * 1000


def progress(value, message):
    print(json.dumps({"type": "progress", "progress": value, "message": message}, ensure_ascii=False), flush=True)


def stop(_signum, _frame):
    if decoder and decoder.poll() is None:
        decoder.kill()
        decoder.wait()
    raise SystemExit(130)


def check(model):
    if sys.platform != "darwin":
        raise RuntimeError("Local MLX Whisper requires an Apple Silicon Mac.")
    import platform
    if platform.machine() != "arm64":
        raise RuntimeError("Run with an Apple Silicon arm64 Python, outside Rosetta.")
    import mlx.core as mx
    import mlx_whisper  # noqa: F401
    import imageio_ffmpeg
    if not mx.metal.is_available():
        raise RuntimeError("Metal is unavailable. Run the service from a normal Mac terminal.")
    if not (model / "config.json").is_file() or not any((model / name).is_file() for name in ("weights.safetensors", "weights.npz")):
        raise RuntimeError("Whisper model is missing. Run scripts/local-subtitles/setup.sh first.")
    binary = os.environ.get("KAGE_FFMPEG") or imageio_ffmpeg.get_ffmpeg_exe()
    if not Path(binary).is_file():
        raise RuntimeError("FFmpeg is missing. Run scripts/local-subtitles/setup.sh first.")
    return binary


def owned_segment(segment, offset, owner_start, owner_end, duration):
    """Keep each word in exactly one chunk, with context on both sides of its boundary."""
    words = segment.get("words", [])
    if words:
        owned = []
        for word in words:
            start = float(word.get("start", 0)) + offset
            end = float(word.get("end", 0)) + offset
            midpoint = (start + end) / 2
            if math.isfinite(start) and math.isfinite(end) and owner_start <= midpoint < owner_end:
                owned.append((word, start, end))
        if not owned:
            return None
        text = "".join(str(item[0].get("word", "")) for item in owned).strip()
        start, end = owned[0][1], owned[-1][2]
    else:
        text = str(segment.get("text", "")).strip()
        start = float(segment.get("start", 0)) + offset
        end = float(segment.get("end", 0)) + offset
        if not owner_start <= (start + end) / 2 < owner_end:
            return None
    end = min(end, duration)
    start = max(0, start)
    if not text or not math.isfinite(start) or not math.isfinite(end) or end <= start:
        return None
    return {"start": start, "end": end, "text": text[:4000]}


def transcribe_window(samples, model, transcriber=None):
    """Apply conversational context while retaining Whisper's silence safeguards."""
    if transcriber is None:
        import mlx_whisper
        transcriber = mlx_whisper.transcribe
    # MLX applies initial_prompt to the first decoding window of each call. We
    # provide it again for each audio chunk without feeding prior predictions
    # back into decoding, which can cause repetition and timing failures.
    return transcriber(
        samples, path_or_hf_repo=str(model), language="ja", task="transcribe",
        initial_prompt=CONVERSATION_CONTEXT,
        verbose=None, temperature=0.0, condition_on_previous_text=False,
        no_speech_threshold=0.6, logprob_threshold=-1.0,
        compression_ratio_threshold=2.4, word_timestamps=True,
        hallucination_silence_threshold=2.0,
    )


def feed_growing_file(source, expected, sink):
    """Copy an upload that is still being written into FFmpeg, in order.

    The helper appends upload chunks to `source`; transcription starts on the
    first bytes instead of waiting for the whole file.
    """
    sent = 0
    idle_since = time.monotonic()
    try:
        with open(source, 'rb') as handle:
            while sent < expected:
                piece = handle.read(min(1024 * 1024, expected - sent))
                if piece:
                    sink.write(piece)
                    sent += len(piece)
                    idle_since = time.monotonic()
                    continue
                if time.monotonic() - idle_since > FOLLOW_IDLE_SECONDS:
                    raise RuntimeError('The upload stopped before the whole file arrived.')
                time.sleep(0.02)
    except (BrokenPipeError, ValueError, OSError):
        pass  # FFmpeg exited; its exit code reports the failure.
    finally:
        try:
            sink.close()
        except OSError:
            pass


def warm(model):
    """Load weights and compile kernels before audio arrives."""
    import numpy as np
    transcribe_window(np.zeros(SAMPLE_RATE, dtype=np.float32), model)


def transcribe(source, target, model, ffmpeg, url=None, follow_bytes=None):
    global decoder
    setup_started = time.perf_counter()
    timings = {}
    import numpy as np

    duration_hint = None
    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error"]
    if url:
        from download import resolve_audio, source_platform
        progress(0, f"Connecting to {source_platform(url)} audio…")
        media = resolve_audio(url)
        duration_hint = media['duration']
        print(json.dumps({'type': 'metadata', 'duration': duration_hint, 'mediaMode': media['mode']}), flush=True)
        command += ['-protocol_whitelist', 'http,https,tcp,tls', '-rw_timeout', '30000000',
                    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
        headers = ''.join(f'{key}: {value}\r\n' for key, value in media['headers'].items())
        if headers:
            command += ['-headers', headers]
        input_path = media['url']
    elif follow_bytes:
        progress(0, "Reading audio while it uploads…")
        command += ['-protocol_whitelist', 'pipe']
        input_path = 'pipe:0'
    else:
        progress(0, "Reading audio on this Mac…")
        command += ['-protocol_whitelist', 'file,pipe']
        input_path = str(source)
    command += ['-format_whitelist', 'mov,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts',
                '-copyts', '-start_at_zero', '-i', input_path, '-map', '0:a:0', '-vn', '-sn', '-dn',
                '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', str(SAMPLE_RATE),
                '-c:a', 'pcm_s16le', '-t', str(MAX_DURATION + 1), '-f', 's16le', 'pipe:1']
    cues = []
    duration = 0
    # A file avoids stderr pipe deadlocks. Decoder details (including signed URLs)
    # are never returned to the extension or written into durable job records.
    with tempfile.TemporaryFile() as errors:
        decoder = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors,
                                   stdin=subprocess.PIPE if follow_bytes else subprocess.DEVNULL)
        if follow_bytes:
            import threading
            threading.Thread(target=feed_growing_file, args=(source, follow_bytes, decoder.stdin),
                             name='upload-follow', daemon=True).start()
        timings['sourceSetupMs'] = (time.perf_counter() - setup_started) * 1000
        windows = prefetch_one(pcm_windows(decoder.stdout, SAMPLE_RATE, CHUNK_SECONDS, CONTEXT_SECONDS, MAX_DURATION,
                                           first_seconds=FIRST_SECONDS))
        try:
            while True:
                with measure(timings, 'audioWaitMs'):
                    try:
                        window = next(windows)
                    except StopIteration:
                        break
                samples = np.frombuffer(window['raw'], dtype='<i2').astype(np.float32) / 32768.0
                chunk_cues = []
                if samples.size and float(np.max(np.abs(samples))) > 0.001:
                    with measure(timings, 'recognitionMs'):
                        result = transcribe_window(samples, model)
                    for segment in result.get('segments', []):
                        if segment.get('no_speech_prob', 0) > 0.6 and segment.get('avg_logprob', 0) < -0.5:
                            continue
                        if segment.get('compression_ratio', 0) > 2.4:
                            continue
                        bound = min(MAX_DURATION, window['offset'] + len(samples) / SAMPLE_RATE)
                        cue = owned_segment(segment, window['offset'], window['start'], window['end'], bound)
                        if not cue:
                            continue
                        start = round(max(cue['start'], cues[-1]['end'] if cues else 0), 3)
                        end = round(cue['end'], 3)
                        if end > start:
                            cue = {'id': str(len(cues)), 'start': start, 'end': end, 'text': cue['text']}
                            cues.append(cue)
                            chunk_cues.append(cue)
                duration = window['end']
                print(json.dumps({'type': 'chunk', 'cues': chunk_cues, 'processedThrough': duration, 'timings': timings,
                                  'duration': max(duration_hint or 0, duration, max((cue['end'] for cue in chunk_cues), default=0))}, ensure_ascii=False), flush=True)
            code = decoder.wait(timeout=30)
            if code:
                raise RuntimeError('Audio download or decoding stopped. Retry this video or import a local file.')
            if duration <= 0 or duration > MAX_DURATION:
                raise RuntimeError('Choose media with audio between 0 and six hours long.')
            if duration_hint and duration < duration_hint - 2:
                raise RuntimeError('The audio ended before the video finished. Retry the download.')
            target.write_text(json.dumps({'duration': duration, 'cues': cues}, ensure_ascii=False), encoding='utf-8')
            progress(1, 'Japanese subtitles are ready.')
        finally:
            if decoder.poll() is None:
                decoder.kill()
            decoder.wait()
            # Kill the producer before joining prefetch, which may be waiting for PCM.
            windows.close()
            decoder.stdout.close()
            decoder = None
            print(json.dumps({'type': 'timings', 'timings': timings}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--url")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--follow-bytes", type=int)
    parser.add_argument("--standby", action="store_true")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        model = args.model.resolve()
        ffmpeg = check(model)
        if args.check:
            print(json.dumps({"ready": True}))
            return
        if args.standby:
            # A warm worker: the helper hands it a job on stdin when one arrives.
            warm(model)
            print(json.dumps({"type": "standby"}), flush=True)
            line = sys.stdin.readline()
            if not line.strip():
                return
            spec = json.loads(line)
            args.input = Path(spec["input"]) if spec.get("input") else None
            args.url = spec.get("url")
            args.output = Path(spec["output"])
            args.follow_bytes = spec.get("followBytes")
        if (not args.input and not args.url) or not args.output:
            parser.error("--input or --url, and --output are required unless --check is used")
        if args.follow_bytes is not None and not (0 < args.follow_bytes <= 4 * 1024 ** 3):
            parser.error("--follow-bytes must be between 1 byte and 4 GiB")
        transcribe(args.input.resolve() if args.input else None, args.output.resolve(), model, ffmpeg, url=args.url,
                   follow_bytes=args.follow_bytes)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
