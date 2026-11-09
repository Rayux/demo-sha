import assert from 'node:assert/strict';
import test from 'node:test';
import { videoURL, downloadableVideoURL } from './video-source.mjs';

test('anime1 episode pages are canonical page identities but never download sources', () => {
  assert.equal(videoURL('https://anime1.me/30595'), 'https://anime1.me/30595');
  assert.equal(videoURL('https://anime1.me/30595/?x=1#c'), 'https://anime1.me/30595');
  assert.equal(videoURL('https://www.anime1.me/30595'), 'https://anime1.me/30595');
  for (const bad of ['https://anime1.me/category/x', 'https://anime1.me:8443/30595', 'https://evil-anime1.me/30595', 'https://anime1.me/']) {
    assert.throws(() => videoURL(bad), bad);
  }
  assert.throws(() => downloadableVideoURL('https://anime1.me/30595'), /Prepare browser audio/);
  assert.equal(downloadableVideoURL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
