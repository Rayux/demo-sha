import assert from 'node:assert/strict';
import test from 'node:test';
import { anime1Post, mediaURL, parseEpisodeLinks, parseEpisodePage, searchSeries, createWebServer } from './server.mjs';

test('accepts only single anime1.me episodes', () => {
  assert.equal(anime1Post('https://anime1.me/30665'), '30665');
  assert.equal(anime1Post('30665'), '30665');
  assert.equal(anime1Post('https://anime1.me/?p=30665'), '30665');
  assert.equal(anime1Post('https://anime1.me/?cat=1984'), '');
  assert.equal(anime1Post('https://evil.example/30665'), '');
  assert.equal(anime1Post('https://anime1.me.evil.example/30665'), '');
});

test('accepts only anime1.me video servers', () => {
  assert.equal(mediaURL('//nazuna.v.anime1.me/1984/7b.mp4').href, 'https://nazuna.v.anime1.me/1984/7b.mp4');
  assert.equal(mediaURL('https://evil.example/1984/7b.mp4'), null);
  assert.equal(mediaURL('http://nazuna.v.anime1.me/1984/7b.mp4'), null);
});

test('reads an episode page and a series page', () => {
  const html = '<h2 class="entry-title">來自遠方 [07]</h2><video id="v" data-apireq="%7B%22c%22%3A%221984%22%7D" data-vid="x"></video><a href="/?cat=1984">全集連結</a>';
  assert.deepEqual(parseEpisodePage(html), { title: '來自遠方 [07]', apireq: '%7B%22c%22%3A%221984%22%7D', category: '1984' });
  const list = '<h2 class="entry-title"><a href="https://anime1.me/30665" rel="bookmark">A [07]</a></h2><li><a href="https://anime1.me/30664">B &amp; C [20]</a></li>';
  assert.deepEqual(parseEpisodeLinks(list), [{ post: '30665', title: 'A [07]' }, { post: '30664', title: 'B & C [20]' }]);
  assert.deepEqual(parseEpisodeLinks(list, true), [{ post: '30665', title: 'A [07]' }]);
});

test('other devices need the pairing code; wrong codes lock out', async t => {
  const { server } = await createWebServer({ access: { code: '123456', secret: 'a'.repeat(64) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // A forwarded request is not treated as the Mac itself.
  const remote = { 'X-Forwarded-For': '203.0.113.9' };
  const post = (code, headers = {}) => fetch(base + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', ...remote, ...headers }, body: JSON.stringify({ code }) });
  assert.deepEqual(await (await fetch(base + '/api/session', { headers: remote })).json(), { paired: false });
  assert.equal((await fetch(base + '/api/episode/1/subtitles', { headers: remote })).status, 401);
  assert.equal((await post('123456', { Origin: 'http://evil.example' })).status, 403);
  const paired = await post('123 456');
  assert.equal(paired.status, 200);
  const cookie = paired.headers.getSetCookie()[0].split(';')[0];
  assert.match(paired.headers.getSetCookie()[0], /HttpOnly; SameSite=Strict/);
  assert.deepEqual(await (await fetch(base + '/api/session', { headers: { ...remote, Cookie: cookie } })).json(), { paired: true });
  for (let attempt = 0; attempt < 8; attempt++) assert.equal((await post('000000')).status, 403);
  assert.equal((await post('123456')).status, 429);
});

test('search matches every word, in any order and case', () => {
  const list = [{ title: '青之蘆葦 第二季' }, { title: '來自遠方' }, { title: 'TANK CHAIR-戰車椅子-' }];
  assert.deepEqual(searchSeries(list, '蘆葦').map(item => item.title), ['青之蘆葦 第二季']);
  assert.deepEqual(searchSeries(list, '第二季 青').map(item => item.title), ['青之蘆葦 第二季']);
  assert.deepEqual(searchSeries(list, 'tank').map(item => item.title), ['TANK CHAIR-戰車椅子-']);
  assert.equal(searchSeries(list, '').length, 3);
  assert.equal(searchSeries(list, 'zzz').length, 0);
});
