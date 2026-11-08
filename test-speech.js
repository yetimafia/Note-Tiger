// Quick check that the speech model downloads and runs fast enough on this PC.
// Run with:  npm run test-speech
import 'dotenv/config';
import { pipeline, env as hfEnv } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Keep downloaded models next to the app so updates don't delete them.
hfEnv.cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'models');

const model = process.env.WHISPER_MODEL || 'onnx-community/whisper-small.en';
const dtype = process.env.WHISPER_DTYPE || 'q8';

console.log(`Loading ${model} (the first time downloads a few hundred MB)…`);
let t = Date.now();
const whisper = await pipeline('automatic-speech-recognition', model, { dtype });
console.log(`Loaded in ${((Date.now() - t) / 1000).toFixed(1)}s`);

// 30 seconds of quiet noise at 16 kHz, standing in for one long stretch of talking.
const seconds = 30;
const audio = new Float32Array(16000 * seconds).map(() => (Math.random() - 0.5) * 0.01);

t = Date.now();
await whisper(audio, { chunk_length_s: 30, stride_length_s: 5 });
const took = (Date.now() - t) / 1000;
console.log(`Transcribed ${seconds}s of audio in ${took.toFixed(1)}s`);

if (took < seconds / 3) console.log('✅ Plenty fast. You are good to go.');
else if (took < seconds) console.log('🟡 Fast enough, but recaps may take a few extra minutes after long sessions.');
else console.log('🔴 Too slow for this PC. Put WHISPER_MODEL=onnx-community/whisper-base.en in your .env and run this again.');
