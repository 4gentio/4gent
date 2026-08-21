/**
 * Single-page operator UI.
 *
 * Deliberately a string constant with no build step, no framework and no
 * external requests: the dashboard has to keep working on a bare box at 3am
 * when something has gone wrong, and a broken asset pipeline is not an
 * acceptable reason to be unable to see the positions.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>4gent</title>
<style>
  :root {
    --bg: #0b0d10; --panel: #14181d; --line: #232a32;
    --text: #d7dee7; --muted: #7c8896; --accent: #4c9aff;
    --pos: #3fb950; --neg: #f85149; --warn: #d29922;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-size: 13px; }
  header {
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 10;
  }
  h1 { font-size: 15px; margin: 0; letter-spacing: 0.08em; }
  .tag { padding: 2px 8px; border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font-size: 11px; }
  .tag.live { color: var(--neg); border-color: var(--neg); }
  .tag.paper { color: var(--accent); border-color: var(--accent); }
  .tag.halt { color: var(--warn); border-color: var(--warn); }
  main { padding: 20px; display: grid; gap: 20px; max-width: 1500px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted);
       margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .stat { padding: 14px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .stat .value { font-size: 20px; margin-top: 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--muted); font-weight: normal; font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.06em; padding: 8px 14px; border-bottom: 1px solid var(--line); }
  td { padding: 8px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .pos { color: var(--pos); } .neg { color: var(--neg); } .muted { color: var(--muted); }
  .wrap { white-space: normal; max-width: 460px; color: var(--muted); }
  .empty { padding: 18px 14px; color: var(--muted); }
  .cycle { padding: 12px 14px; border-bottom: 1px solid var(--line); }
  .cycle .meta { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
  .scroll { max-height: 420px; overflow: auto; }
  footer { padding: 12px 20px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>4GENT</h1>
  <span class="tag" id="mode">-</span>
  <span class="tag" id="halt-tag" hidden>-</span>
  <span class="tag" id="loops">-</span>
  <span class="tag" id="updated">-</span>
</header>

<main>
  <section>
    <h2>Account</h2>
    <div class="stats" id="stats"></div>
  </section>

  <section>
    <h2>Open positions</h2>
    <div id="positions"></div>
  </section>

  <section>
    <h2>Recent trades</h2>
    <div class="scroll" id="trades"></div>
  </section>

  <section>
    <h2>Reasoning cycles</h2>
    <div class="scroll" id="reasoning"></div>
  </section>

  <section>
    <h2>Alerts</h2>
    <div class="scroll" id="alerts"></div>
  </section>
</main>

<footer>Read-only view. Polls every 10 seconds. Use the kill switch file to halt trading.</footer>

<script>
const fmt = (n, dp = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? '-' : Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted');
const ago = (ts) => {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
};
const el = (id) => document.getElementById(id);

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}

function table(headers, rows) {
  if (rows.length === 0) return '<div class="empty">Nothing to show.</div>';
  return '<table><thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join('') +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}

async function refresh() {
  try {
    const [status, perf, pos, tr, reasoning, alerts, nav] = await Promise.all([
      get('/api/status'), get('/api/performance'), get('/api/positions'),
      get('/api/trades?limit=25'), get('/api/reasoning?limit=10'), get('/api/alerts'), get('/api/nav'),
    ]);

    const mode = status.config.mode;
    el('mode').textContent = mode.toUpperCase();
    el('mode').className = 'tag ' + mode;

    const halted = status.status.killSwitch || status.status.paused;
    el('halt-tag').hidden = !halted;
    el('halt-tag').className = 'tag halt';
    el('halt-tag').textContent = status.status.killSwitch ? 'KILL SWITCH' : 'PAUSED';

    el('loops').textContent = (status.heartbeats || [])
      .map((h) => h.loop + ' ' + ago(h.lastSuccessAt)).join('  |  ') || 'no heartbeats';
    el('updated').textContent = 'updated ' + new Date().toLocaleTimeString();

    const latest = nav[nav.length - 1] || {};
    el('stats').innerHTML = [
      ['NAV', fmt(latest.nav)],
      ['Cash', fmt(status.status.cash)],
      ['Positions', fmt(latest.positionsValue)],
      ['Unrealised', fmt(latest.unrealizedPnl)],
      ['Realised', fmt(perf.realizedPnl)],
      ['Return', fmt(perf.totalReturnPct) + '%'],
      ['Max DD', fmt(perf.maxDrawdownPct) + '%'],
      ['Win rate', fmt(perf.winRatePct, 1) + '%'],
      ['Trades', perf.tradeCount],
    ].map(([label, value]) =>
      '<div class="stat"><div class="label">' + label + '</div><div class="value">' + value + '</div></div>'
    ).join('');

    el('positions').innerHTML = table(
      ['Symbol', 'Class', 'Qty', 'Entry', 'Basis', 'Stop', 'Strategy', 'Thesis'],
      pos.filter((p) => p.status === 'open').map((p) =>
        '<tr><td>' + p.symbol + '</td><td class="muted">' + p.assetClass + '</td><td>' + fmt(p.quantity, 4) +
        '</td><td>' + fmt(p.avgEntryPrice, 4) + '</td><td>' + fmt(p.costBasis) + '</td><td>' + fmt(p.hardStopPrice, 4) +
        '</td><td class="muted">' + p.strategy + '</td><td class="wrap">' + (p.thesis || '') + '</td></tr>'
      )
    );

    el('trades').innerHTML = table(
      ['When', 'Symbol', 'Side', 'Price', 'Notional', 'PnL', 'Mode'],
      tr.map((t) =>
        '<tr><td class="muted">' + ago(t.executedAt) + '</td><td>' + t.symbol + '</td><td>' + t.side +
        '</td><td>' + fmt(t.fillPrice, 6) + '</td><td>' + fmt(t.notional) + '</td><td class="' +
        sign(t.realizedPnl) + '">' + (t.realizedPnl === null ? '-' : fmt(t.realizedPnl)) +
        '</td><td class="muted">' + t.mode + '</td></tr>'
      )
    );

    el('reasoning').innerHTML = reasoning.length === 0
      ? '<div class="empty">No cycles recorded yet.</div>'
      : reasoning.map((c) => {
          const decisions = (c.decisions || []).map((d) =>
            d.action + ' ' + d.symbol + ' (conviction ' + d.conviction + ')').join(', ') || 'no action';
          return '<div class="cycle"><div class="meta">#' + c.id + '  ' + ago(c.startedAt) +
            '  ' + c.model + '  ' + c.latencyMs + 'ms  tokens ' + c.tokens.input + '/' + c.tokens.output +
            ' (' + c.tokens.cached + ' cached)' + (c.validationError ? '  VALIDATION ERROR' : '') +
            '</div><div>' + decisions + '</div><div class="wrap">' + (c.portfolioNote || '') + '</div></div>';
        }).join('');

    el('alerts').innerHTML = table(
      ['When', 'Level', 'Title', 'Detail'],
      alerts.map((a) =>
        '<tr><td class="muted">' + ago(a.createdAt) + '</td><td class="' +
        (a.level === 'critical' || a.level === 'error' ? 'neg' : a.level === 'warn' ? 'muted' : '') + '">' +
        a.level + '</td><td>' + a.title + '</td><td class="wrap">' + (a.body || '') + '</td></tr>'
      )
    );
  } catch (error) {
    el('updated').textContent = 'refresh failed: ' + error.message;
  }
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
