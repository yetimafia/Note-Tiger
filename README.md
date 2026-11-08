# 🐯 Note Tiger

**A Discord bot that listens to your tabletop RPG sessions, writes the recap for you, and remembers your whole campaign.**

Built for Shadowrun, and it works for any game played over Discord voice.

- 🎙️ Joins your voice channel muted and transcribes everyone at the table
- 📼 Posts a recap when you're done: the job, NPCs, places, loot and nuyen, consequences, loose threads, best quotes
- 🧠 Answers questions about past sessions: *"What did Mr. Johnson offer us for the Ares job?"*
- 🖥️ A control panel in your browser, so there's no digging through files
- 💸 **Free by default:** speech-to-text and the recap AI can both run on your own PC. Nothing gets uploaded.

![Dashboard](docs/dashboard.png)
![Sessions](docs/sessions.png)

---

## Install (Windows, about 15 minutes)

### Step 1: Create your Discord bot

1. Go to the **[Discord Developer Portal](https://discord.com/developers/applications)** and click **New Application**. Give it any name.
2. Open the **Bot** tab:
   - Click **Reset Token** and copy the token. You'll paste it into the control panel later. **Keep it secret.**
   - Scroll to **Privileged Gateway Intents** and turn on **Server Members Intent**. Click **Save Changes**.
3. Open **OAuth2 → URL Generator**:
   - Under **Scopes**, tick `bot` and `applications.commands`.
   - Under **Bot Permissions**, tick **View Channels**, **Send Messages**, **Attach Files**, **Use Slash Commands**, **Connect** and **Speak**.
   - Copy the URL at the bottom, open it, and add the bot to your server.

### Step 2: Download Note Tiger

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Unzip it somewhere **outside OneDrive**, for example `C:\NoteTiger`. OneDrive would otherwise try to sync gigabytes of AI models and your group's transcripts.

### Step 3: Run the installer

Double-click **`install.bat`**. It will:
- install Node.js if you don't have it (it'll ask you to run it again afterwards)
- install the bot
- ask which AI should write recaps:
  - **1: Free, on your PC** (Ollama). Downloads about 6.5 GB. Works best with an NVIDIA or AMD graphics card.
  - **2: Claude.** Smarter recaps, pay-as-you-go (usually pennies per session). Needs an API key from [console.anthropic.com](https://console.anthropic.com).
- download and test the speech-to-text model

If Windows shows a blue "Windows protected your PC" box, click **More info → Run anyway**. The scripts are plain text, so you can open them in Notepad to see exactly what they do.

### Step 4: Start it

Double-click **`start-bot.bat`**. Your browser opens the **control panel** at <http://localhost:3080>.
Go to **Settings**, paste your Discord token, and click **Save & restart bot**. The dashboard should turn green: **online** 🎉

> Keep the black `start-bot.bat` window open while you play. Closing it stops the bot.

---

## Game night

| In Discord | What happens |
|---|---|
| `/session start title:The Renraku Job` | The bot joins your voice channel and starts transcribing. It posts a 🔴 notice. |
| `/character name:Ghost` | Each player runs this once, so recaps use runner names. |
| `/note text:Ghost owes Twitch a favor` | Adds something from text chat to the session. |
| `/session stop` | Posts the recap (a minute or two later) with the transcript attached. |
| `/ask question:Who was the decker in Redmond?` | Answers from all recorded sessions. |
| `/recap` | Re-posts the latest recap. |
| `/optout mode:on` | The bot won't record that person's voice. |

In the **control panel** you can also read every recap and transcript, download transcripts, rewrite a recap, delete sessions, ask questions, and change settings.

> **Tell your group before you record.** Everyone in the voice channel is transcribed.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard says **"turn on Server Members Intent"** | Developer Portal → Bot → Privileged Gateway Intents → turn on **Server Members Intent** → Save, then click Save & restart in Settings. |
| **"Discord rejected the token"** | Developer Portal → Bot → **Reset Token**, then paste the new token in Settings. |
| Slash commands don't show up | Restart Discord (Ctrl+R). Make sure you ticked `applications.commands` when inviting the bot. |
| **"Could not reach Ollama"** | Open the **Ollama** app (it lives in the system tray by the clock), or run `setup-local-ai.bat` again. |
| Control panel won't open | Make sure `start-bot.bat` is running, then go to <http://localhost:3080>. |
| Transcripts are garbled | Use headsets and push-to-talk or noise suppression. Try the **Medium** Whisper model in Settings if your PC is fast. |
| Recording stopped working after a Discord update | Close the bot and run `install.bat` again to update the voice libraries. |

---

## Mac / Linux

Requires [Node.js 22.12+](https://nodejs.org) (and [Ollama](https://ollama.com) for free local recaps: `ollama pull llama3.1:8b`).

```bash
npm install
npm run test-speech   # downloads the speech model
./start.sh            # then open http://localhost:3080
```

## Where things are saved

Everything stays in the bot folder:
- `.env`: your settings and keys (the control panel edits this for you; never share it)
- `data/`: every session's transcript, notes and recap

Back up `data/` if you care about your campaign history.

## How it works

- **Voice:** [discord.js](https://discord.js.org) + `@discordjs/voice`, with Discord's end-to-end voice encryption (DAVE) support.
- **Speech-to-text:** OpenAI's Whisper model running locally through [Transformers.js](https://huggingface.co/docs/transformers.js). Audio is never saved or uploaded.
- **Recaps & questions:** a local model through [Ollama](https://ollama.com), or Claude if you add an API key. Long sessions are summarized in parts, then combined.

Receiving voice audio isn't officially documented by Discord, so a Discord change could break recording until the voice library catches up.

*Note Tiger is a work in progress. Ideas and bug reports are welcome in Issues!*
