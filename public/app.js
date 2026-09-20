const $ = (selector) => document.querySelector(selector);
const sparkleIcon = '<svg class="ui-icon" fill="currentColor" aria-hidden="true"><use href="#icon-sparkle"/></svg>';

const ui = {
  audio: $("#source-audio"),
  fileInput: $("#file-input"),
  sourceName: $("#source-name"),
  scan: $("#scan-button"),
  empty: $("#empty-stage"),
  stage: $("#study-stage"),
  library: $("#library-list"),
  pills: $("#clip-pills"),
  clipLabel: $("#clip-label"),
  clipTime: $("#clip-time"),
  progress: $("#progress-fill"),
  playhead: $("#playhead"),
  play: $("#play-clip"),
  playFull: $("#play-full"),
  back: $("#back-5"),
  forward: $("#forward-3"),
  backLabel: $("#back-label"),
  forwardLabel: $("#forward-label"),
  loop: $("#loop-button"),
  japaneseDisplay: $("#japanese-display"),
  selectionTooltip: $("#selection-tooltip"),
  tooltipExplainBtn: $("#tooltip-explain-btn"),
  translation: $("#translation-text"),
  literal: $("#literal-text"),
  translationArea: $("#translation-area"),
  translationToggle: $("#translation-toggle"),
  analyze: $("#analyze-button"),
  analysisState: $("#analysis-state"),
  previous: $("#previous-clip"),
  next: $("#next-clip"),
  record: $("#record-button"),
  guided: $("#guided-button"),
  cancelAutoRecord: $("#cancel-auto-record"),
  recordHint: $("#record-hint"),
  recordStatus: $("#record-status"),
  recordTimer: $("#record-timer"),
  recordingResult: $("#recording-result"),
  attemptAudio: $("#attempt-audio"),
  attemptPlay: $("#attempt-play"),
  attemptSeek: $("#attempt-seek"),
  attemptTime: $("#attempt-time"),
  grade: $("#grade-button"),
  feedback: $("#feedback"),
  feedbackStatus: $("#feedback-status"),
  sessionCount: $("#session-count"),
  chatContext: $("#chat-context"),
  chatMessages: $("#chat-messages"),
  chatForm: $("#chat-form"),
  chatInput: $("#chat-input"),
  buddyDialog: $("#buddy-dialog"),
  buddyOpen: $("#buddy-open"),
  buddyClose: $("#buddy-close"),
  aiStatus: $("#ai-status"),
  modelIndicator: $("#model-indicator"),
  modelBadge: $("#model-badge"),
  autoAnalyzeBar: $("#auto-analyze-bar"),
  autoAnalyzeText: $("#auto-analyze-text"),
  autoAnalyzePause: $("#auto-analyze-pause"),
  autoAnalyzeStop: $("#auto-analyze-stop"),
  settings: $("#settings"),
  settingsButton: $("#settings-button"),
  closeSettings: $("#close-settings"),
  uiDesign: $("#ui-design"),
  continuous: $("#continuous-button"),
  continuousCheckbox: $("#continuous-play"),
  sourceNameClassic: $("#source-name-classic"),
  scanClassic: $("#scan-button-classic"),
  libraryCountClassic: $("#library-count-classic"),
  emptyUploadClassic: $("#empty-upload-classic"),
  modelBadgeTopbar: $("#model-badge-topbar"),
  aiStatusTopbar: $("#ai-status-topbar"),
  modelIndicatorTopbar: $("#model-indicator-topbar"),
  lockScreen: $("#app-lock-screen"),
  lockForm: $("#lock-form"),
  lockInput: $("#lock-input"),
  lockTogglePwd: $("#lock-toggle-pwd"),
  lockError: $("#lock-error"),
  lockNowBtn: $("#lock-now-button"),
  passcodeSettingsInput: $("#lock-passcode-input"),
  savePasscodeBtn: $("#save-passcode-button"),
  jumpLength: $("#jump-length"),
  reflectionDelay: $("#reflection-delay"),
  autoRecord: $("#auto-record"),
  toast: $("#toast")
};

const stored = (key, fallback) => localStorage.getItem(key) ?? fallback;
const state = {
  aiConfigured: false,
  modelInfo: null,
  autoAnalyzing: false,
  autoAnalyzePaused: false,
  analyzingIndex: -1,
  source: null,
  audioBuffer: null,
  clips: [],
  active: 0,
  rate: 1,
  uiDesign: stored("kage-ui-design", "pop"),
  continuousPlay: stored("kage-continuous-play", "false") === "true",
  autoRecord: stored("kage-continuous-play", "false") === "true" ? false : stored("kage-auto-record", "true") === "true",
  loop: stored("kage-auto-record", "true") === "false" && stored("kage-loop", "false") === "true",
  showTranslation: false,
  jumpLength: Number(stored("kage-jump", "5")),
  attemptBlob: null,
  attemptUrl: null,
  attemptDuration: 0,
  recorder: null,
  playbackActive: false,
  recordPending: false,
  recordRequest: 0,
  countdownTimer: null,
  countdownInterval: null,
  recordStartedAt: 0,
  recordInterval: null,
  attempts: Number(stored("kage-attempts", "0")),
  loadedObjectUrl: null
};

function getCacheKey(sourceName) {
  if (!sourceName) return null;
  return `kage_cache_${encodeURIComponent(sourceName.trim().toLowerCase())}`;
}

let saveDiskTimer = null;
function saveClipCache() {
  if (!state.source?.name || !state.clips?.length) return;
  const key = getCacheKey(state.source.name);
  if (!key) return;
  const dataToSave = state.clips.map((clip) => ({
    start: clip.start,
    end: clip.end,
    japanese: clip.japanese || "",
    rubyText: clip.rubyText || "",
    translation: clip.translation || "",
    literal: clip.literal || "",
    analyzed: Boolean(clip.analyzed),
    scanned: Boolean(clip.scanned)
  }));
  try {
    localStorage.setItem(key, JSON.stringify(dataToSave));
  } catch (e) {
    console.warn("Could not cache clips locally:", e);
  }

  if (saveDiskTimer) clearTimeout(saveDiskTimer);
  saveDiskTimer = setTimeout(() => {
    fetch("/api/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: state.source.name, clips: dataToSave })
    }).catch((e) => console.warn("Could not save to disk:", e));
  }, 400);
}

function loadClipCache(sourceName) {
  const key = getCacheKey(sourceName);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch (e) {
    return null;
  }
}

function renderRubyHtml(text = "", rubyText = "") {
  const source = rubyText || text;
  if (!source) {
    return '<p class="japanese-placeholder">Analyze this clip to see the Japanese transcript and reading guides.</p>';
  }
  if (source.includes("<ruby") && source.includes("<rt>")) {
    return source.replace(/([|‖])/g, '<span class="pause-marker">$1</span>');
  }
  let html = escapeHtml(source);
  html = html.replace(/([一-龯々〆ヵヶ]+[ぁ-んァ-ヶー]*?)\[([ぁ-んァ-ヶー]+)\]/g, "<ruby>$1<rt>$2</rt></ruby>");
  html = html.replace(/([|‖])/g, '<span class="pause-marker">$1</span>');
  return html;
}

function seconds(value) {
  if (!Number.isFinite(value)) return "0:00";
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => ui.toast.classList.remove("show"), 3400);
}

function currentClip() {
  return state.clips[state.active];
}

function savePreferences() {
  localStorage.setItem("kage-ui-design", state.uiDesign);
  localStorage.setItem("kage-continuous-play", String(state.continuousPlay));
  localStorage.setItem("kage-loop", String(state.loop));
  localStorage.setItem("kage-auto-record", String(state.autoRecord));
  localStorage.setItem("kage-translation", String(state.showTranslation));
  localStorage.setItem("kage-jump", String(state.jumpLength));
  localStorage.setItem("kage-attempts", String(state.attempts));
}

function setUIDesign(design) {
  state.uiDesign = design === "classic" ? "classic" : "pop";
  document.documentElement.setAttribute("data-design", state.uiDesign);
  document.body.setAttribute("data-design", state.uiDesign);
  const themeLink = document.getElementById("theme-style");
  if (themeLink) {
    themeLink.href = state.uiDesign === "classic" ? "./styles-classic.css" : "./styles-pop.css";
  }
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = state.uiDesign === "classic" ? "#0b0d0d" : "#f6f4ec";
  const colorSchemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (colorSchemeMeta) colorSchemeMeta.content = state.uiDesign === "classic" ? "dark" : "light";
  if (ui.uiDesign) ui.uiDesign.value = state.uiDesign;
  if (state.uiDesign === "classic") {
    if (ui.buddyDialog && !ui.buddyDialog.hasAttribute("open")) ui.buddyDialog.setAttribute("open", "");
  } else {
    if (ui.buddyDialog && !ui.buddyDialog.matches(":modal")) ui.buddyDialog.removeAttribute("open");
  }
  savePreferences();
}

function setContinuousPlay(enabled) {
  cancelPendingRecording();
  state.continuousPlay = enabled;
  if (enabled) {
    state.autoRecord = false;
    state.loop = false;
  }
  renderPlaybackMode();
  savePreferences();
}

function updateJumpLabels() {
  const label = `${state.jumpLength}s`;
  ui.backLabel.textContent = label;
  ui.forwardLabel.textContent = label;
  ui.jumpLength.value = String(state.jumpLength);
}

function renderTranslationVisibility() {
  ui.translationArea.classList.toggle("hidden", !state.showTranslation);
  ui.translationToggle.classList.toggle("active", state.showTranslation);
  ui.translationToggle.setAttribute("aria-expanded", String(state.showTranslation));
  ui.translationToggle.setAttribute("title", state.showTranslation ? "Hide translation" : "Show translation");
}

