// LM Studio Log Viewer - SillyTavern extension
// Connects to a local "lmstudio_log_bridge.py" process (run separately, alongside
// LM Studio) and streams its developer logs into a floating panel inside SillyTavern,
// so you can watch them from any device on your network - including your phone.

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "sillytavern-lmstudio-logs";

const defaultSettings = {
    // Comma or newline separated list of candidate bridge addresses.
    // The extension pings each one and connects to whichever responds first,
    // so the same setting works whether you're on your PC (127.0.0.1 or
    // LAN IP) or your phone (LAN IP only).
    bridgeUrls: "http://127.0.0.1:6172, http://10.0.0.46:6172",
    autoConnect: false,
    // 0 = unlimited: keep every line for the whole session (matches "don't
    // delete any logs"). Set a positive number only if you need to cap
    // memory/DOM usage for very long-running sessions.
    maxLines: 0,
    showServer: true,
    showModel: true,
    autoscroll: true,
    fontSize: 12,
    // false = full log view, true = minimized token-usage dashboard
    statsMode: false,
};

let eventSource = null;
let reconnectTimer = null;
let manuallyDisconnected = false;
// Full history of every line received this session (not trimmed unless
// maxLines > 0). This is what filtering/exporting operate on, so switching
// a filter or reconnecting never loses anything already received.
let allEvents = [];

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const s = extension_settings[extensionName];

    // migrate old single "bridgeUrl" setting -> new "bridgeUrls" list
    if (s.bridgeUrl && !s.bridgeUrls) {
        s.bridgeUrls = s.bridgeUrl;
        delete s.bridgeUrl;
    }

    for (const key of Object.keys(defaultSettings)) {
        if (s[key] === undefined) {
            s[key] = defaultSettings[key];
        }
    }
    return s;
}

function parseUrlList(raw) {
    return String(raw || "")
        .split(/[,\n]/)
        .map((u) => u.trim().replace(/\/+$/, ""))
        .filter((u) => u.length > 0);
}

async function probeUrl(baseUrl, timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(baseUrl + "/health", { signal: controller.signal, cache: "no-store" });
        return res.ok;
    } catch (e) {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function pickReachableUrl(urls) {
    for (const url of urls) {
        // eslint-disable-next-line no-await-in-loop
        if (await probeUrl(url)) {
            return url;
        }
    }
    return null;
}

function saveSettings() {
    saveSettingsDebounced();
}

function setStatus(text, cls) {
    const $status = $("#lmlog_status");
    $status.text(text);
    $status.removeClass("lmlog-status-ok lmlog-status-bad lmlog-status-warn");
    if (cls) $status.addClass(cls);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// The bridge now sends the line exactly as LM Studio's own `lms log stream`
// printed it (no JSON parsing/reformatting), so what you see here has the
// same structure as LM Studio's own developer logs. We only strip a
// trailing newline, if any.
function lineText(evt) {
    return evt && typeof evt.text === "string" ? evt.text : "";
}

function passesFilters(evt) {
    const settings = getSettings();
    if (evt.source === "server" && !settings.showServer) return false;
    if (evt.source === "model" && !settings.showModel) return false;

    const filterText = $("#lmlog_filter").val().toLowerCase().trim();
    if (filterText && !lineText(evt).toLowerCase().includes(filterText)) {
        return false;
    }
    return true;
}

function buildLineElement(evt) {
    const $line = $(`<div class="lmlog-line lmlog-source-${escapeHtml(evt.source || "info")}"></div>`);
    // Blank lines are meaningful spacing in LM Studio's own log output
    // (e.g. between model log entries), so preserve them as empty rows
    // rather than collapsing them.
    $line.text(lineText(evt));
    if (lineText(evt) === "") {
        $line.html("&nbsp;");
    }
    return $line;
}

function appendLineToDom(evt) {
    const $content = $("#lmlog_content");
    $content.append(buildLineElement(evt));

    const settings = getSettings();
    const max = Number(settings.maxLines) || 0;
    if (max > 0) {
        while ($content.children().length > max) {
            $content.children().first().remove();
        }
    }

    if (settings.autoscroll) {
        $content.scrollTop($content[0].scrollHeight);
    }
}

// Called whenever a new event arrives from the bridge: store it (always,
// unbounded unless the user set a maxLines cap) and render it if it passes
// the current filters.
function handleIncomingEvent(evt) {
    allEvents.push(evt);

    const settings = getSettings();
    const max = Number(settings.maxLines) || 0;
    if (max > 0 && allEvents.length > max) {
        allEvents.splice(0, allEvents.length - max);
    }

    if (passesFilters(evt)) {
        appendLineToDom(evt);
    }

    updateStats(evt);
}

// Fully re-renders the panel from allEvents, applying current filters.
// Used when the filter text or show-server/show-model toggles change, so
// nothing already received is lost - it's just hidden/shown.
function rerenderFromHistory() {
    const $content = $("#lmlog_content");
    const fragment = document.createDocumentFragment();
    for (const evt of allEvents) {
        if (passesFilters(evt)) {
            fragment.appendChild(buildLineElement(evt)[0]);
        }
    }
    $content.empty();
    $content[0].appendChild(fragment);

    if (getSettings().autoscroll) {
        $content.scrollTop($content[0].scrollHeight);
    }
}

// ---------------------------------------------------------------------
// Live token-usage stats, parsed from the same verbatim log lines used
// for the full log view. Parsing is purely additive - it never changes
// what's stored in allEvents or shown in the full log.
// ---------------------------------------------------------------------

const RE_RUNNING = /Running chat completion on conversation with (\d+) messages/;
const RE_MODEL_TAG = /^\s*\[([^\]]+)\]/;
const RE_STREAMING_START = /Streaming response\.\.\./;
const RE_FINISHED = /Finished streaming response/;
const RE_PROGRESS = /Prompt processing progress:\s*([\d.]+)%/;
const RE_PROMPT_EVAL = /prompt eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)/;
const RE_GEN_EVAL = /\beval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens\s*\(\s*([\d.]+)\s*ms per token,\s*([\d.]+)\s*tokens per second\)/;
const RE_TOTAL = /total time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;
const RE_GRAPHS = /graphs reused\s*=\s*(\d+)/;
const RE_LIVE_TG = /n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t\/s,\s*tg_3s\s*=\s*([\d.]+)\s*t\/s/;
const RE_STOP = /stop processing:\s*n_tokens\s*=\s*(\d+),\s*truncated\s*=\s*(\d+)/;

