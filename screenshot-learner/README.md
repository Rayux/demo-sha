# Japanese study: clipboard and screenshots

A Chrome extension that translates Japanese into Traditional Chinese (Taiwan), provides readings, and supports follow-up questions in a native side panel. Text and screenshots go only to your configured localhost model.

## Automatic clipboard workflow

Open the **Clipboard** tab and leave **Auto-translate copied text** on (the default). Copy Japanese text with Command+C or Ctrl+C from a PDF, webpage, or another application. The visible panel checks for changes approximately every 900 ms and translates new text automatically. No additional shortcut or sparkle click is required.

Existing clipboard contents are ignored when you first enable the watcher; copying new text starts translation. Unchanged content is not repeatedly sent. Copying a new passage cancels the old in-flight AI request and starts a fresh conversation. Switching to Screenshot, turning off the checkbox, or closing the panel stops watching. A temporarily hidden panel pauses reads and checks for changes when shown again. The extension does not need focus while you copy from another app.

## Optional shortcut workflow

1. Reload the unpacked extension in `chrome://extensions` after updating. Chrome may request the new clipboard-read permission.
2. Copy Japanese text with Command+C (Mac) or Ctrl+C (Windows/Linux), from a webpage, a PDF with selectable text, or another application.
3. Press **Command+Shift+7 on Mac** or **Ctrl+Shift+7 on Windows/Linux**. The extension reads the clipboard once and opens the **Clipboard** tab in Chrome's side panel. Ask follow-up questions below the translation.
4. Copy another passage and use the shortcut again. A new passage cancels the previous in-flight AI request and starts a fresh conversation.

The shortcut is registered as global, so Chrome can handle it while another app is focused, provided Chrome is running with a normal browser window available. Check `chrome://extensions/shortcuts` if another app or extension has claimed the key; confirm that **Translate copied text into Traditional Chinese** has an assigned shortcut and Global scope. The panel displays the actual registered shortcut, including an unassigned warning. ChromeOS does not support global extension commands. Current Chrome is recommended for opening the panel from a global command with no active browser tab.

You can also use **Translate clipboard**, or paste into **Or paste text here** and press Command+Enter / Ctrl+Enter. Empty, image-only, and oversized clipboards produce a recovery message; the previous study remains available. Maximum text length: 12,000 characters. Scanned PDFs need OCR before their text can be copied, or use Screenshot mode.

There is no webpage selection watcher, page injection, sparkle, or site-enablement step. Clipboard polling runs only while the visible Clipboard tab has auto-translate enabled. The shortcut and Translate clipboard button also read on demand. Plain text is read using an offscreen extension document and its temporary field is cleared immediately. Clipboard text persists only in Chrome session storage for the study session; copying text automatically sends it to AI while clipboard watching is enabled.

## Screenshot workflow

**Capture current tab** in Screenshot mode or the existing `capture-study` keyboard shortcut captures the visible browser tab. Check its assigned key in Chrome's shortcut settings. Drag a rectangle over the screenshot and release to start AI image recognition and translation automatically. **Read full capture** processes the whole image. The original lossless PNG is preserved. You can edit recognized Japanese and retranslate without image recognition.

Opening the toolbar icon just opens the panel. Chrome-protected pages may not support capture.

## Local model

Default endpoint: `http://127.0.0.1:11434/v1/chat/completions`.
Default model: `qwen2.5vl:7b`. Start your local server and install a vision model if using screenshots:

```sh
ollama pull qwen2.5vl:7b
```

Settings accepts localhost / `127.0.0.1` endpoints and an optional API key. Ollama's native `/api/chat` route is used if its OpenAI-compatible route returns 404. Clipboard translation is a text-only request; screenshot mode uses the model's image capability. Neither mode needs webpage content access. The extension retains `activeTab` for explicit screenshots, `tabs` for window/tab handling, `sidePanel`, `storage`, `clipboardRead`, and `offscreen`. Website scripting and optional website-access permissions were removed.

AI translations target Taiwan Traditional Chinese. Bundled OpenCC normalizes translation characters and regional wording without modifying Japanese or furigana. Follow-up replies are prompted to use Traditional Chinese while preserving Japanese examples. Accuracy and speed depend on the configured model.

## Verification

`node --test tests/regressions.cjs` covers clipboard routing without a source tab, repeated reads, empty/oversized input, temporary-field clearing, Traditional Chinese conversion, and screenshot regressions. Browser flow tests use mocked clipboard and model responses; actual OS clipboard permission and global shortcut registration need a live installed-extension check.