function renderLibrary(files) {
  const countStr = String(files.length);
  const countPop = $("#library-count");
  if (countPop) countPop.textContent = countStr;
  const countClassic = $("#library-count-classic");
  if (countClassic) countClassic.textContent = countStr;

  if (!files.length) {
    ui.library.innerHTML = '<p class="library-empty">No compatible audio files found.</p>';
    return;
  }
  ui.library.innerHTML = files.map((file, index) => {
    const name = file.name.replace(/\.[^.]+$/, "");
    const episode = name.match(/S(\d+)E(\d+)/i);
    const title = episode ? name.split(/\s*-\s*S\d+E\d+/i)[0] : name;
    const number = episode ? episode[2] : String(index + 1).padStart(2, "0");
    const label = episode ? `S${episode[1]} / EPISODE ${episode[2]}` : `TRACK ${number}`;
    return `<button class="library-item" data-url="${escapeHtml(file.url)}" data-name="${escapeHtml(file.name)}" type="button" title="${escapeHtml(file.name)}" aria-label="Practice ${escapeHtml(name)}" aria-pressed="false">
      <b class="track-number classic-only">${escapeHtml(number)}</b>
      <span class="classic-only track-title">${escapeHtml(title)}</span>
      <span class="track-cover pop-only" aria-hidden="true"><span class="track-kicker"><span>SHADOWING SELECTS</span><span>${escapeHtml(number)}</span></span><span class="track-art"><span class="track-disc"><b>${escapeHtml(number)}</b></span></span><span class="track-cover-title">${escapeHtml(title)}</span><span class="track-select">↗</span></span>
      <span class="track-name pop-only">${escapeHtml(title)}</span><span class="track-meta pop-only">${escapeHtml(label)}</span>
    </button>`;
  }).join("");
}

function markActiveSource() {
  document.querySelectorAll(".library-item").forEach((item) => {
    const active = item.dataset.name === state.source?.name;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
    const sel = item.querySelector(".track-select");
    if (sel) sel.textContent = active ? "✓" : "↗";
  });
}

async function loadLibrary() {
  try {
    const response = await fetch("./api/library");
    if (response.ok) {
      const data = await response.json();
      if (data.files && data.files.length) {
        renderLibrary(data.files);
        return;
      }
    }
  } catch {}

  try {
    const fallback = await fetch("./data/library.json");
    if (fallback.ok) {
      const data = await fallback.json();
      if (data.files && data.files.length) {
        renderLibrary(data.files);
        return;
      }
    }
  } catch {}

  ui.library.innerHTML = '<p class="library-empty">The audio library could not be read.</p>';
}

function updateModelIndicator() {
  const info = state.modelInfo || {};
  const primary = info.primaryModel || "openai/gpt-oss-120b";
  const hasOpenAI = Boolean(info.hasOpenAI);
  const hasGroq = Boolean(info.hasGroq);

  const updateBadges = (badge, indicator) => {
    if (!badge) return;
    if (hasGroq) {
      badge.className = "model-badge groq";
      badge.textContent = "Groq";
      if (indicator) indicator.title = `Transcription: ${info.groqWhisper || "whisper-large-v3-turbo"} · Analysis: ${primary}`;
    } else if (hasOpenAI) {
      badge.className = "model-badge groq";
      badge.textContent = "OpenAI";
      if (indicator) indicator.title = `Audio Transcription: OpenAI Whisper (${info.openaiWhisper || "whisper-1"}) | Analysis: ${primary}`;
    } else {
      badge.className = "model-badge";
      badge.textContent = primary;
      if (indicator) indicator.title = `Active Model: ${primary}`;
    }
  };

  updateBadges(ui.modelBadge, ui.modelIndicator);
  updateBadges(ui.modelBadgeTopbar, ui.modelIndicatorTopbar);
}

async function loadStatus() {
  try {
    const response = await fetch("./api/status");
    if (!response.ok) throw new Error("Status API unavailable");
    const data = await response.json();
    state.aiConfigured = data.aiConfigured;
    state.modelInfo = data;
    [ui.aiStatus, ui.aiStatusTopbar].forEach((el) => {
      if (!el) return;
      el.classList.remove("offline", "ready");
      el.classList.add(data.aiConfigured ? "ready" : "offline");
      el.innerHTML = `<i></i> ${data.aiConfigured ? "AI ready" : "Local-only"}`;
    });
    [ui.modelIndicator, ui.modelIndicatorTopbar].forEach((el) => el?.classList.toggle("ready", Boolean(data.aiConfigured)));
    updateModelIndicator();
  } catch {
    [ui.aiStatus, ui.aiStatusTopbar].forEach((el) => {
      if (!el) return;
      el.classList.add("offline");
      el.innerHTML = "<i></i> Local mode";
    });
    [ui.modelBadge, ui.modelBadgeTopbar].forEach((el) => {
      if (el) el.textContent = "Offline";
    });
  }
}

function resetLesson() {
  cancelPracticePlayback();
  state.clips = [];
  state.active = 0;
  state.audioBuffer = null;
  state.attemptBlob = null;
  ui.attemptAudio.pause();
  ui.attemptAudio.removeAttribute("src");
  ui.attemptAudio.load();
  state.attemptDuration = 0;
  if (state.attemptUrl) URL.revokeObjectURL(state.attemptUrl);
  state.attemptUrl = null;
  updateAttemptPlayer();
  ui.recordingResult.classList.add("hidden");
  ui.feedback.className = "feedback empty-feedback";
  renderEmptyFeedback();
  ui.empty.classList.remove("hidden");
  ui.stage.classList.add("hidden");
  ui.scan.disabled = false;
  if (ui.scanClassic) ui.scanClassic.disabled = false;
  $("#empty-title").innerHTML = 'Your track.<br><em>Your next take.</em>';
  $("#empty-description").textContent = "Your audio is on the turntable. Split it into short clips, then give the first line a go.";
  $("#empty-upload").innerHTML = 'Make practice clips <span aria-hidden="true">→</span>';
  $("#empty-upload").disabled = false;
  stopAutoAnalyze();
}