const defaultStats = {
    model: null,
    phase: "idle", // idle | prompt | generating | done
    conversationMessages: null,
    promptPct: null,
    promptTokens: null, promptMs: null, promptTokPerSec: null,
    genTokensLive: null, genSpeedLive: null,
    genTokens: null, genMs: null, genTokPerSec: null,
    totalMs: null, totalTokens: null,
    graphsReused: null,
    contextTokens: null, truncated: null,
    lastLine: "",
    lastUpdate: null,
};

let stats = { ...defaultStats };

function resetRequestStats() {
    // Keep the model name and totals from the last completed request
    // visible until the new request actually produces fresh numbers -
    // only the "in-flight" fields reset immediately so the dashboard
    // doesn't flash to a wall of dashes on every new message.
    stats.phase = "prompt";
    stats.promptPct = 0;
    stats.promptTokens = null;
    stats.promptMs = null;
    stats.promptTokPerSec = null;
    stats.genTokensLive = null;
    stats.genSpeedLive = null;
    stats.genTokens = null;
    stats.genMs = null;
    stats.genTokPerSec = null;
    stats.totalMs = null;
    stats.totalTokens = null;
    stats.graphsReused = null;
}

function updateStats(evt) {
    const text = lineText(evt);
    if (!text) return;

    let matched = true;
    let m;

    if ((m = text.match(RE_RUNNING))) {
        stats.conversationMessages = Number(m[1]);
        const modelMatch = text.match(RE_MODEL_TAG);
        if (modelMatch) stats.model = modelMatch[1];
        resetRequestStats();
    } else if ((m = text.match(RE_PROGRESS))) {
        stats.phase = "prompt";
        stats.promptPct = Number(m[1]);
    } else if (RE_STREAMING_START.test(text)) {
        stats.phase = "generating";
        stats.promptPct = 100;
    } else if ((m = text.match(RE_LIVE_TG))) {
        stats.phase = "generating";
        stats.genTokensLive = Number(m[1]);
        stats.genSpeedLive = Number(m[3]); // tg_3s: recent/smoothed rate
    } else if ((m = text.match(RE_PROMPT_EVAL))) {
        stats.promptMs = Number(m[1]);
        stats.promptTokens = Number(m[2]);
        stats.promptTokPerSec = Number(m[4]);
    } else if ((m = text.match(RE_GEN_EVAL))) {
        stats.genMs = Number(m[1]);
        stats.genTokens = Number(m[2]);
        stats.genTokPerSec = Number(m[4]);
    } else if ((m = text.match(RE_TOTAL))) {
        stats.totalMs = Number(m[1]);
        stats.totalTokens = Number(m[2]);
    } else if ((m = text.match(RE_GRAPHS))) {
        stats.graphsReused = Number(m[1]);
    } else if ((m = text.match(RE_STOP))) {
        stats.contextTokens = Number(m[1]);
        stats.truncated = Number(m[2]);
    } else if (RE_FINISHED.test(text)) {
        stats.phase = "done";
    } else {
        matched = false;
    }

    if (matched) {
        stats.lastLine = text.trim();
        stats.lastUpdate = new Date();
        renderStats();
    }
}

