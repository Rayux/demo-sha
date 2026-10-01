"""Bounded PCM windows: one-minute ownership, two seconds of boundary context."""
from concurrent.futures import ThreadPoolExecutor


def pcm_windows(reader, sample_rate=16000, chunk_seconds=60, context_seconds=2, max_seconds=21600):
    unit = sample_rate * 2
    step = chunk_seconds * unit
    context = context_seconds * unit
    history = b''
    ahead = b''
    offset = 0
    while True:
        # read() may return short pieces, even before EOF (pipes/network decoders).
        wanted = step + context
        while len(ahead) < wanted:
            piece = reader.read(wanted - len(ahead))
            if not piece:
                break
            ahead += piece
        if not ahead:
            return
        if len(ahead) % 2:
            raise RuntimeError('Audio decoder returned an incomplete PCM sample.')
        owned = min(step, len(ahead))
        end = offset + owned / unit
        if end > max_seconds:
            raise RuntimeError('Choose media no longer than six hours.')
        yield {'raw': history + ahead, 'offset': offset - len(history) / unit,
               'start': offset, 'end': end}
        history = (history + ahead[:owned])[-context:] if context else b''
        ahead = ahead[owned:]
        offset = end


def prefetch_one(iterator):
    """Decode/download the next window while the caller transcribes this one."""
    sentinel = object()
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix='audio-prefetch') as pool:
        pending = pool.submit(next, iterator, sentinel)
        while True:
            item = pending.result()
            if item is sentinel:
                return
            pending = pool.submit(next, iterator, sentinel)
            yield item