function setSource({ name, url, file = null }) {
  if (state.recorder?.state === "recording") return toast("Stop your recording before changing audio.");
  cancelPracticePlayback();
  if (state.loadedObjectUrl) URL.revokeObjectURL(state.loadedObjectUrl);
  state.loadedObjectUrl = file ? url : null;
  state.source = { name, url, file };
  ui.audio.pause();
  ui.audio.src = url;
  ui.audio.load();
  const sourceHtml = `<span class="source-icon" aria-hidden="true"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 10v4m4-7v10m4-13v16m4-13v10m4-7v4"/></svg></span><span class="source-filename" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
  ui.sourceName.className = "source-file";
  ui.sourceName.innerHTML = sourceHtml;
  if (ui.sourceNameClassic) {
    ui.sourceNameClassic.className = "source-file";
    ui.sourceNameClassic.innerHTML = sourceHtml;
  }
  markActiveSource();
  resetLesson();
  const studio = $("#studio");
  studio.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  studio.focus({ preventScroll: true });

  const cached = loadClipCache(name);
  if (cached && cached.length) {
    state.clips = cached;
    state.active = 0;
    ui.empty.classList.add("hidden");
    ui.stage.classList.remove("hidden");
    renderActiveClip();
    const readyCount = cached.filter((c) => c.analyzed).length;
    toast(`Loaded ${cached.length} clips (${readyCount} analyzed).`);
    updateAutoAnalyzeUI();
    saveClipCache();
    if (readyCount < cached.length) startAutoAnalyze();
  } else {
    const baseName = name.replace(/\.[^.]+$/, "");
    const applyClips = (clips, sourceMsg) => {
      if (state.source?.url !== url) return;
      state.clips = clips;
      state.active = 0;
      ui.empty.classList.add("hidden");
      ui.stage.classList.remove("hidden");
      renderActiveClip();
      saveClipCache();
      const readyCount = state.clips.filter((c) => c.analyzed).length;
      toast(`Loaded ${state.clips.length} clips ${sourceMsg} (${readyCount} ready).`);
      updateAutoAnalyzeUI();
      if (readyCount < state.clips.length) startAutoAnalyze();
    };

    fetch(`./api/transcript?file=${encodeURIComponent(name)}`)
      .then((r) => {
        if (!r.ok) throw new Error("API not available");
        return r.json();
      })
      .then((res) => {
        if (res.exists && res.data?.clips?.length) {
          applyClips(res.data.clips, "from server");
        } else {
          throw new Error("No transcript in API");
        }
      })
      .catch(() => {
        // Static transcript fallback for GitHub Pages / static hosting
        fetch(`./transcripts/${encodeURIComponent(baseName)}.json`)
          .then((r) => {
            if (!r.ok) throw new Error("Static transcript not found");
            return r.json();
          })
          .then((data) => {
            if (data && data.clips && data.clips.length) {
              applyClips(data.clips, "from transcripts");
            }
          })
          .catch(() => {});
      });
  }
}

async function getDecodedAudio() {
  if (state.audioBuffer) return state.audioBuffer;
  if (!state.source) throw new Error("Choose an audio file first.");
  const arrayBuffer = state.source.file
    ? await state.source.file.arrayBuffer()
    : await (await fetch(state.source.url)).arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Your browser does not support local audio analysis.");
  const context = new AudioContextClass();
  try {
    state.audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    return state.audioBuffer;
  } finally {
    context.close();
  }
}

function fallbackClips(duration) {
  const clips = [];
  const step = 6;
  for (let start = 0; start < duration; start += step) {
    clips.push({ start, end: Math.min(duration, start + step), japanese: "", translation: "", literal: "", grammar: [], vocabulary: [], scanned: true });
  }
  return clips;
}

function splitAtSoftBreaks(buffer, start, end) {
  // A pause is primary. This is only a safety net for music/noise that masks pauses.
  // It picks the quietest moment near a natural conversational-turn length instead of a fixed duration.
  const output = [];
  const channel = buffer.getChannelData(0);
  const rmsAt = (time) => {
    const first = Math.max(0, Math.floor(time * buffer.sampleRate));
    const last = Math.min(channel.length, first + Math.floor(buffer.sampleRate * .08));
    let sum = 0;
    for (let index = first; index < last; index += 3) sum += channel[index] * channel[index];
    return Math.sqrt(sum / Math.max(1, Math.ceil((last - first) / 3)));
  };
  let cursor = start;
  while (end - cursor > 7) {
    const earliest = cursor + 3.2;
    const latest = Math.min(end - 1.3, cursor + 6.5);
    let best = Math.min(cursor + 5, latest);
    let quietest = Infinity;
    for (let time = earliest; time <= latest; time += .1) {
      const level = rmsAt(time);
      if (level < quietest) { quietest = level; best = time; }
    }
    output.push([cursor, best]);
    cursor = best;
  }
  output.push([cursor, end]);
  return output;
}

function scanPauses(buffer) {
  const channel = buffer.getChannelData(0);
  const windowLength = Math.max(1, Math.floor(buffer.sampleRate * .075));
  const levels = [];
  let peak = 0;
  for (let start = 0; start < channel.length; start += windowLength) {
    const end = Math.min(channel.length, start + windowLength);
    let total = 0;
    for (let index = start; index < end; index += 4) total += channel[index] * channel[index];
    const rms = Math.sqrt(total / Math.max(1, Math.ceil((end - start) / 4)));
    levels.push(rms);
    peak = Math.max(peak, rms);
  }
  const threshold = Math.max(.009, peak * .105);
  const quietWindows = Math.ceil(.46 / .075);
  const regions = [];
  let startIndex = null;
  let quiet = 0;
  levels.forEach((level, index) => {
    if (level > threshold) {
      if (startIndex === null) startIndex = Math.max(0, index - 2);
      quiet = 0;
    } else if (startIndex !== null) {
      quiet += 1;
      if (quiet >= quietWindows) {
        const endIndex = Math.max(startIndex + 1, index - quietWindows + 2);
        regions.push([startIndex * .075, Math.min(buffer.duration, endIndex * .075 + .12)]);
        startIndex = null;
      }
    }
  });
  if (startIndex !== null) regions.push([startIndex * .075, buffer.duration]);

  const clean = regions
    .filter(([start, end]) => end - start >= 1.05)
    .flatMap(([start, end]) => end - start > 7 ? splitAtSoftBreaks(buffer, start, end) : [[start, end]])
    .map(([start, end]) => ({ start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, japanese: "", translation: "", literal: "", grammar: [], vocabulary: [], scanned: true }));
  return clean.length >= 2 ? clean : fallbackClips(buffer.duration);
}

async function createPracticeClips() {
  if (!state.source) return;
  if (state.clips && state.clips.length > 0) {
    ui.empty.classList.add("hidden");
    ui.stage.classList.remove("hidden");
    const unanalyzed = state.clips.some(c => !c.analyzed);
    if (unanalyzed && !state.autoAnalyzing) {
      toast("Resuming auto-analyzer in the background...");
      startAutoAnalyze();
    } else if (unanalyzed && state.autoAnalyzePaused) {
      toast("Resuming auto-analyzer...");
      pauseResumeAutoAnalyze();
    } else if (unanalyzed) {
      toast("Auto-analyzer is currently running.");
    } else {
      toast("All clips are analyzed and ready!");
    }
    return;
  }
  ui.scan.disabled = true;
  $("#empty-upload").disabled = true;
  ui.scan.textContent = "Scanning pauses…";
  try {
    const buffer = await getDecodedAudio();
    state.clips = scanPauses(buffer);
    state.active = 0;
    ui.empty.classList.add("hidden");
    ui.stage.classList.remove("hidden");
    renderActiveClip();
    saveClipCache();
    toast(`${state.clips.length} practice clips are ready.`);
    startAutoAnalyze();
  } catch (error) {
    const duration = Number.isFinite(ui.audio.duration) ? ui.audio.duration : 30;
    state.clips = fallbackClips(duration);
    ui.empty.classList.add("hidden");
    ui.stage.classList.remove("hidden");
    renderActiveClip();
    saveClipCache();
    toast("Pause detection was unavailable, so Kage created 6-second fallback clips instead.");
    startAutoAnalyze();
  } finally {
    ui.scan.disabled = false;
    $("#empty-upload").disabled = false;
    if (!state.clips || state.clips.length === 0) {
      ui.scan.innerHTML = 'Make practice clips <span aria-hidden="true">→</span>';
    }
  }
}

function renderPills() {
  ui.pills.innerHTML = state.clips.map((clip, index) => {
    const isActive = index === state.active;
    const isAnalyzing = state.autoAnalyzing && state.analyzingIndex === index;
    const isAnalyzed = clip.analyzed;
    const isFailed = clip.failed && !isAnalyzed;
    const classes = [
      "clip-pill",
      isActive ? "active" : "",
      isAnalyzed ? "analyzed" : "",
      isAnalyzing ? "analyzing" : "",
      isFailed ? "failed" : "",
      clip.mastered ? "mastered" : ""
    ].filter(Boolean).join(" ");
    let icon = "";
    if (clip.mastered) icon = '<span class="pill-check" style="font-size: 1.1em; line-height: 1;">🏆</span>';
    else if (isAnalyzed) icon = '<span class="pill-check">✓</span>';
    else if (isFailed) icon = '<span class="pill-check" style="color:var(--danger)">!</span>';
    return `<button class="${classes}" type="button" data-index="${index}" aria-label="Clip ${index + 1}${isAnalyzed ? ', analyzed' : ''}" ${isActive ? 'aria-current="true"' : ''}>${String(index + 1).padStart(2, "0")}${icon}</button>`;
  }).join("");
  const active = ui.pills.querySelector(".active");
  if (active) {
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < ui.pills.scrollLeft + 2) ui.pills.scrollLeft = Math.max(0, left - 2);
    else if (right > ui.pills.scrollLeft + ui.pills.clientWidth - 2) ui.pills.scrollLeft = right - ui.pills.clientWidth + 2;
  }
}

function renderAnalyzeButton(clip) {
  const label = clip.analyzed ? "Re-analyze clip" : (clip.failed ? "Retry analysis" : "Analyze this clip");
  ui.analyze.innerHTML = `${sparkleIcon} ${label}`;
}

function renderActiveClip(preventAudioInterrupt = false) {
  const clip = currentClip();
  if (!clip) return;
  
  renderPills();
  ui.clipLabel.textContent = `CLIP ${String(state.active + 1).padStart(2, "0")} / ${String(state.clips.length).padStart(2, "0")}`;
  ui.previous.disabled = state.active === 0;
  ui.next.disabled = state.active === state.clips.length - 1;
  ui.selectionTooltip.classList.add("hidden");
  ui.clipTime.textContent = `${seconds(clip.start)} — ${seconds(clip.end)}`;
  if (ui.japaneseDisplay) {
    ui.japaneseDisplay.innerHTML = renderRubyHtml(clip.japanese, clip.rubyText);
  }
  if (ui.translation) {
    ui.translation.textContent = clip.translation || "Traditional Chinese translation will appear here after analysis…";
    ui.translation.classList.toggle("empty", !clip.translation);
  }
  ui.literal.textContent = clip.literal ? `Literal: ${clip.literal}` : "";
  ui.analysisState.textContent = clip.analyzed ? "AI analyzed" : (state.autoAnalyzing && state.analyzingIndex === state.active ? "Analyzing…" : (clip.failed ? "Analysis failed" : "Local clip"));
  renderAnalyzeButton(clip);
  ui.chatContext.textContent = clip.japanese || `Clip ${state.active + 1}: add a transcript or analyze this short audio clip.`;
  
  if (!preventAudioInterrupt) {
    restartClip(false);
  }
}

function selectClip(index, autoPlay = false) {
  if (!state.clips.length) return;
  if (state.recorder?.state === "recording") return toast("Stop your recording before changing clips.");
  const nextIndex = Math.max(0, Math.min(state.clips.length - 1, index));
  if (nextIndex === state.active && !ui.stage.classList.contains("hidden")) {
    if (autoPlay) {
      restartClip(false);
      playCurrentClip();
    }
    return;
  }
  saveActiveEdits();
  state.active = nextIndex;
  renderActiveClip();
  if (autoPlay) {
    playCurrentClip();
  }
  if (state.autoAnalyzing && !state.autoAnalyzePaused && state.analyzingIndex === -1 && !state.clips[state.active]?.analyzed && !state.clips[state.active]?.failed) {
    if (autoAnalyzeTimer) {
      clearTimeout(autoAnalyzeTimer);
      autoAnalyzeTimer = null;
    }
    runAutoAnalyzeQueue();
  }
}

function playCurrentClip() {
  const clip = currentClip();
  if (!clip) return;
  if (state.recorder?.state === "recording") return toast("Stop your recording before playing the original.");
  cancelPendingRecording();
  setSectionExpanded('deck-body', true);
  ui.audio.currentTime = clip.start;
  ui.audio.playbackRate = state.rate;
  beginClipPlayback();
  updateTransportProgress();
}

function saveActiveEdits() {
  const clip = currentClip();
  if (!clip) return;
  saveClipCache();
}

function updateTransportProgress() {
  const clip = currentClip();
  if (!clip) return;
  const range = Math.max(.01, clip.end - clip.start);
  const progress = Math.max(0, Math.min(1, (ui.audio.currentTime - clip.start) / range));
  const position = `${progress * 100}%`;
  ui.progress.style.width = position;
  ui.playhead.style.left = position;
  $(".timeline").setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  $(".timeline").setAttribute("aria-valuetext", `${seconds(Math.max(0, ui.audio.currentTime - clip.start))} of ${seconds(range)}`);
}

function cancelPendingRecording() {
  clearTimeout(state.countdownTimer);
  clearInterval(state.countdownInterval);
  state.countdownTimer = null;
  state.countdownInterval = null;
  state.recordRequest += 1;
  state.recordPending = false;
  ui.record.disabled = false;
  ui.cancelAutoRecord.classList.add("hidden");
  if (state.recorder?.state !== "recording") ui.recordStatus.textContent = "READY";
  renderPlaybackMode();
}

function cancelPracticePlayback() {
  state.playbackActive = false;
  state.playFullTrack = false;
  if (ui.playFull) ui.playFull.textContent = "▶ ALL";
  ui.audio.pause();
  cancelPendingRecording();
}

function renderPlaybackMode() {
  if (ui.continuous) ui.continuous.setAttribute("aria-checked", String(state.continuousPlay));
  if (ui.continuousCheckbox) ui.continuousCheckbox.checked = state.continuousPlay;

  if (state.continuousPlay) {
    ui.guided.disabled = true;
    ui.guided.setAttribute("aria-disabled", "true");
    ui.guided.setAttribute("aria-checked", "false");
    ui.guided.classList.add("is-disabled");
    ui.autoRecord.checked = false;
    ui.autoRecord.disabled = true;
    ui.loop.classList.remove("active");
    ui.loop.setAttribute("aria-pressed", "false");
    ui.recordHint.textContent = "Continuous play active: clips will auto-advance.";
  } else {
    ui.guided.disabled = false;
    ui.guided.removeAttribute("aria-disabled");
    ui.guided.classList.remove("is-disabled");
    ui.guided.setAttribute("aria-checked", String(state.autoRecord));
    ui.autoRecord.checked = state.autoRecord;
    ui.autoRecord.disabled = false;
    ui.loop.classList.toggle("active", state.loop);
    ui.loop.setAttribute("aria-pressed", String(state.loop));
    ui.recordHint.textContent = state.autoRecord ? "Recording starts after the clip." : (state.loop ? "Listen on repeat. Record when ready." : "Match the voice. Keep the rhythm.");
  }
}

function setAutoRecord(enabled) {
  if (state.continuousPlay) {
    toast("Turn off 'Keep playing clips' to enable Listen → speak.");
    return;
  }
  cancelPendingRecording();
  state.autoRecord = enabled;
  if (enabled) state.loop = false;
  renderPlaybackMode();
  savePreferences();
}

let playbackLoopId;
function monitorPlayback() {
  if (!state.playbackActive) return;
  const clip = currentClip();
  if (clip && (!ui.audio.paused || ui.audio.ended) && ui.audio.currentTime >= clip.end - 0.025) {
    finishClipPlayback();
    return;
  }
  updateTransportProgress();
  playbackLoopId = requestAnimationFrame(monitorPlayback);
}

function beginClipPlayback() {
  state.playbackActive = true;
  ui.recordStatus.textContent = "LISTENING";
  cancelAnimationFrame(playbackLoopId);
  playbackLoopId = requestAnimationFrame(monitorPlayback);
  ui.audio.play().catch(() => {
    cancelPracticePlayback();
    toast("The audio could not start. Try selecting the source again.");
  });
}

function scheduleRecording() {
  cancelPendingRecording();
  const clip = currentClip();
  const source = state.source;
  const delay = Math.max(0, Number(ui.reflectionDelay.value) || 0);
  if (!delay) return startRecording();
  const deadline = Date.now() + delay;
  const updateCountdown = () => {
    const remaining = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    ui.recordStatus.textContent = `SPEAK IN ${remaining}s`;
    ui.recordHint.textContent = `Your microphone starts in ${remaining} seconds…`;
  };
  updateCountdown();
  ui.cancelAutoRecord.classList.remove("hidden");
  state.countdownInterval = setInterval(updateCountdown, 250);
  state.countdownTimer = setTimeout(() => {
    cancelPendingRecording();
    if (state.autoRecord && currentClip() === clip && state.source === source) startRecording();
  }, delay);
}

function finishClipPlayback() {
  const clip = currentClip();
  if (!clip || !state.playbackActive) return;
  state.playbackActive = false;
  ui.audio.pause();
  ui.audio.currentTime = clip.end;
  updateTransportProgress();

  if (state.continuousPlay) {
    if (state.active < state.clips.length - 1) {
      selectClip(state.active + 1, true);
    } else {
      ui.recordStatus.textContent = "FINISHED";
      toast("Finished all clips in this track.");
    }
  } else if (state.autoRecord) {
    scheduleRecording();
  } else if (state.loop) {
    playCurrentClip();
  } else {
    ui.recordStatus.textContent = "READY";
  }
}

function restartClip(announce = true) {
  const clip = currentClip();
  if (!clip) return;
  cancelPracticePlayback();
  ui.audio.currentTime = clip.start;
  ui.play.textContent = "▶";
  updateTransportProgress();
  if (announce) toast("Restarted this sentence.");
}

function togglePlay() {
  const clip = currentClip();
  if (!clip) return toast("Make practice clips first.");
  if (state.recorder?.state === "recording") return toast("Stop your recording before playing the original.");
  if (ui.audio.paused) {
    cancelPendingRecording();
    setSectionExpanded('deck-body', true);
    if (ui.audio.currentTime < clip.start || ui.audio.currentTime >= clip.end) ui.audio.currentTime = clip.start;
    ui.audio.playbackRate = state.rate;
    beginClipPlayback();
  } else {
    cancelPracticePlayback();
  }
}

function toggleFullPlayback() {
  if (!state.source) return toast("Load an audio track first.");
  if (state.recorder?.state === "recording") return toast("Stop your recording first.");
  
  if (state.playFullTrack && !ui.audio.paused) {
    state.playFullTrack = false;
    cancelPracticePlayback();
    ui.playFull.textContent = "▶ ALL";
    return;
  }
  
  cancelPendingRecording();
  state.playFullTrack = true;
  state.playbackActive = false; // Disable clip bounds checking
  ui.audio.playbackRate = state.rate;
  ui.playFull.textContent = "⏸ ALL";
  
  cancelAnimationFrame(playbackLoopId);
  function monitorFullPlayback() {
    if (!state.playFullTrack) return;
    if (ui.audio.ended || ui.audio.paused) {
      state.playFullTrack = false;
      ui.playFull.textContent = "▶ ALL";
      return;
    }
    
    const time = ui.audio.currentTime;
    const currentIdx = state.clips.findIndex(c => time >= c.start && time < c.end);
    if (currentIdx !== -1 && currentIdx !== state.active) {
      state.active = currentIdx;
      renderActiveClip(true);
    }
    
    updateTransportProgress();
    playbackLoopId = requestAnimationFrame(monitorFullPlayback);
  }
  
  ui.audio.play().then(() => {
    playbackLoopId = requestAnimationFrame(monitorFullPlayback);
  }).catch(() => {
    state.playFullTrack = false;
    ui.playFull.textContent = "▶ ALL";
    toast("The audio could not start.");
  });
}

function seekBy(amount) {
  if (!state.source) return;
  cancelPendingRecording();
  const clip = currentClip();
  if (clip) {
    if (amount < 0) {
      // Seeking backward: clamp to beginning of current clip (never spill into previous clip)
      const current = Math.min(clip.end, ui.audio.currentTime);
      ui.audio.currentTime = Math.max(clip.start, current + amount);
    } else {
      // Seeking forward: clamp to end of current clip (never spill into next clip)
      const current = Math.max(clip.start, ui.audio.currentTime);
      ui.audio.currentTime = Math.min(clip.end, current + amount);
    }
  } else {
    const duration = Number.isFinite(ui.audio.duration) ? ui.audio.duration : 0;
    ui.audio.currentTime = Math.max(0, Math.min(duration || Infinity, ui.audio.currentTime + amount));
  }
  updateTransportProgress();
}

function setRate(rate) {
  state.rate = rate;
  ui.audio.playbackRate = rate;
  document.querySelectorAll("[data-rate]").forEach((button) => {
    const active = Number(button.dataset.rate) === rate;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function encodeClipWav(buffer, start, end, outputRate = 16000) {
  const duration = Math.max(.1, end - start);
  const sampleCount = Math.ceil(duration * outputRate);
  const raw = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(raw);
  const writeString = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  writeString(0, "RIFF"); view.setUint32(4, 36 + sampleCount * 2, true); writeString(8, "WAVE");
  writeString(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, outputRate, true); view.setUint32(28, outputRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(36, "data"); view.setUint32(40, sampleCount * 2, true);
  const channelCount = buffer.numberOfChannels;
  for (let index = 0; index < sampleCount; index += 1) {
    const sourceIndex = Math.min(buffer.length - 1, Math.floor((start + index / outputRate) * buffer.sampleRate));
    let sample = 0;
    for (let channel = 0; channel < channelCount; channel += 1) sample += buffer.getChannelData(channel)[sourceIndex] || 0;
    sample = Math.max(-1, Math.min(1, sample / channelCount));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([raw], { type: "audio/wav" });
}

async function transcribe(blob, filename = "clip.wav") {
  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", "whisper-1");
  form.append("language", "ja");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const response = await fetch("/api/transcribe", { method: "POST", body: form });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Transcription failed.");
  return result;
}

let autoAnalyzeTimer = null;

async function analyzeSingleClip(index) {
  const clip = state.clips[index];
  if (!clip) return;
  const isCurrent = index === state.active;

  if (isCurrent) {
    ui.analyze.disabled = true;
    ui.analyze.textContent = "Transcribing…";
    ui.analysisState.textContent = "Analyzing…";
  }

  try {
    const buffer = await getDecodedAudio();
    const wav = encodeClipWav(buffer, clip.start, clip.end);
    const transcript = await transcribe(wav);
    clip.japanese = (transcript.text || "").trim();
    clip.words = transcript.words || [];

    if (index === state.active) {
      ui.japaneseDisplay.innerHTML = renderRubyHtml(clip.japanese);
      ui.chatContext.textContent = clip.japanese || `Clip ${state.active + 1}`;
    }

    if (!clip.japanese) {
      clip.rubyText = "";
      clip.translation = "";
      clip.literal = "";
      clip.grammar = [];
      clip.vocabulary = [];
      clip.analyzed = true;
      clip.failed = false;
      clip.retryCount = 0;
      saveClipCache();
    } else {
      if (index === state.active) {
        ui.analyze.textContent = "Writing notes…";
      }
      const before = state.clips[index - 1]?.japanese || "";
      const after = state.clips[index + 1]?.japanese || "";
      try {
        const response = await fetch("/api/explain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sentence: clip.japanese,
            context: [before, after].filter(Boolean).join(" / ")
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "The explanation failed.");
        const analysis = result.analysis || {};
        clip.rubyText = analysis.rubyText || "";
        clip.translation = analysis.translation || "";
        clip.literal = analysis.literal || "";
      } catch (explainError) {
        console.warn(`[analyzeSingleClip] Explanation failed for clip ${index + 1}:`, explainError);
        clip.rubyText = clip.rubyText || clip.japanese;
      }
      clip.analyzed = true;
      clip.failed = false;
      clip.retryCount = 0;
      saveClipCache();
    }

    if (index === state.active) {
      renderActiveClip();
    } else {
      renderPills();
    }
  } finally {
    if (index === state.active) {
      ui.analyze.disabled = false;
      renderAnalyzeButton(clip);
      ui.analysisState.textContent = clip.analyzed ? "AI analyzed" : (clip.failed ? "Analysis failed" : "Local clip");
    }
  }
}

async function analyzeCurrentClip() {
  if (!state.aiConfigured) return toast("Add OPENAI_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY to .env, then restart the local server to analyze clips.");
  const clip = currentClip();
  if (!clip) return;
  if (state.autoAnalyzing && state.analyzingIndex === state.active) {
    return toast("This clip is currently being analyzed.");
  }
  clip.failed = false;
  clip.retryCount = 0;
  try {
    await analyzeSingleClip(state.active);
    toast("Your transcript, reading guides, and translation are ready.");
  } catch (error) {
    clip.failed = true;
    renderActiveClip();
    toast(error.message || "This clip could not be analyzed.");
  }
}

function updateAutoAnalyzeUI() {
  if (!ui.autoAnalyzeBar || !state.clips.length) {
    ui.autoAnalyzeBar?.classList.add("hidden");
    return;
  }
  const total = state.clips.length;
  const ready = state.clips.filter((c) => c.analyzed).length;
  const failed = state.clips.filter((c) => c.failed).length;

  if (ui.scan) {
    let btnText = 'Practice clips ready <span aria-hidden="true">✓</span>';
    if (ready < total) {
      btnText = state.autoAnalyzing 
        ? (state.autoAnalyzePaused ? 'Auto-analyze paused ⏸' : 'Analyzing transcripts... ⏳')
        : 'Resume auto-analyze <span aria-hidden="true">→</span>';
    }
    ui.scan.innerHTML = btnText;
    if (ui.scanClassic) ui.scanClassic.innerHTML = btnText;
  }

  if (state.autoAnalyzing) {
    ui.autoAnalyzeBar.classList.remove("hidden");
    if (ui.autoAnalyzePause) {
      ui.autoAnalyzePause.textContent = state.autoAnalyzePaused ? "Resume" : "Pause";
      ui.autoAnalyzePause.classList.remove("hidden");
    }
    if (ui.autoAnalyzeStop) ui.autoAnalyzeStop.textContent = "Stop";
    if (ui.autoAnalyzeText) {
      if (state.autoAnalyzePaused) {
        ui.autoAnalyzeText.textContent = `⏸ Auto-analysis paused (${ready} / ${total} ready${failed ? `, ${failed} failed` : ""})`;
      } else if (state.analyzingIndex >= 0) {
        ui.autoAnalyzeText.textContent = `Analyzing clip ${String(state.analyzingIndex + 1).padStart(2, "0")} (${ready} / ${total} ready${failed ? `, ${failed} failed` : ""})…`;
      } else {
        ui.autoAnalyzeText.textContent = `Analyzing clips: ${ready} / ${total} ready${failed ? `, ${failed} failed` : ""}…`;
      }
    }
  } else if (ready === total && total > 0) {
    ui.autoAnalyzeBar.classList.remove("hidden");
    if (ui.autoAnalyzeText) ui.autoAnalyzeText.textContent = `✓ All ${total} clips analyzed and ready!`;
    if (ui.autoAnalyzePause) ui.autoAnalyzePause.classList.add("hidden");
    if (ui.autoAnalyzeStop) ui.autoAnalyzeStop.textContent = "Dismiss";
  } else if (failed > 0 && ready + failed === total) {
    ui.autoAnalyzeBar.classList.remove("hidden");
    if (ui.autoAnalyzeText) ui.autoAnalyzeText.textContent = `Finished: ${ready} clips ready, ${failed} failed`;
    if (ui.autoAnalyzePause) {
      ui.autoAnalyzePause.textContent = "Retry Failed";
      ui.autoAnalyzePause.classList.remove("hidden");
    }
    if (ui.autoAnalyzeStop) ui.autoAnalyzeStop.textContent = "Dismiss";
  } else {
    ui.autoAnalyzeBar.classList.add("hidden");
    if (ui.autoAnalyzePause) ui.autoAnalyzePause.classList.remove("hidden");
    if (ui.autoAnalyzeStop) ui.autoAnalyzeStop.textContent = "Stop";
  }
}

function stopAutoAnalyze() {
  state.autoAnalyzing = false;
  state.autoAnalyzePaused = false;
  state.analyzingIndex = -1;
  if (autoAnalyzeTimer) {
    clearTimeout(autoAnalyzeTimer);
    autoAnalyzeTimer = null;
  }
  updateAutoAnalyzeUI();
  renderPills();
}

function pauseResumeAutoAnalyze() {
  const failedClips = state.clips.filter((c) => c.failed);
  if (!state.autoAnalyzing && failedClips.length > 0) {
    for (const clip of failedClips) {
      clip.failed = false;
      clip.retryCount = 0;
    }
    renderPills();
    startAutoAnalyze();
    return;
  }
  if (!state.autoAnalyzing) return;
  state.autoAnalyzePaused = !state.autoAnalyzePaused;
  updateAutoAnalyzeUI();
  if (!state.autoAnalyzePaused) {
    runAutoAnalyzeQueue();
  }
}

async function startAutoAnalyze() {
  if (!state.aiConfigured || !state.clips.length) return;
  if (state.autoAnalyzing) return;

  state.autoAnalyzing = true;
  state.autoAnalyzePaused = false;
  updateAutoAnalyzeUI();
  runAutoAnalyzeQueue();
}

async function runAutoAnalyzeQueue() {
  if (!state.autoAnalyzing || state.autoAnalyzePaused) return;

  // Prioritize active clip if unanalyzed and not failed, otherwise find next unanalyzed non-failed clip
  let targetIndex = -1;
  if (!state.clips[state.active]?.analyzed && !state.clips[state.active]?.failed) {
    targetIndex = state.active;
  } else {
    for (let i = 0; i < state.clips.length; i++) {
      const idx = (state.active + i) % state.clips.length;
      if (!state.clips[idx].analyzed && !state.clips[idx].failed) {
        targetIndex = idx;
        break;
      }
    }
  }

  if (targetIndex === -1) {
    const failedCount = state.clips.filter((c) => c.failed).length;
    const readyCount = state.clips.filter((c) => c.analyzed).length;
    state.autoAnalyzing = false;
    state.analyzingIndex = -1;
    updateAutoAnalyzeUI();
    renderPills();
    if (failedCount > 0) {
      toast(`Auto-analysis finished: ${readyCount} clips ready, ${failedCount} failed.`);
    } else {
      toast(`All ${state.clips.length} clips have been transcribed and analyzed!`);
    }
    return;
  }

  state.analyzingIndex = targetIndex;
  updateAutoAnalyzeUI();
  renderPills();

  try {
    await analyzeSingleClip(targetIndex);
  } catch (error) {
    console.error("Auto analyze error on clip", targetIndex, error);
    const msg = error?.message || "";
    const isRateLimit = msg.includes("high demand") || msg.includes("503") || msg.includes("429");
    if (isRateLimit) {
      if (ui.autoAnalyzeText) {
        ui.autoAnalyzeText.textContent = `⏳ High demand on AI service, retrying in 5s… (${state.clips.filter((c) => c.analyzed).length} / ${state.clips.length} ready)`;
      }
      autoAnalyzeTimer = setTimeout(() => {
        if (state.autoAnalyzing && !state.autoAnalyzePaused) {
          runAutoAnalyzeQueue();
        }
      }, 5000);
      return;
    }

    state.clips[targetIndex].retryCount = (state.clips[targetIndex].retryCount || 0) + 1;
    if (state.clips[targetIndex].retryCount >= 2) {
      state.clips[targetIndex].failed = true;
      console.warn(`Skipping clip ${targetIndex + 1} after 2 failed attempts: ${msg}`);
    }
  }

  state.analyzingIndex = -1;
  updateAutoAnalyzeUI();
  renderPills();

  if (state.autoAnalyzing && !state.autoAnalyzePaused) {
    autoAnalyzeTimer = setTimeout(runAutoAnalyzeQueue, 400);
  }
}

function setRecordState(recording) {
  $(".shadowing-deck").classList.toggle("is-recording", recording);
  ui.record.classList.toggle("recording", recording);
  ui.record.innerHTML = recording ? "<span></span> Stop & submit <kbd>T</kbd>" : "<span></span> Record attempt <kbd>R</kbd>";
  ui.record.setAttribute("aria-keyshortcuts", recording ? "t" : "r");
  ui.recordStatus.textContent = recording ? "🔴 RECORDING" : "READY";
  if (recording) {
    ui.recordHint.innerHTML = "<strong style='color: var(--primary)'>🎙️ Listening... Speak now.</strong>";
  }
  ui.recordStatus.classList.toggle("recording", recording);
}

function updateRecordTimer() {
  const elapsed = (Date.now() - state.recordStartedAt) / 1000;
  ui.recordTimer.textContent = seconds(elapsed);
}

function updateAttemptPlayer() {
  const duration = Number.isFinite(ui.attemptAudio.duration) && ui.attemptAudio.duration > 0
    ? ui.attemptAudio.duration : state.attemptDuration;
  const elapsed = Math.min(ui.attemptAudio.currentTime || 0, duration);
  const progress = duration > 0 ? Math.min(100, elapsed / duration * 100) : 0;
  const playing = !ui.attemptAudio.paused && !ui.attemptAudio.ended;
  ui.attemptPlay.disabled = !state.attemptUrl;
  ui.attemptPlay.textContent = playing ? "❚❚" : "▶";
  ui.attemptPlay.setAttribute("aria-label", playing ? "Pause your recording" : "Play your recording");
  ui.attemptSeek.disabled = !state.attemptUrl || duration <= 0;
  ui.attemptSeek.value = String(progress);
  ui.attemptSeek.style.setProperty("--progress", `${progress}%`);
  ui.attemptSeek.setAttribute("aria-valuetext", `${seconds(elapsed)} of ${seconds(duration)}`);
  ui.attemptTime.textContent = `${seconds(elapsed)} / ${seconds(duration)}`;
}

let vadContext = null;
let vadAnimationFrame = null;

function stopVAD() {
  if (vadAnimationFrame) cancelAnimationFrame(vadAnimationFrame);
  vadAnimationFrame = null;
  if (vadContext) {
    vadContext.close().catch(() => {});
    vadContext = null;
  }
}

function startVAD(stream, recorder) {
  stopVAD();
  try {
    vadContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = vadContext.createMediaStreamSource(stream);
    const analyser = vadContext.createAnalyser();
    analyser.minDecibels = -60;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0.85;
    analyser.fftSize = 256;
    source.connect(analyser);

    let hasSpoken = false;
    let silentSince = null;
    const threshold = -45; // dB
    const silenceDelay = 1500; // 1.5s of silence triggers submit

    const dataArray = new Float32Array(analyser.frequencyBinCount);

    const checkAudioLevel = () => {
      if (recorder.state !== "recording") {
        stopVAD();
        return;
      }
      analyser.getFloatFrequencyData(dataArray);
      let maxDb = -Infinity;
      for (let i = 0; i < dataArray.length; i++) {
        if (dataArray[i] > maxDb) maxDb = dataArray[i];
      }
      
      const speaking = maxDb > threshold;
      
      if (speaking) {
        hasSpoken = true;
        silentSince = null;
      } else if (hasSpoken) {
        if (!silentSince) {
          silentSince = Date.now();
        } else if (Date.now() - silentSince > silenceDelay) {
          submitRecording();
          stopVAD();
          return;
        }
      }
      vadAnimationFrame = requestAnimationFrame(checkAudioLevel);
    };
    checkAudioLevel();
  } catch (e) {
    console.warn("VAD failed to start", e);
  }
}

async function startRecording() {
  const clip = currentClip();
  if (!clip) return toast("Make practice clips first.");
  if (state.recordPending || state.recorder?.state === "recording") return;
  cancelPracticePlayback();
  setSectionExpanded('deck-body', true);
  const request = state.recordRequest;
  const source = state.source;
  state.recordPending = true;
  ui.record.disabled = true;
  ui.cancelAutoRecord.classList.remove("hidden");
  ui.recordStatus.textContent = "MIC ACCESS";
  let stream;
  try {
    ui.attemptAudio.pause();
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (request !== state.recordRequest || clip !== currentClip() || source !== state.source) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    recorder.addEventListener("stop", () => {
      stopVAD();
      state.attemptDuration = (Date.now() - state.recordStartedAt) / 1000;
      stream.getTracks().forEach((track) => track.stop());
      state.attemptBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (state.attemptUrl) URL.revokeObjectURL(state.attemptUrl);
      state.attemptUrl = URL.createObjectURL(state.attemptBlob);
      ui.attemptAudio.src = state.attemptUrl;
      updateAttemptPlayer();
      ui.recordingResult.classList.remove("hidden");
      clearInterval(state.recordInterval);
      state.attempts += 1;
      savePreferences();
      ui.sessionCount.textContent = String(state.attempts);
      setRecordState(false);
      toast("Attempt saved! Evaluating your speech immediately…");
      gradeAttempt();
    });
    state.recorder = recorder;
    state.recordStartedAt = Date.now();
    ui.recordTimer.textContent = "0:00";
    state.recordInterval = setInterval(updateRecordTimer, 250);
    recorder.start();
    startVAD(stream, recorder);
    setRecordState(true);
    toast("🎙️ Start recording...");
  } catch {
    stream?.getTracks().forEach((track) => track.stop());
    stopVAD();
    if (request === state.recordRequest) {
      setRecordState(false);
      toast("Microphone access is needed to record an attempt. Click Record attempt to try again.");
    }
  } finally {
    if (request === state.recordRequest) {
      state.recordPending = false;
      ui.record.disabled = false;
      ui.cancelAutoRecord.classList.add("hidden");
    }
  }
}

function submitRecording() {
  if (state.recorder?.state === "recording") {
    stopVAD();
    state.attemptDuration = (Date.now() - state.recordStartedAt) / 1000;
    state.recorder.stop();
  }
}

function toggleRecording() {
  if (state.recorder?.state === "recording") submitRecording();
  else startRecording();
}

function normaliseJapanese(text = "") {
  return text.normalize("NFKC").replace(/[\s　、。！？「」『』（）()…・ー－\-]/g, "");
}

function levenshtein(first, second) {
  const row = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 1; i <= first.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= second.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (first[i - 1] === second[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[second.length];
}

function renderEmptyFeedback() {
  ui.feedback.className = "feedback empty-feedback";
  ui.feedbackStatus.textContent = "Ready for your first take";
  ui.feedback.innerHTML = `<div class="feedback-placeholder-metrics" aria-hidden="true"><div><span>Pronunciation</span><strong>—</strong></div><div><span>Rhythm</span><strong>—</strong></div><div><span>Intonation</span><strong>—</strong></div></div>
    <div class="feedback-invitation"><span class="feedback-spark" aria-hidden="true">${sparkleIcon}</span><p><strong>Small adjustments. Noticeable progress.</strong>Record a take to get personalised feedback and a clear next step.</p></div>`;
}

function showAdvancedFeedback(evalData, heard, target) {
  ui.feedback.className = "feedback";
  ui.feedbackStatus.textContent = "Take reviewed";
  const scores = evalData.scores || {};
  const scoreValue = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
  const pron = scoreValue(scores.pronunciation);
  const rhythm = scoreValue(scores.rhythm);
  const into = scoreValue(scores.intonation);

  const clip = currentClip();
  if (clip) {
    clip.mastered = evalData.recommendation === "move_on";
    saveClipCache();
    renderPills();
  }

  const getScoreClass = (val) => val >= 85 ? "" : (val >= 70 ? "amber" : "red");

  const cues = evalData.visualCues || [];
  const cuesHtml = cues.length ? `
    <div class="visual-cues-card">
      <div class="cues-heading"><div class="cues-title">Word by word</div><div class="cue-legend"><span>● On track</span><span>● Practise</span><span>● Missed</span></div></div>
      <div class="cues-wrap">
        ${cues.map((cue) => {
          const status = ["perfect", "warning", "missed"].includes(cue.status) ? cue.status : "warning";
          const note = cue.note ? `<span class="cue-tag" lang="zh-Hant">${escapeHtml(cue.note)}</span>` : "";
          const furi = cue.furigana ? `<small>${escapeHtml(cue.furigana)}</small>` : "";
          return `<div class="cue-pill ${status}" title="${escapeHtml(cue.note || status)}">
            ${furi}
            <span class="cue-text" lang="ja">${escapeHtml(cue.text || "")}</span>
            ${note}
          </div>`;
        }).join("")}
      </div>
      <div class="cues-heard" style="margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid var(--border); font-size: 0.9rem; color: var(--text-muted);">
        <strong style="font-weight: 500;">You said:</strong> <span lang="ja" style="margin-left: 0.5rem; color: var(--text);">${escapeHtml(heard || "—")}</span>
      </div>
    </div>
  ` : "";

  const recommendationMap = {
    keep_practicing: "建議繼續練習",
    move_on: "練得不錯，可以前往下一句"
  };
  const recText = evalData.recommendation ? recommendationMap[evalData.recommendation] || evalData.recommendation : "";

  const bulletsHtml = `
    <div class="feedback-bullets">
      ${recText ? `<div class="feedback-bullet" lang="zh-Hant"><h3><span aria-hidden="true">🎯</span> 練習建議</h3><p>${escapeHtml(recText)}</p></div>` : ""}
      ${evalData.rhythmFeedback ? `<div class="feedback-bullet" lang="zh-Hant"><h3><span aria-hidden="true">↔</span> 節奏與語速</h3><p>${escapeHtml(evalData.rhythmFeedback)}</p></div>` : ""}
      ${evalData.intonationFeedback ? `<div class="feedback-bullet" lang="zh-Hant"><h3><span aria-hidden="true">↗</span> 語調與音高</h3><p>${escapeHtml(evalData.intonationFeedback)}</p></div>` : ""}
    </div>
  `;

  const scoreCard = (label, value) => `<div class="score-card">
    <span>${label}</span><strong class="${value === null ? 'unavailable' : getScoreClass(value)}">${value === null ? '—' : `${value}<small>/ 100</small>`}</strong>
    ${value === null ? '<span class="score-unavailable">Not assessed</span>' : `<div class="score-meter ${getScoreClass(value)}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i style="width:${value}%"></i></div>`}
  </div>`;

  ui.feedback.innerHTML = `
    <div class="feedback-grid-3">
      ${scoreCard('Pronunciation', pron)}
      ${scoreCard('Rhythm', rhythm)}
      ${scoreCard('Intonation', into)}
    </div>
    ${evalData.coachingTip ? `<div class="coaching-spotlight"><span class="coaching-icon" aria-hidden="true">${sparkleIcon}</span><div><p class="eyebrow">For your next take</p><p lang="zh-Hant">${escapeHtml(evalData.coachingTip)}</p></div></div>` : ""}
    ${cuesHtml}
    ${bulletsHtml}
  `;
}

function computeLocalFeedback(target, heard, targetDuration, recordedDuration) {
  const normTarget = normaliseJapanese(target);
  const normHeard = normaliseJapanese(heard);
  const distance = normTarget && normHeard ? levenshtein(normTarget, normHeard) : 0;
  const pronScore = normTarget && normHeard
    ? Math.max(0, Math.round((1 - distance / Math.max(normTarget.length, normHeard.length)) * 100))
    : 0;
  const durationDiff = recordedDuration - targetDuration;
  const timingScore = durationDiff < -0.5 
    ? Math.max(0, Math.round(100 - (Math.abs(durationDiff) / targetDuration) * 100))
    : (pronScore > 0 ? 85 : 0);

  const chars = Array.from(normTarget);
  const heardChars = Array.from(normHeard);
  const visualCues = chars.slice(0, 16).map((char, i) => {
    const isMatch = heardChars[i] === char;
    return {
      text: char,
      status: isMatch ? "perfect" : (heardChars.includes(char) ? "warning" : "missed"),
      note: isMatch ? "" : "留意這個音的發音"
    };
  });

  const speedRatio = (recordedDuration / targetDuration).toFixed(2);
  return {
    scores: { pronunciation: pronScore, rhythm: timingScore, intonation: null },
    recommendation: pronScore >= 80 && timingScore >= 80 ? "move_on" : "keep_practicing",
    visualCues,
    rhythmFeedback: durationDiff < -0.5 ? "語速有點太快，可以稍微放慢，讓每個音拍都清楚完整。" : "本機模式不評估整體長度，請專注於發音與語調即可。",
    intonationFeedback: "仔細聽每個語句結尾的音高起伏。目前的本機文字比對無法判斷實際音高，因此不提供語調分數。",
    coachingTip: "跟著原音的換氣點練習，特別留意長音與促音的完整長度，再錄一次比較看看。"
  };
}

async function gradeAttempt() {
  if (!state.attemptBlob) return;
  if (!state.aiConfigured) return toast("AI is not configured. Add an API key to .env.");
  const clip = currentClip();
  ui.grade.disabled = true;
  ui.grade.textContent = "Transcribing…";
  ui.feedbackStatus.textContent = "Reviewing your take…";
  ui.feedback.className = "feedback empty-feedback";
  ui.feedback.setAttribute("aria-busy", "true");
  ui.feedback.innerHTML = "<p>Listening to your recording and preparing feedback…</p>";
  try {
    const result = await transcribe(state.attemptBlob, "my-shadowing-attempt.webm");
    const heard = (result.text || "").trim();
    const targetDuration = Math.max(.1, clip.end - clip.start);
    const recordedDuration = Math.max(.1, Number.isFinite(ui.attemptAudio.duration) ? ui.attemptAudio.duration : state.attemptDuration || targetDuration);

    ui.grade.textContent = "Evaluating…";

    try {
      const evalRes = await fetch("/api/evaluate-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: clip.japanese || heard,
          heard,
          targetDuration: Math.round(targetDuration * 10) / 10,
          recordedDuration: Math.round(recordedDuration * 10) / 10
        })
      });
      if (evalRes.ok) {
        const { evaluation } = await evalRes.json();
        showAdvancedFeedback(evaluation, heard, clip.japanese);
        toast("Evaluation complete! Review your scores and visual cues below.");
        return;
      }
    } catch (evalErr) {
      console.warn("AI evaluation error, using local fallback:", evalErr);
    }

    const fallback = computeLocalFeedback(clip.japanese, heard, targetDuration, recordedDuration);
    showAdvancedFeedback(fallback, heard, clip.japanese);
    toast("Speech comparison complete.");
  } catch (error) {
    ui.feedback.className = "feedback empty-feedback";
    ui.feedbackStatus.textContent = "Please try again";
    ui.feedback.innerHTML = `<p>${escapeHtml(error.message || "This attempt could not be analyzed.")} Use Re-evaluate to try again.</p>`;
    toast(error.message || "This attempt could not be analyzed.");
  } finally {
    ui.feedback.setAttribute("aria-busy", "false");
    ui.grade.disabled = false;
    ui.grade.textContent = "Re-evaluate";
  }
}

function appendChat(message, role) {
  const element = document.createElement("div");
  element.className = `chat-message ${role}`;
  element.innerHTML = role === "tutor" ? `<span class="tutor-badge">${sparkleIcon}</span><p lang="zh-Hant">${escapeHtml(message)}</p>` : `<p>${escapeHtml(message)}</p>`;
  ui.chatMessages.append(element);
  ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

async function askChat(question) {
  const clip = currentClip();
  if (!clip) return toast("Choose a practice clip first.");
  if (!question.trim()) return;
  appendChat(question, "user");
  ui.chatInput.value = "";
  if (!state.aiConfigured) {
    appendChat("請在 .env 加入 GROQ_API_KEY，並重新啟動伺服器以啟用對話。", "tutor");
    return;
  }
  try {
    const grammar = (clip.grammar || []).map((item) => `${item.title}: ${item.detail}`).join("\n");
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sentence: clip.japanese || "(target transcript not available)",
        translation: clip.translation,
        grammar,
        question
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Chat failed.");
    appendChat(data.answer || "暫時無法回答這句，請再試一次。", "tutor");
  } catch (error) {
    appendChat(error.message || "I could not answer that just now.", "tutor");
  }
}

function isAppLocked() {
  return localStorage.getItem("kage-unlocked") !== "true";
}

function getStoredPasscode() {
  return localStorage.getItem("kage-access-passcode") || "shadowing";
}

function initLockScreen() {
  if (!ui.lockScreen) return;

  if (ui.passcodeSettingsInput) {
    ui.passcodeSettingsInput.value = getStoredPasscode();
  }

  const updateLockVisibility = () => {
    if (isAppLocked()) {
      ui.lockScreen.classList.remove("hidden");
      ui.lockScreen.classList.remove("fade-out");
      setTimeout(() => ui.lockInput?.focus(), 80);
    } else {
      ui.lockScreen.classList.add("hidden");
    }
  };

  updateLockVisibility();

  ui.lockForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const entered = (ui.lockInput.value || "").trim();
    if (entered === getStoredPasscode()) {
      localStorage.setItem("kage-unlocked", "true");
      ui.lockError.classList.add("hidden");
      ui.lockScreen.classList.add("fade-out");
      setTimeout(() => {
        ui.lockScreen.classList.add("hidden");
        ui.lockScreen.classList.remove("fade-out");
      }, 250);
      toast("Access granted! Welcome to Shadowing.");
    } else {
      ui.lockError.classList.remove("hidden");
      ui.lockInput.classList.add("shake");
      setTimeout(() => ui.lockInput.classList.remove("shake"), 450);
      ui.lockInput.select();
    }
  });

  ui.lockTogglePwd?.addEventListener("click", () => {
    const isPwd = ui.lockInput.type === "password";
    ui.lockInput.type = isPwd ? "text" : "password";
    ui.lockTogglePwd.innerHTML = isPwd 
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>` 
      : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
  });

  ui.lockNowBtn?.addEventListener("click", () => {
    localStorage.removeItem("kage-unlocked");
    ui.settings.classList.add("hidden");
    if (ui.lockInput) ui.lockInput.value = "";
    if (ui.lockError) ui.lockError.classList.add("hidden");
    updateLockVisibility();
    toast("App locked.");
  });

  ui.savePasscodeBtn?.addEventListener("click", () => {
    const newCode = (ui.passcodeSettingsInput.value || "").trim();
    if (!newCode) {
      toast("Passcode cannot be empty.");
      return;
    }
    localStorage.setItem("kage-access-passcode", newCode);
    toast("Access passcode updated!");
  });
}