function recomputeStatsFromHistory() {
    stats = { ...defaultStats };
    for (const evt of allEvents) {
        updateStats(evt);
    }
    renderStats();
}

function fmtTokSec(v) {
    return v === null || v === undefined ? "-" : `${v.toFixed(1)} tok/s`;
}
function fmtTokens(v) {
    return v === null || v === undefined ? "-" : String(v);
}
function fmtMs(v) {
    return v === null || v === undefined ? "-" : `${(v / 1000).toFixed(2)}s`;
}

const PHASE_LABELS = {
    idle: "Idle",
    prompt: "Processing Prompt",
    generating: "Generating",
    done: "Done",
};

function renderStats() {
    if (!$("#lmlog_stats_view").length) return; // panel not built yet

    $("#lmlog_stat_model").text(stats.model || "-");

    $("#lmlog_stat_phase")
        .text(stats.phase === "prompt" ? `${PHASE_LABELS.prompt} (${(stats.promptPct ?? 0).toFixed(0)}%)` : PHASE_LABELS[stats.phase])
        .attr("class", `lmlog-phase-badge lmlog-phase-${stats.phase}`);

    const pct = stats.phase === "idle" ? 0 : Math.max(0, Math.min(100, stats.promptPct ?? (stats.phase === "generating" || stats.phase === "done" ? 100 : 0)));
    $("#lmlog_progress_fill").css("width", pct + "%");
    $("#lmlog_progress_text").text(pct.toFixed(0) + "%");

    $("#lmlog_stat_prompt_tokens").text(fmtTokens(stats.promptTokens));
    $("#lmlog_stat_prompt_speed").text(fmtTokSec(stats.promptTokPerSec));

    // Prefer the final generation numbers once available; fall back to the
    // live tg_3s estimate while a response is still streaming.
    const genTokensDisplay = stats.genTokens ?? stats.genTokensLive;
    const genSpeedDisplay = stats.genTokPerSec ?? stats.genSpeedLive;
    $("#lmlog_stat_gen_tokens").text(fmtTokens(genTokensDisplay) + (stats.genTokens === null && stats.genTokensLive !== null ? " (live)" : ""));
    $("#lmlog_stat_gen_speed").text(fmtTokSec(genSpeedDisplay) + (stats.genTokPerSec === null && stats.genSpeedLive !== null ? " (live)" : ""));

    $("#lmlog_stat_total_time").text(stats.totalMs !== null ? `${fmtMs(stats.totalMs)} / ${fmtTokens(stats.totalTokens)} tok` : "-");
    $("#lmlog_stat_context").text(
        stats.contextTokens !== null
            ? `${fmtTokens(stats.contextTokens)}${stats.truncated ? " (truncated)" : ""}`
            : "-",
    );
    $("#lmlog_stat_messages").text(fmtTokens(stats.conversationMessages));
    $("#lmlog_stat_lastline").text(stats.lastLine || "-");
    $("#lmlog_stat_updated").text(stats.lastUpdate ? stats.lastUpdate.toLocaleTimeString() : "-");
}


