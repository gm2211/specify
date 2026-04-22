/**
 * src/daemon/inspector.ts — Single-file HTML live inspector for the daemon.
 *
 * Rendered at `GET /`. No build step; vanilla JS streams from
 * `/events/stream` over SSE and polls `/inbox` + `/sessions`. Designed so a
 * user (or another agent) can watch what the daemon is doing in real time
 * without spinning up the full review webapp.
 *
 * Auth: if the daemon requires a token, the page prompts for it and stores
 * it in localStorage, then appends `?token=<token>` to all fetches + the
 * EventSource URL. The server's middleware accepts either the Authorization
 * header or the query-string token for this reason.
 */

interface InspectorOpts {
  authRequired: boolean;
}

export function renderInspectorHtml(opts: InspectorOpts): string {
  // Inline JSON config so the client knows whether to prompt for a token.
  const cfg = JSON.stringify({ authRequired: opts.authRequired });

  // Template string; indentation is intentionally minimal because it ships
  // to browsers. Kept in a .ts file (not a static asset) so the build step
  // doesn't need to copy anything.
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Specify daemon — live inspector</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --panel-border: #30363d;
      --fg: #c9d1d9;
      --fg-dim: #8b949e;
      --accent: #58a6ff;
      --ok: #3fb950;
      --warn: #d29922;
      --err: #f85149;
      --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--fg);
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: 0.02em; }
    header .status { font-family: var(--mono); font-size: 12px; color: var(--fg-dim); }
    header .status .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--err); margin-right: 6px; }
    header .status .dot.ok { background: var(--ok); }
    main { display: grid; grid-template-columns: 320px 1fr 380px; min-height: 0; }
    section { overflow: auto; border-right: 1px solid var(--panel-border); padding: 12px 14px; }
    section:last-child { border-right: none; }
    section h2 {
      margin: 0 0 8px 0;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--fg-dim);
    }
    .msg { background: var(--panel); border: 1px solid var(--panel-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; font-family: var(--mono); font-size: 12px; cursor: pointer; }
    .msg:hover { border-color: var(--accent); }
    .msg.active { border-color: var(--accent); background: #1f2633; }
    .msg .id { color: var(--accent); }
    .msg .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; margin-left: 6px; text-transform: uppercase; }
    .badge.queued { background: #6e7681; color: #0d1117; }
    .badge.running { background: var(--warn); color: #0d1117; }
    .badge.completed { background: var(--ok); color: #0d1117; }
    .badge.failed { background: var(--err); color: #fff; }
    .event { font-family: var(--mono); font-size: 12px; padding: 6px 8px; border-left: 2px solid var(--panel-border); margin-bottom: 4px; white-space: pre-wrap; word-break: break-word; }
    .event .t { color: var(--fg-dim); margin-right: 6px; }
    .event .k { color: var(--accent); margin-right: 6px; }
    .event.err { border-left-color: var(--err); }
    .event.ok  { border-left-color: var(--ok); }
    .event.txt { border-left-color: var(--warn); color: var(--fg); }
    #detail { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    #detail .k { color: var(--fg-dim); }
    footer { padding: 6px 16px; font-size: 11px; color: var(--fg-dim); border-top: 1px solid var(--panel-border); display: flex; gap: 16px; }
    button { background: transparent; border: 1px solid var(--panel-border); color: var(--fg); border-radius: 4px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
    button:hover { border-color: var(--accent); color: var(--accent); }
    .muted { color: var(--fg-dim); font-style: italic; }
  </style>
</head>
<body>
  <header>
    <h1>Specify · live inspector</h1>
    <div class="status"><span id="dot" class="dot"></span><span id="statusText">connecting…</span></div>
  </header>
  <main>
    <section>
      <h2>Messages</h2>
      <div id="messages"><div class="muted">Loading…</div></div>
    </section>
    <section>
      <h2>Event stream <button id="clearEvents" style="float:right">clear</button></h2>
      <div id="events"></div>
    </section>
    <section>
      <h2>Detail</h2>
      <div id="detail" class="muted">Select a message on the left to view its structured result, cost, and persisted report path.</div>
      <h2 style="margin-top:16px">Active sessions</h2>
      <div id="sessions" class="muted">none</div>
    </section>
  </main>
  <footer>
    <span>GET /events/stream</span>
    <span>GET /inbox</span>
    <span id="cost">cost: $0.0000</span>
  </footer>
  <script>
    const CFG = ${cfg};
    const dot = document.getElementById('dot');
    const statusText = document.getElementById('statusText');
    const messagesEl = document.getElementById('messages');
    const eventsEl = document.getElementById('events');
    const detailEl = document.getElementById('detail');
    const sessionsEl = document.getElementById('sessions');
    const costEl = document.getElementById('cost');

    function getToken() {
      if (!CFG.authRequired) return '';
      let t = localStorage.getItem('specify-daemon-token') || '';
      if (!t) {
        t = prompt('Specify daemon token (from ~/.specify/daemon.token):') || '';
        if (t) localStorage.setItem('specify-daemon-token', t);
      }
      return t;
    }

    function qs() {
      const t = getToken();
      return t ? ('?token=' + encodeURIComponent(t)) : '';
    }

    async function api(path) {
      const r = await fetch(path + qs());
      if (r.status === 401) {
        localStorage.removeItem('specify-daemon-token');
        throw new Error('unauthorized');
      }
      return r.json();
    }

    let activeMsgId = null;
    let totalCost = 0;

    function selectMsg(id) {
      activeMsgId = id;
      document.querySelectorAll('.msg').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
      if (!id) { detailEl.className = 'muted'; detailEl.textContent = 'Select a message…'; return; }
      api('/inbox/' + encodeURIComponent(id)).then((m) => {
        detailEl.className = '';
        detailEl.textContent = JSON.stringify(m, null, 2);
      }).catch((err) => {
        detailEl.className = 'muted';
        detailEl.textContent = 'error: ' + err.message;
      });
    }

    function renderMessages(list) {
      messagesEl.innerHTML = '';
      if (!list.length) {
        messagesEl.innerHTML = '<div class="muted">No messages yet. POST to /inbox to dispatch one.</div>';
        return;
      }
      for (const m of list) {
        const el = document.createElement('div');
        el.className = 'msg' + (m.id === activeMsgId ? ' active' : '');
        el.dataset.id = m.id;
        const cost = typeof m.costUsd === 'number' ? (' · $' + m.costUsd.toFixed(4)) : '';
        el.innerHTML = '<span class="id">' + m.id + '</span>' +
                       '<span class="badge ' + m.status + '">' + m.status + '</span>' +
                       ' · ' + (m.task || '?') +
                       (m.session ? (' · sess:' + m.session) : '') +
                       cost;
        el.onclick = () => selectMsg(m.id);
        messagesEl.appendChild(el);
      }
    }

    async function refresh() {
      try {
        const data = await api('/inbox');
        renderMessages(data.messages || []);
        const sess = await api('/sessions');
        sessionsEl.textContent = (sess.sessions || []).join(', ') || 'none';
        sessionsEl.className = (sess.sessions || []).length ? '' : 'muted';
      } catch (err) {
        messagesEl.innerHTML = '<div class="muted">error: ' + err.message + '</div>';
      }
    }

    function fmtEvent(event) {
      const ts = (event.timestamp || '').replace('T', ' ').replace(/\\..*/, '');
      const data = event.data || {};
      let cls = '';
      if (event.type.endsWith(':failed') || event.type.endsWith(':error') || event.type === 'agent:failed') cls = 'err';
      else if (event.type.endsWith(':completed') || event.type === 'agent:completed') cls = 'ok';
      else if (event.type === 'agent:text') cls = 'txt';
      let body = '';
      if (event.type === 'agent:text' && typeof data.text === 'string') {
        body = data.text.trim();
      } else if (event.type === 'agent:tool_use' && typeof data.summary === 'string') {
        body = data.summary;
      } else {
        body = JSON.stringify(data);
      }
      const sid = event.sessionId ? ('[' + event.sessionId + '] ') : '';
      return { cls, html: '<span class="t">' + ts + '</span><span class="k">' + sid + event.type + '</span>' + escapeHtml(body) };
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function addEvent(event) {
      const { cls, html } = fmtEvent(event);
      const el = document.createElement('div');
      el.className = 'event ' + cls;
      el.innerHTML = html;
      eventsEl.prepend(el);
      // Trim to last 300 events
      while (eventsEl.children.length > 300) eventsEl.removeChild(eventsEl.lastChild);
      if (event.type === 'inbox:received' || event.type === 'inbox:completed' || event.type === 'inbox:failed' || event.type === 'inbox:running') {
        refresh();
      }
      if (event.type === 'agent:completed' && event.data && typeof event.data.costUsd === 'number') {
        totalCost += event.data.costUsd;
        costEl.textContent = 'cost: $' + totalCost.toFixed(4);
      }
    }

    function connectStream() {
      const es = new EventSource('/events/stream' + qs());
      es.onopen = () => { dot.classList.add('ok'); statusText.textContent = 'connected'; };
      es.onerror = () => { dot.classList.remove('ok'); statusText.textContent = 'reconnecting…'; };
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          addEvent(parsed);
        } catch { /* ignore */ }
      };
    }

    document.getElementById('clearEvents').onclick = () => { eventsEl.innerHTML = ''; };

    refresh();
    setInterval(refresh, 5000);
    connectStream();
  </script>
</body>
</html>`;
}