function handleKeys(event) {
  if (isAppLocked()) return;
  if (ui.buddyDialog && ui.buddyDialog.matches(":modal") && ui.buddyDialog.open) return;
  const typing = event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
  if (typing || event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (!state.clips.length) return;
  const key = event.key.toLowerCase();
  if (key === " ") { event.preventDefault(); togglePlay(); return; }
  if (key === "r") { event.preventDefault(); startRecording(); return; }
  if (key === "t") { event.preventDefault(); submitRecording(); return; }
  if (event.target.closest("button, audio, summary, [role=slider]")) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); seekBy(-state.jumpLength); }
  else if (event.key === "ArrowRight") { event.preventDefault(); seekBy(state.jumpLength); }
  else if (event.key === "ArrowUp") { event.preventDefault(); selectClip(state.active - 1, true); }
  else if (event.key === "ArrowDown") { event.preventDefault(); selectClip(state.active + 1, true); }
  else if (key === "1") { event.preventDefault(); askChat("這句有口語省略嗎？是否有特殊的日本慣用語或敬語用法？"); }
  else if (key === "2") { event.preventDefault(); askChat("請解釋這句中 particles (助詞) 的用法"); }
  else if (key === "3") { event.preventDefault(); askChat("請列出這句中的動詞變化形"); }
}