async function connect() {
    const settings = getSettings();
    manuallyDisconnected = false;
    disconnect(true);

    const candidates = parseUrlList(settings.bridgeUrls);
    if (candidates.length === 0) {
        setStatus("No bridge URL(s) configured", "lmlog-status-bad");
        return;
    }

    // The bridge (lmstudio_log_bridge.py) only ever speaks plain HTTP. If
    // SillyTavern itself was loaded over HTTPS, the browser will silently
    // block any http:// request as "mixed content" - which looks identical
    // to "unreachable" unless we call it out explicitly.
    if (window.location.protocol === "https:" && candidates.every((u) => u.startsWith("http://"))) {
        setStatus("Page is https:// but bridge URLs are http:// - browser may block this (mixed content)", "lmlog-status-bad");
    } else {
        setStatus(`Checking ${candidates.length} address(es)...`, "lmlog-status-warn");
    }

    const reachable = await pickReachableUrl(candidates);

    if (manuallyDisconnected) return; // user hit disconnect while we were probing

    if (!reachable) {
        setStatus("No reachable bridge - retrying...", "lmlog-status-bad");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
        return;
    }

    const url = reachable + "/events";
    setStatus(`Connecting (${reachable})...`, "lmlog-status-warn");

    try {
        eventSource = new EventSource(url);
    } catch (e) {
        setStatus("Invalid bridge URL", "lmlog-status-bad");
        return;
    }

    eventSource.onopen = () => {
        setStatus(`Connected (${reachable})`, "lmlog-status-ok");
    };

    eventSource.onmessage = (e) => {
        try {
            const evt = JSON.parse(e.data);
            handleIncomingEvent(evt);
        } catch (err) {
            // ignore malformed lines / heartbeats
        }
    };

    eventSource.onerror = () => {
        setStatus("Disconnected - retrying...", "lmlog-status-bad");
        // EventSource auto-retries the same URL on its own; if it's fully
        // closed, fall back to re-probing the whole candidate list (in case
        // the bridge moved to a different address, e.g. Wi-Fi changed).
        if (eventSource && eventSource.readyState === EventSource.CLOSED && !manuallyDisconnected) {
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, 4000);
        }
    };
}

function disconnect(silent) {
    manuallyDisconnected = !silent;
    clearTimeout(reconnectTimer);
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    if (!silent) {
        setStatus("Disconnected", "lmlog-status-bad");
    }
}

function clearLog() {
    allEvents = [];
    $("#lmlog_content").empty();
    stats = { ...defaultStats };
    renderStats();
}

