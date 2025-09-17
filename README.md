// extension/README-snippet.md
# DreamWeb — Prompt API Edition (MV3)

**What it is:** A Chrome extension that turns any page into a cinematic, multimodal “Story Slides" using **Chrome’s Built IN AI ** (Gemini Nano) fully on-device.  


## How to run
1. Go to `chrome://flags` and ensure you’re enrolled in the **Built-in AI Early Preview** if required in your region.
2. `chrome://extensions` → **Load unpacked** → select the `extension/` folder.
3. Open a long article, click the DreamWeb icon → **Enter Story Mode**.

## Features mapped to docs
- `LanguageModel.availability()` + `monitor('downloadprogress')` → background logs to popup.
- `LanguageModel.create({ initialPrompts, expectedInputs, temperature, topK })`
- `session.prompt()` with **JSON Schema** `responseConstraint` for outline.
- Tone swap / translation via subsequent `prompt()` calls (session context).
- Abort support via internal controller (wired for future stop action).
- Graceful mock fallback when API not ready, so demo always works.

## 60-second demo flow
1. Open any dense article.
2. Click **Enter Story Mode** → overlay appears with hook + gradient art.
3. Click **Kid** tone → text rewrites in seconds.
4. Switch language **EN ⇄ TH** → lines translate live.
5. Click **Play narration** on any scene → Web Speech narrates the lines.
6. Mention: “All on-device with Google Built In AI ; no data leaves the machine.”

---