$("#empty-upload")?.addEventListener("click", () => state.source ? createPracticeClips() : ui.fileInput.click());
ui.emptyUploadClassic?.addEventListener("click", () => state.source ? createPracticeClips() : ui.fileInput.click());
$("#shelf-back")?.addEventListener("click", () => scrollShelf(-1));
$("#shelf-next")?.addEventListener("click", () => scrollShelf(1));
function scrollShelf(direction) {
  ui.library.scrollBy({ left: direction * ui.library.clientWidth * .8, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}

function openBuddy() {
  setSectionExpanded("chat-body", true);
  if (state.uiDesign === "classic") {
    ui.buddyDialog?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else {
    if (!ui.buddyDialog.open) ui.buddyDialog.showModal();
  }
  ui.chatInput.focus();
}
ui.buddyOpen?.addEventListener("click", openBuddy);
ui.buddyClose?.addEventListener("click", () => ui.buddyDialog.close());
ui.buddyDialog?.addEventListener("click", (event) => {
  if (state.uiDesign === "classic") return;
  const bounds = ui.buddyDialog.getBoundingClientRect();
  if (event.target === ui.buddyDialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) ui.buddyDialog.close();
});
ui.fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (!file) return;
  setSource({ name: file.name, url: URL.createObjectURL(file), file });
});
ui.library.addEventListener("click", (event) => {
  const item = event.target.closest(".library-item");
  if (item) setSource({ name: item.dataset.name, url: item.dataset.url });
});
ui.scan.addEventListener("click", createPracticeClips);
ui.scanClassic?.addEventListener("click", createPracticeClips);
ui.pills.addEventListener("click", (event) => { const button = event.target.closest("[data-index]"); if (button) selectClip(Number(button.dataset.index)); });
ui.previous.addEventListener("click", () => selectClip(state.active - 1, true));
ui.next.addEventListener("click", () => selectClip(state.active + 1, true));
ui.play.addEventListener("click", togglePlay);
ui.playFull.addEventListener("click", toggleFullPlayback);
ui.back.addEventListener("click", () => seekBy(-state.jumpLength));
ui.forward.addEventListener("click", () => seekBy(state.jumpLength));
ui.loop.addEventListener("click", () => {
  cancelPendingRecording();
  state.loop = !state.loop;
  if (state.loop) {
    state.autoRecord = false;
    state.continuousPlay = false;
  }
  renderPlaybackMode();
  savePreferences();
});
document.querySelectorAll("[data-rate]").forEach((button) => button.addEventListener("click", () => setRate(Number(button.dataset.rate))));
$(".timeline").addEventListener("click", (event) => {
  const clip = currentClip();
  if (!clip) return;
  cancelPendingRecording();
  const bounds = event.currentTarget.getBoundingClientRect();
  const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  ui.audio.currentTime = clip.start + (clip.end - clip.start) * progress;
  updateTransportProgress();
});
$(".timeline").addEventListener("keydown", (event) => {
  const clip = currentClip();
  if (!clip) return;
  if (["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)) cancelPendingRecording();
  if (["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "Home", "End"].includes(event.key)) event.preventDefault();
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") seekBy(-1);
  else if (event.key === "ArrowRight" || event.key === "ArrowUp") seekBy(1);
  else if (event.key === "Home") ui.audio.currentTime = clip.start;
  else if (event.key === "End") ui.audio.currentTime = clip.end;
  updateTransportProgress();
});
ui.translationToggle.addEventListener("click", () => { state.showTranslation = !state.showTranslation; savePreferences(); renderTranslationVisibility(); });
ui.analyze.addEventListener("click", analyzeCurrentClip);
ui.autoAnalyzePause?.addEventListener("click", pauseResumeAutoAnalyze);
ui.autoAnalyzeStop?.addEventListener("click", () => {
  stopAutoAnalyze();
  ui.autoAnalyzeBar.classList.add("hidden");
});
ui.record.addEventListener("click", toggleRecording);
ui.guided.addEventListener("click", () => setAutoRecord(!state.autoRecord));
ui.continuous?.addEventListener("click", () => setContinuousPlay(!state.continuousPlay));
ui.continuousCheckbox?.addEventListener("change", () => setContinuousPlay(ui.continuousCheckbox.checked));
ui.uiDesign?.addEventListener("change", () => setUIDesign(ui.uiDesign.value));
ui.cancelAutoRecord.addEventListener("click", cancelPendingRecording);
ui.grade.addEventListener("click", gradeAttempt);
ui.attemptPlay.addEventListener("click", () => {
  if (!ui.attemptAudio.paused) return ui.attemptAudio.pause();
  cancelPracticePlayback();
  if (ui.attemptAudio.ended) ui.attemptAudio.currentTime = 0;
  ui.attemptAudio.play().catch(() => toast("Your recording could not be played. Try recording again."));
});
ui.attemptSeek.addEventListener("input", () => {
  const duration = Number.isFinite(ui.attemptAudio.duration) && ui.attemptAudio.duration > 0
    ? ui.attemptAudio.duration : state.attemptDuration;
  ui.attemptAudio.currentTime = duration * Number(ui.attemptSeek.value) / 100;
  updateAttemptPlayer();
});
["loadedmetadata", "durationchange", "timeupdate", "play", "pause", "ended"].forEach((event) => {
  ui.attemptAudio.addEventListener(event, updateAttemptPlayer);
});
ui.chatForm.addEventListener("submit", (event) => { event.preventDefault(); askChat(ui.chatInput.value); });
document.querySelectorAll("[data-question]").forEach((button) => button.addEventListener("click", () => askChat(button.dataset.question)));
function setSectionExpanded(id, expanded) {
  const target = document.getElementById(id);
  const button = document.querySelector(`[data-collapse="${id}"]`);
  if (!target || !button) return;
  target.classList.toggle("hidden", !expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${button.dataset.sectionLabel}`);
  target.closest(".panel, .shadowing-deck")?.classList.toggle("is-collapsed", !expanded);
  localStorage.setItem(`kage-collapse-${id}`, String(!expanded));
}

document.querySelectorAll("[data-collapse]").forEach((button) => {
  setSectionExpanded(button.dataset.collapse, stored(`kage-collapse-${button.dataset.collapse}`, "false") !== "true");
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") !== "true";
    if (button.dataset.collapse === "deck-body" && !expanded) {
      cancelPracticePlayback();
      if (state.recorder?.state === "recording") toggleRecording();
    }
    if (button.dataset.collapse === "sentence-body" && !expanded) ui.selectionTooltip.classList.add("hidden");
    setSectionExpanded(button.dataset.collapse, expanded);
  });
});
ui.settingsButton.addEventListener("click", () => ui.settings.classList.toggle("hidden"));
ui.closeSettings.addEventListener("click", () => ui.settings.classList.add("hidden"));
ui.jumpLength.addEventListener("change", () => { state.jumpLength = Number(ui.jumpLength.value); savePreferences(); updateJumpLabels(); });
ui.reflectionDelay.addEventListener("change", () => localStorage.setItem("kage-reflection-delay", ui.reflectionDelay.value));
ui.autoRecord.addEventListener("change", () => setAutoRecord(ui.autoRecord.checked));
document.addEventListener("keydown", handleKeys);

function initSelectionTooltip() {
  let selectedText = "";
  const handleSelection = () => {
    if (ui.selectionTooltip.contains(document.activeElement)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      selectedText = "";
      ui.selectionTooltip?.classList.add("hidden");
      return;
    }

    if (!ui.japaneseDisplay.contains(selection.anchorNode) || !ui.japaneseDisplay.contains(selection.focusNode)) {
      selectedText = "";
      ui.selectionTooltip?.classList.add("hidden");
      return;
    }

    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    fragment.querySelectorAll("rt, rp, .pause-marker").forEach((node) => node.remove());
    selectedText = fragment.textContent.trim();
    const rect = range.getBoundingClientRect();
    if (!selectedText || (rect.width === 0 && rect.height === 0) || rect.bottom < 64 || rect.top > window.innerHeight) {
      ui.selectionTooltip?.classList.add("hidden");
      return;
    }

    if (ui.selectionTooltip) {
      ui.selectionTooltip.classList.remove("hidden");
      const width = ui.selectionTooltip.offsetWidth;
      const height = ui.selectionTooltip.offsetHeight;
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
      const top = rect.top >= height + 76 ? rect.top - height - 10 : Math.min(window.innerHeight - height - 12, rect.bottom + 10);
      ui.selectionTooltip.style.top = `${top}px`;
      ui.selectionTooltip.style.left = `${left}px`;
    }
  };

  document.addEventListener("selectionchange", handleSelection);
  document.addEventListener("mouseup", handleSelection);
  document.addEventListener("scroll", handleSelection, true);
  window.addEventListener("resize", handleSelection);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") ui.selectionTooltip.classList.add("hidden");
  });
  ui.tooltipExplainBtn.addEventListener("pointerdown", (event) => event.preventDefault());

  ui.tooltipExplainBtn?.addEventListener("click", () => {
    if (!selectedText) return;
    ui.selectionTooltip?.classList.add("hidden");
    const clip = currentClip();
    const contextSentence = clip?.japanese ? ` in the sentence “${clip.japanese}”` : "";
    const prompt = `Briefly explain “${selectedText}”${contextSentence} in Traditional Chinese: its meaning and one useful reading or usage tip.`;
    window.getSelection()?.removeAllRanges();
    openBuddy();
    askChat(prompt);
    ui.chatInput.focus({ preventScroll: true });
  });
}

ui.audio.addEventListener("timeupdate", () => {
  const clip = currentClip();
  if (!clip) return;
  if (state.playbackActive && (!ui.audio.paused || ui.audio.ended) && ui.audio.currentTime >= clip.end - .025) finishClipPlayback();
  updateTransportProgress();
});
ui.audio.addEventListener("ended", () => { if (ui.audio.ended) finishClipPlayback(); });
ui.audio.addEventListener("play", () => { ui.attemptAudio.pause(); ui.play.textContent = "❚❚"; ui.play.setAttribute("aria-label", "Pause current clip"); $(".shadowing-deck")?.classList.add("is-playing"); });
ui.audio.addEventListener("pause", () => { ui.play.textContent = "▶"; ui.play.setAttribute("aria-label", "Play current clip"); $(".shadowing-deck")?.classList.remove("is-playing"); });
ui.audio.addEventListener("loadedmetadata", () => {
  ui.scan.disabled = false;
  if (ui.scanClassic) ui.scanClassic.disabled = false;
});
ui.audio.addEventListener("error", () => toast("This file could not be played in the browser."));

setUIDesign(state.uiDesign);
renderPlaybackMode();
setRate(state.rate);
ui.jumpLength.value = String(state.jumpLength);
ui.reflectionDelay.value = stored("kage-reflection-delay", "3000");
ui.sessionCount.textContent = String(state.attempts);
renderTranslationVisibility();
updateJumpLabels();
initSelectionTooltip();
initLockScreen();
loadLibrary();
loadStatus();

