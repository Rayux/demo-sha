#!/usr/bin/env node
// Explicit local-only benchmark. Uses synthetic dialogue, never saved transcripts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { translateCues } from './translation.mjs';

const argument = (flag, fallback) => { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; };
const model = argument('--model', 'gemma2');
const output = argument('--output', 'output/subtitle-performance/translation-benchmark.json');
const rounds = Number(argument('--rounds', '2'));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error('Use 1–5 rounds.');
const config = { model, endpoint: 'http://127.0.0.1:11434/v1/chat/completions' };
const lines = [
  'おはよう。昨日はよく眠れた？', 'ううん、隣の部屋がうるさくて、あまり眠れなかった。',
  'それなら、今日は無理しないほうがいいよ。', 'ありがとう。でも、午後までにこの仕事を終わらせないと。',
  '駅までは歩いてどのくらいかかりますか。', 'ここから十分くらいです。二つ目の角を右に曲がってください。',
  'すみません、この電車は新宿に止まりますか。', 'いいえ、次の駅で各駅停車に乗り換えてください。',
  'このケーキ、甘すぎなくておいしいね。', '本当？砂糖の代わりにはちみつを少し入れたんだ。',
  '雨が降りそうだから、傘を持っていこう。', 'さっきまで晴れていたのに、急に暗くなったね。',
  'その話、田中さんにはまだ言わないで。', 'わかった。ちゃんと決まってから伝えるんだね。',
  '別に怒っているわけじゃない。ただ、少し驚いただけ。', 'そうだったんだ。勘違いしてごめん。',
  '来週の会議は火曜日じゃなくて、水曜日に変更になりました。', '水曜日の午後三時ですね。予定を確認しておきます。',
  'これ、捨ててもいい？', '待って、それはまだ使うから、机の上に置いておいて。',
  'そんなに急がなくても、まだ間に合うよ。', 'でも、電車が遅れたらどうするの？',
  'うまく説明できないけど、なんか違う気がする。', 'じゃあ、一度最初から一緒に考えてみよう。',
];
const freshCues = () => lines.map((text, index) => ({ id: String(index), text, start: index * 3, end: index * 3 + 2.9 }));
const report = { model, createdAt: new Date().toISOString(), description: 'Synthetic Japanese dialogue; warm-up excluded; inspect translations for meaning and Traditional Chinese.', results: [] };
const persist = async () => { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
console.log(`Warming ${model} on localhost…`);
await translateCues(freshCues().slice(0, 4), config, { batchSize: 4, signal: AbortSignal.timeout(240000) });
for (let round = 1; round <= rounds; round++) {
  for (const batchSize of round % 2 ? [4, 8, 12] : [12, 8, 4]) {
    const cues = freshCues(), started = performance.now();
    const metrics = { requests: 0, retries: 0, requestMs: 0, queueMs: 0 };
    await translateCues(cues, config, { batchSize, signal: AbortSignal.timeout(600000),
      onMetrics: entry => { for (const key of Object.keys(metrics)) metrics[key] += entry[key]; } });
    const result = { round, batchSize, wallMs: Math.round(performance.now() - started), ...metrics,
      complete: cues.every(cue => cue.translation?.trim()), translations: cues.map(({id,text,translation}) => ({id,text,translation})) };
    report.results.push(result); await persist();
    console.log(JSON.stringify({ round, batchSize, seconds: Math.round(result.wallMs / 100) / 10, requests: result.requests, retries: result.retries, complete: result.complete }));
  }
}
console.log(`Results saved to ${output}`);