function exportLog() {
    const text = allEvents.map(lineText).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lmstudio-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function buildSettingsPanel() {
    const settings = getSettings();
    const html = `
    <div id="lmlog_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>LM Studio Log Viewer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="lmlog_url">Bridge URL(s)</label>
                <textarea id="lmlog_url" class="text_pole" rows="2" placeholder="http://127.0.0.1:6172, http://192.168.1.20:6172"></textarea>
                <small>Comma or newline separated list of addresses for lmstudio_log_bridge.py. Add both your PC's <code>127.0.0.1:6172</code> and its LAN IP (e.g. <code>192.168.1.20:6172</code>) - the extension automatically connects to whichever one responds on the device you're using (PC or phone).</small>

                <label class="checkbox_label" for="lmlog_autoconnect">
                    <input id="lmlog_autoconnect" type="checkbox" />
                    Auto-connect when SillyTavern loads
                </label>

                <label class="checkbox_label" for="lmlog_show_server">
                    <input id="lmlog_show_server" type="checkbox" checked />
                    Show server logs
                </label>

                <label class="checkbox_label" for="lmlog_show_model">
                    <input id="lmlog_show_model" type="checkbox" checked />
                    Show model input/output logs
                </label>

                <label class="checkbox_label" for="lmlog_autoscroll">
                    <input id="lmlog_autoscroll" type="checkbox" checked />
                    Autoscroll
                </label>

                <label for="lmlog_maxlines">Max lines kept (0 = unlimited, nothing ever deleted)</label>
                <input id="lmlog_maxlines" type="number" class="text_pole" min="0" max="1000000" step="100" />
                <small>Leave at 0 to keep the full session's logs. Only set a limit if you're running SillyTavern for days at a stretch and want to bound memory/DOM usage.</small>

                <div class="lmlog-btn-row">
                    <button id="lmlog_connect_btn" class="menu_button">Connect</button>
                    <button id="lmlog_disconnect_btn" class="menu_button">Disconnect</button>
                    <button id="lmlog_open_panel_btn" class="menu_button">Open Log Panel</button>
                </div>
                <div>Status: <span id="lmlog_status" class="lmlog-status-bad">Disconnected</span></div>
            </div>
        </div>
    </div>`;

    $("#extensions_settings2").append(html);

    $("#lmlog_url").val(settings.bridgeUrls);
    $("#lmlog_autoconnect").prop("checked", settings.autoConnect);
    $("#lmlog_show_server").prop("checked", settings.showServer);
    $("#lmlog_show_model").prop("checked", settings.showModel);
    $("#lmlog_autoscroll").prop("checked", settings.autoscroll);
    $("#lmlog_maxlines").val(settings.maxLines);

    $("#lmlog_url").on("change", function () {
        settings.bridgeUrls = $(this).val().trim();
        saveSettings();
    });
    $("#lmlog_autoconnect").on("change", function () {
        settings.autoConnect = $(this).prop("checked");
        saveSettings();
    });
    $("#lmlog_show_server").on("change", function () {
        settings.showServer = $(this).prop("checked");
        saveSettings();
        rerenderFromHistory();
    });
    $("#lmlog_show_model").on("change", function () {
        settings.showModel = $(this).prop("checked");
        saveSettings();
        rerenderFromHistory();
    });
    $("#lmlog_autoscroll").on("change", function () {
        settings.autoscroll = $(this).prop("checked");
        saveSettings();
    });
    $("#lmlog_maxlines").on("change", function () {
        settings.maxLines = Math.max(0, Number($(this).val()) || 0);
        saveSettings();
        if (settings.maxLines > 0 && allEvents.length > settings.maxLines) {
            allEvents.splice(0, allEvents.length - settings.maxLines);
        }
        rerenderFromHistory();
    });

    $("#lmlog_connect_btn").on("click", connect);
    $("#lmlog_disconnect_btn").on("click", () => disconnect(false));
    $("#lmlog_open_panel_btn").on("click", openPanel);
}

function buildFloatingPanel() {
    const html = `
    <div id="lmlog_panel" class="lmlog-panel lmlog-hidden">
        <div id="lmlog_panel_header" class="lmlog-panel-header">
            <span>LM Studio Logs</span>
            <span id="lmlog_status_mini" class="lmlog-status-bad">●</span>
            <span class="lmlog-spacer"></span>
            <button id="lmlog_panel_minimize" class="lmlog-icon-btn" title="Toggle token-usage view"><i class="fa-solid fa-gauge-high"></i></button>
            <button id="lmlog_panel_clear" class="lmlog-icon-btn" title="Clear"><i class="fa-solid fa-broom"></i></button>
            <button id="lmlog_panel_export" class="lmlog-icon-btn" title="Export"><i class="fa-solid fa-download"></i></button>
            <button id="lmlog_panel_close" class="lmlog-icon-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="lmlog_panel_toolbar" class="lmlog-panel-toolbar">
            <input id="lmlog_filter" type="text" placeholder="Filter text..." class="text_pole" />
        </div>
        <div id="lmlog_content" class="lmlog-content"></div>

        <div id="lmlog_stats_view" class="lmlog-stats-view lmlog-hidden">
            <div class="lmlog-stats-row">
                <span class="lmlog-stats-label">Model</span>
                <span id="lmlog_stat_model">-</span>
            </div>
            <div class="lmlog-stats-row">
                <span class="lmlog-stats-label">Status</span>
                <span id="lmlog_stat_phase" class="lmlog-phase-badge lmlog-phase-idle">Idle</span>
            </div>
            <div class="lmlog-progress-wrap">
                <div class="lmlog-progress-bar"><div id="lmlog_progress_fill" class="lmlog-progress-fill" style="width:0%"></div></div>
                <span id="lmlog_progress_text">0%</span>
            </div>
            <div class="lmlog-stats-grid">
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Prompt tokens</span><span id="lmlog_stat_prompt_tokens">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Prompt speed</span><span id="lmlog_stat_prompt_speed">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Gen tokens</span><span id="lmlog_stat_gen_tokens">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Gen speed</span><span id="lmlog_stat_gen_speed">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Total time</span><span id="lmlog_stat_total_time">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Context (n_tokens)</span><span id="lmlog_stat_context">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Messages</span><span id="lmlog_stat_messages">-</span></div>
                <div class="lmlog-stats-cell"><span class="lmlog-stats-label">Updated</span><span id="lmlog_stat_updated">-</span></div>
            </div>
            <div class="lmlog-stats-lastline">Last: <span id="lmlog_stat_lastline">-</span></div>
        </div>
    </div>
    <div id="lmlog_toggle_btn" class="lmlog-toggle-btn" title="LM Studio Logs">
        <i class="fa-solid fa-terminal"></i>
    </div>`;

    $("body").append(html);

    $("#lmlog_panel_close").on("click", closePanel);
    $("#lmlog_toggle_btn").on("click", togglePanel);
    $("#lmlog_panel_clear").on("click", clearLog);
    $("#lmlog_panel_export").on("click", exportLog);
    $("#lmlog_panel_minimize").on("click", toggleStatsMode);
    $("#lmlog_filter").on("input", () => {
        rerenderFromHistory();
    });

    applyStatsMode(getSettings().statsMode);

    makeDraggable($("#lmlog_panel_header"), $("#lmlog_panel"));
}

function applyStatsMode(enabled) {
    $("#lmlog_panel").toggleClass("lmlog-stats-active", !!enabled);
    $("#lmlog_content, #lmlog_panel_toolbar").toggleClass("lmlog-hidden", !!enabled);
    $("#lmlog_stats_view").toggleClass("lmlog-hidden", !enabled);
    $("#lmlog_panel_minimize i")
        .attr("class", enabled ? "fa-solid fa-list" : "fa-solid fa-gauge-high");
    $("#lmlog_panel_minimize").attr("title", enabled ? "Show full log" : "Toggle token-usage view");
    if (enabled) {
        recomputeStatsFromHistory();
    }
}

function toggleStatsMode() {
    const settings = getSettings();
    settings.statsMode = !settings.statsMode;
    saveSettings();
    applyStatsMode(settings.statsMode);
}

function openPanel() {
    $("#lmlog_panel").removeClass("lmlog-hidden");
}
function closePanel() {
    $("#lmlog_panel").addClass("lmlog-hidden");
}
function togglePanel() {
    $("#lmlog_panel").toggleClass("lmlog-hidden");
}

function makeDraggable($handle, $target) {
    let startX, startY, startLeft, startTop, dragging = false;

    function pointerDown(e) {
        // Let taps/clicks on buttons and inputs inside the header behave
        // normally - previously this handler always fired first and called
        // preventDefault(), which silently swallowed the click event mobile
        // browsers synthesize after touchend, making the close/export/clear
        // buttons appear dead on touchscreens (desktop mouse clicks aren't
        // affected by preventDefault on an earlier mousedown, which is why
        // it only showed up on mobile).
        if ($(e.target).closest("button, .lmlog-icon-btn, input, select, textarea, a").length) {
            return;
        }

        dragging = true;
        const point = e.touches ? e.touches[0] : e;
        startX = point.clientX;
        startY = point.clientY;
        const rect = $target[0].getBoundingClientRect();
        startLeft = rect.left;
        startTop = rect.top;
        $target.css({ right: "auto", bottom: "auto", left: startLeft + "px", top: startTop + "px" });
        e.preventDefault();
    }
    function pointerMove(e) {
        if (!dragging) return;
        const point = e.touches ? e.touches[0] : e;
        const dx = point.clientX - startX;
        const dy = point.clientY - startY;
        $target.css({ left: startLeft + dx + "px", top: startTop + dy + "px" });
    }
    function pointerUp() {
        dragging = false;
    }

    $handle.on("mousedown touchstart", pointerDown);
    $(document).on("mousemove touchmove", pointerMove);
    $(document).on("mouseup touchend", pointerUp);
}

// keep the mini status dot in sync with the main status text
function syncMiniStatus() {
    const cls = $("#lmlog_status").attr("class") || "";
    $("#lmlog_status_mini").attr("class", cls.replace("lmlog-status", "lmlog-status") || "");
}

const _origSetStatus = setStatus;
function setStatusWrapped(text, cls) {
    _origSetStatus(text, cls);
    $("#lmlog_status_mini").removeClass("lmlog-status-ok lmlog-status-bad lmlog-status-warn");
    if (cls) $("#lmlog_status_mini").addClass(cls);
}

jQuery(async () => {
    getSettings();
    buildSettingsPanel();
    buildFloatingPanel();

    // swap in the wrapped status setter now that both status elements exist
    setStatus = setStatusWrapped; // eslint-disable-line no-func-assign

    if (getSettings().autoConnect) {
        connect();
    }
});
