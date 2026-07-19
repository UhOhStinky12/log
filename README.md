# LM Studio Log Viewer (SillyTavern extension)

Shows LM Studio's developer logs (server logs + model input/output) live inside
SillyTavern, in a floating panel, so you can watch them from your phone
without sitting at your PC.

## Why this needs a helper script

LM Studio doesn't expose its developer logs over a normal HTTP endpoint - the
only supported way to read them is the `lms log stream` CLI command, which
talks to LM Studio's internal (undocumented, "unstable") RPC protocol. A
browser-only extension can't speak that protocol directly.

So this extension is one half of a pair:

1. **`lmstudio_log_bridge.py`** (not in this zip - see below) runs on the same
   PC as LM Studio. It launches `lms log stream --json` for you and re-serves
   the output as a simple live HTTP stream (Server-Sent Events), with CORS
   enabled.
2. **This extension** connects to that bridge over your network and displays
   the logs.

## Installation

1. In SillyTavern, go to **Extensions -> Install Extension** and point it at
   your GitHub repo (or just copy this folder into
   `public/scripts/extensions/third-party/sillytavern-lmstudio-logs/` if
   installing manually).
2. On the machine running LM Studio, run `lmstudio_log_bridge.py` (see its own
   instructions). By default it listens on `0.0.0.0:6172`.
3. Open the SillyTavern **Extensions** panel, find "LM Studio Log Viewer",
   and set **Bridge URL(s)** to a comma-separated list of every address that
   might reach the bridge, e.g.:
   `http://127.0.0.1:6172, http://192.168.1.20:6172`
   The extension pings each one and connects to whichever responds - so the
   same setting works from your PC's own browser (via `127.0.0.1`) and from
   your phone (via the LAN IP), without needing to change anything when you
   switch devices.
4. Click **Connect**, or check **Auto-connect** so it connects automatically
   whenever SillyTavern loads.
5. Click **Open Log Panel**, or tap the small terminal-icon button that's now
   floating on screen, to view the live log feed. The panel is draggable and
   works with touch on mobile.

## Notes

- Your phone needs to be able to reach that PC's IP/port - i.e. the same
  network setup you're already using to reach SillyTavern itself. If your
  router/firewall blocks the port, open it the same way you did for
  SillyTavern's own port.
- Toggle "Show server logs" / "Show model input/output logs" and use the
  filter box in the panel to cut down on noise.
- Use the download icon in the panel to export the currently visible log as a
  `.txt` file.
