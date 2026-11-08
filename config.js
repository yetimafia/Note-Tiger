// Settings, loaded from .env next to the app.
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(APP_DIR, '.env') });
const e = process.env;

export const DISCORD_TOKEN = e.DISCORD_TOKEN || '';
export const ANTHROPIC_API_KEY = e.ANTHROPIC_API_KEY || '';
export const CLAUDE_MODEL = e.CLAUDE_MODEL || 'claude-sonnet-5-5';
export const OLLAMA_URL = e.OLLAMA_URL || 'http://127.0.0.1:11434';
export const OLLAMA_MODEL = e.OLLAMA_MODEL || 'llama3.1:8b';
export const OLLAMA_CONTEXT = Number(e.OLLAMA_CONTEXT || 16384);
export const WHISPER_MODEL = e.WHISPER_MODEL || 'onnx-community/whisper-small.en';
export const WHISPER_DTYPE = e.WHISPER_DTYPE || 'q8';
export const CAMPAIGN_NAME = e.CAMPAIGN_NAME || 'our Shadowrun campaign';
export const DATA_DIR = path.resolve(APP_DIR, e.DATA_DIR || 'data');
export const MODELS_DIR = path.join(APP_DIR, 'models');
export const PANEL_PORT = Number(e.PANEL_PORT || 3080);
export const AUTO_START = e.AUTO_START !== 'false';

// With a Claude key the bot uses Claude; without one it uses a local model through Ollama.
export const USE_CLAUDE = Boolean(ANTHROPIC_API_KEY);
