// LM Studio Log Viewer - SillyTavern extension
// Connects to a local "lmstudio_log_bridge.py" process (run separately, alongside
// LM Studio) and streams its developer logs into a floating panel inside SillyTavern,
// so you can watch them from any device on your network - including your phone.

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "sillytavern-lmstudio-logs";

const defaultSettings = {
    bridgeUrl: "http://127.0.0.1:6172",
    autoConnect: false,
    maxLines: 500,
    showServer: true,
    showModel: true,
    autoscroll: true,
    fontSize: 12,
};

let eventSource = null;
let reconnectTimer = null;
let manuallyDisconnected = false;
let logBuffer = [];

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = defaultSettings[key];
        }
    }
    return extension_settings[extensionName];
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

function formatEvent(evt) {
    const time = evt.time ? new Date(evt.time * 1000).toLocaleTimeString() : "";
    const source = evt.source || "info";
    let body = "";

    if (evt.type === "raw") {
        body = evt.text || "";
    } else if (source === "model") {
        const kind = evt.data && evt.data.type ? evt.data.type : "model";
        const model = evt.data && evt.data.modelIdentifier ? evt.data.modelIdentifier : "";
        const text = evt.data && (evt.data.input || evt.data.output) || "";
        body = `[${kind}] ${model ? model + " " : ""}${text}`;
    } else if (source === "server") {
        body = (evt.data && (evt.data.message || evt.data.text)) || JSON.stringify(evt.data || {});
    } else {
        body = JSON.stringify(evt.data || evt);
    }

    return { time, source, body };
}

function renderLine(evt) {
    const settings = getSettings();
    const formatted = formatEvent(evt);

    if (formatted.source === "server" && !settings.showServer) return;
    if (formatted.source === "model" && !settings.showModel) return;

    const filterText = $("#lmlog_filter").val().toLowerCase().trim();
    if (filterText && !formatted.body.toLowerCase().includes(filterText) && !formatted.time.includes(filterText)) {
        return;
    }

    const $line = $(`
        <div class="lmlog-line lmlog-source-${escapeHtml(formatted.source)}">
            <span class="lmlog-time">${escapeHtml(formatted.time)}</span>
            <span class="lmlog-tag">${escapeHtml(formatted.source)}</span>
            <span class="lmlog-body"></span>
        </div>
    `);
    $line.find(".lmlog-body").text(formatted.body);

    const $content = $("#lmlog_content");
    $content.append($line);

    // trim to maxLines
    const max = Number(settings.maxLines) || 500;
    while ($content.children().length > max) {
        $content.children().first().remove();
    }

    if (settings.autoscroll) {
        $content.scrollTop($content[0].scrollHeight);
    }
}

function connect() {
    const settings = getSettings();
    manuallyDisconnected = false;
    disconnect(true);

    const url = settings.bridgeUrl.replace(/\/+$/, "") + "/events";
    setStatus("Connecting...", "lmlog-status-warn");

    try {
        eventSource = new EventSource(url);
    } catch (e) {
        setStatus("Invalid bridge URL", "lmlog-status-bad");
        return;
    }

    eventSource.onopen = () => {
        setStatus("Connected", "lmlog-status-ok");
    };

    eventSource.onmessage = (e) => {
        try {
            const evt = JSON.parse(e.data);
            renderLine(evt);
        } catch (err) {
            // ignore malformed lines / heartbeats
        }
    };

    eventSource.onerror = () => {
        setStatus("Disconnected - retrying...", "lmlog-status-bad");
        // EventSource auto-retries on its own, but if it's fully closed, retry manually.
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
    $("#lmlog_content").empty();
}

function exportLog() {
    const text = $("#lmlog_content")
        .children()
        .map(function () {
            return $(this).text();
        })
        .get()
        .join("\n");
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
                <label for="lmlog_url">Bridge URL</label>
                <input id="lmlog_url" type="text" class="text_pole" placeholder="http://127.0.0.1:6172" />
                <small>Address of the lmstudio_log_bridge.py script running next to LM Studio. Use your PC's LAN IP (e.g. http://192.168.1.20:6172) if viewing from your phone.</small>

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

                <label for="lmlog_maxlines">Max lines kept</label>
                <input id="lmlog_maxlines" type="number" class="text_pole" min="50" max="5000" step="50" />

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

    $("#lmlog_url").val(settings.bridgeUrl);
    $("#lmlog_autoconnect").prop("checked", settings.autoConnect);
    $("#lmlog_show_server").prop("checked", settings.showServer);
    $("#lmlog_show_model").prop("checked", settings.showModel);
    $("#lmlog_autoscroll").prop("checked", settings.autoscroll);
    $("#lmlog_maxlines").val(settings.maxLines);

    $("#lmlog_url").on("change", function () {
        settings.bridgeUrl = $(this).val().trim();
        saveSettings();
    });
    $("#lmlog_autoconnect").on("change", function () {
        settings.autoConnect = $(this).prop("checked");
        saveSettings();
    });
    $("#lmlog_show_server").on("change", function () {
        settings.showServer = $(this).prop("checked");
        saveSettings();
    });
    $("#lmlog_show_model").on("change", function () {
        settings.showModel = $(this).prop("checked");
        saveSettings();
    });
    $("#lmlog_autoscroll").on("change", function () {
        settings.autoscroll = $(this).prop("checked");
        saveSettings();
    });
    $("#lmlog_maxlines").on("change", function () {
        settings.maxLines = Number($(this).val()) || defaultSettings.maxLines;
        saveSettings();
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
            <button id="lmlog_panel_clear" class="lmlog-icon-btn" title="Clear"><i class="fa-solid fa-broom"></i></button>
            <button id="lmlog_panel_export" class="lmlog-icon-btn" title="Export"><i class="fa-solid fa-download"></i></button>
            <button id="lmlog_panel_close" class="lmlog-icon-btn" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="lmlog-panel-toolbar">
            <input id="lmlog_filter" type="text" placeholder="Filter text..." class="text_pole" />
        </div>
        <div id="lmlog_content" class="lmlog-content"></div>
    </div>
    <div id="lmlog_toggle_btn" class="lmlog-toggle-btn" title="LM Studio Logs">
        <i class="fa-solid fa-terminal"></i>
    </div>`;

    $("body").append(html);

    $("#lmlog_panel_close").on("click", closePanel);
    $("#lmlog_toggle_btn").on("click", togglePanel);
    $("#lmlog_panel_clear").on("click", clearLog);
    $("#lmlog_panel_export").on("click", exportLog);
    $("#lmlog_filter").on("input", () => {
        // re-render nothing retroactively (keep it simple/live-forward);
        // filter only applies to new incoming lines.
    });

    makeDraggable($("#lmlog_panel_header"), $("#lmlog_panel"));
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
