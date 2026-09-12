#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

function usage() {
  console.log(`Usage:
  unwireit [path-to-package.json] [-o output.html] [--no-open]
  unwireit serve [path-to-package.json] [-p port] [--no-open] [--editor <cmd>]

Reads a package.json, extracts the "wireit" task configuration, and
renders the task dependency graph as an interactive layered DAG
(D3.js + d3-dag).

Default mode generates a self-contained static HTML file.

"serve" mode starts a local web server and live-reloads the graph in
the browser whenever the package.json file changes on disk. In serve
mode, double-clicking a node opens package.json in your editor at the
exact line where that task is defined under "wireit" (not the
"scripts" entry).

Options:
  -o, --output <file>   Output HTML file for the default mode (default: wireit-graph.html)
  -p, --port <number>   Port to listen on in serve mode (default: 5183, bound to localhost only)
  --editor <cmd>        Editor command template used for double-click-to-open in serve mode.
                         Use {file} and {line} placeholders, e.g. "code --goto {file}:{line}".
                         Defaults to $VISUAL / $EDITOR, then auto-detects a known editor on PATH.
  --no-open             Do not automatically open the browser/file
  -h, --help            Show this help message
`);
}

function parseArgs(argv) {
  const args = {
    mode: 'static',
    input: 'package.json',
    output: 'wireit-graph.html',
    open: true,
    port: 5183,
    editor: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      usage();
      process.exit(0);
    } else if (a === '-o' || a === '--output') {
      args.output = argv[++i];
    } else if (a === '-p' || a === '--port') {
      args.port = Number(argv[++i]);
    } else if (a === '--editor') {
      args.editor = argv[++i];
    } else if (a === '--no-open') {
      args.open = false;
    } else if (a === 'serve' && rest.length === 0) {
      args.mode = 'serve';
    } else {
      rest.push(a);
    }
  }
  if (rest.length > 0) args.input = rest[0];
  return args;
}

function loadPackageJson(inputPath) {
  const resolved = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${resolved}: ${err.message}`);
  }
  return { pkg, resolved };
}

/**
 * Builds a DAG-ready { nodes } array from a wireit config block, in the
 * shape expected by d3-dag's `graphStratify` ({ id, parentIds }).
 *
 * - One node per wireit task, tagged as external when referenced only
 *   as a dependency (e.g. "../other-package:build") and not defined
 *   locally in this package.json.
 * - `parentIds` = the task's dependencies, since a dependency must run
 *   *before* the task that declares it (dependency = parent, task =
 *   child, in DAG-layering terms). Edges are rendered from dependency
 *   toward the dependent task, showing "runs before" order.
 */
function buildGraph(pkg) {
  const wireit = pkg.wireit || {};
  const taskNames = Object.keys(wireit);
  const nodeMap = new Map();

  function ensureNode(id) {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, external: false, command: null, parentIds: [] });
    }
    return nodeMap.get(id);
  }

  taskNames.forEach((name) => {
    const def = wireit[name] || {};
    const node = ensureNode(name);
    node.command = def.command || null;
  });

  taskNames.forEach((name) => {
    const def = wireit[name] || {};
    const deps = Array.isArray(def.dependencies) ? def.dependencies : [];
    const node = ensureNode(name);
    deps.forEach((depRaw) => {
      // wireit dependency entries can be objects like { script: "..." }
      const dep = typeof depRaw === 'string' ? depRaw : depRaw && depRaw.script;
      if (!dep) return;
      const depNode = ensureNode(dep);
      if (!taskNames.includes(dep)) {
        depNode.external = true;
      }
      node.parentIds.push(dep);
    });
  });

  const nodes = Array.from(nodeMap.values()).map((n) => ({
    ...n,
    parentIds: n.parentIds.length ? n.parentIds : undefined,
  }));

  return { nodes };
}

/**
 * Scans the raw package.json text and returns the character offset of the
 * key `"<taskId>"` as it's defined directly under the top-level "wireit"
 * object (i.e. its actual task definition), ignoring any occurrences of
 * the same name elsewhere (e.g. under "scripts", or inside another task's
 * "dependencies" array). Returns null if not found.
 *
 * This is a hand-rolled scanner (rather than a full JSON parser) so it can
 * report the exact source offset of the matching key, tracking object/array
 * nesting depth and string boundaries (with escape handling) so that braces
 * or brackets inside string values (e.g. a shell command) don't throw off
 * the depth count.
 */
function findWireitTaskOffset(rawText, taskId) {
  const header = /"wireit"\s*:\s*\{/.exec(rawText);
  if (!header) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let stringStart = -1;
  let lastDepth1String = null; // { start, text }

  for (let i = header.index + header[0].length - 1; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') {
        inString = false;
        if (depth === 1) lastDepth1String = { start: stringStart, text: rawText.slice(stringStart + 1, i) };
      }
      continue;
    }
    if (ch === '"') { inString = true; stringStart = i; continue; }
    if (ch === '{' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) break; // reached the end of the wireit object
      continue;
    }
    if (ch === ':' && depth === 1 && lastDepth1String && lastDepth1String.text === taskId) {
      return lastDepth1String.start;
    }
  }
  return null;
}

/** Converts a character offset into a 1-based { line, column }. */
function offsetToLineColumn(rawText, offset) {
  const before = rawText.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Builds a shell command template ("{bin} ... {file}:{line} ...") for a
 * known editor binary name, using each editor's own CLI convention for
 * jumping to a specific line.
 */
function templateForEditorBinary(bin) {
  const base = path.basename(bin).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (['code', 'code-insiders', 'cursor', 'codium', 'vscodium'].includes(base)) {
    return `${bin} --goto {file}:{line}:1`;
  }
  if (['subl', 'sublime_text', 'sublime'].includes(base)) {
    return `${bin} {file}:{line}`;
  }
  if (base === 'atom') {
    return `${bin} {file}:{line}`;
  }
  if (['idea', 'webstorm', 'pycharm', 'goland', 'rubymine', 'phpstorm', 'clion'].includes(base)) {
    return `${bin} --line {line} {file}`;
  }
  if (['vim', 'nvim', 'vi', 'emacs', 'nano', 'hx', 'helix'].includes(base)) {
    return `${bin} +{line} {file}`;
  }
  return `${bin} {file}`;
}

/**
 * Resolves an editor command template to use for "open at line", trying in
 * order: an explicit --editor flag, $VISUAL/$EDITOR, then a handful of
 * common editors found on PATH. Returns null if nothing usable was found.
 */
function resolveEditorTemplate(explicitEditor) {
  if (explicitEditor) {
    return explicitEditor.includes('{file}') ? explicitEditor : `${explicitEditor} {file}`;
  }
  const candidates = [];
  if (process.env.VISUAL) candidates.push(process.env.VISUAL);
  if (process.env.EDITOR) candidates.push(process.env.EDITOR);
  candidates.push('code', 'cursor', 'code-insiders', 'subl', 'atom', 'idea', 'webstorm');

  for (const candidate of candidates) {
    const bin = candidate.split(' ')[0];
    const checkCmd = process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`;
    try {
      execSync(checkCmd, { stdio: 'ignore' });
    } catch (_err) {
      continue;
    }
    return templateForEditorBinary(bin);
  }
  return null;
}

/** Fills a resolved editor template's {file}/{line} placeholders and runs it. */
function launchEditor(template, file, line) {
  const filled = template.replace(/\{file\}/g, `"${file}"`).replace(/\{line\}/g, String(line));
  execSync(filled, { stdio: 'ignore' });
}

function renderHtml(graph, meta, opts = {}) {
  const live = !!opts.live;
  const dataJson = JSON.stringify(graph);
  const metaJson = JSON.stringify(meta);
  const liveJson = JSON.stringify(live);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>wireit task graph — ${escapeHtml(meta.name || meta.source)}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/d3-dag@1.2.2/dist/d3-dag.iife.min.js"></script>
<style>
  :root {
    --bg: #0f1117;
    --panel: #171923;
    --border: #2a2e3a;
    --text: #e6e6e6;
    --muted: #9aa0ac;
    --accent: #5cc8ff;
    --external: #ff9d5c;
    --link: #4b5262;
    --danger: #ff6b6b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  #app { display: flex; flex-direction: column; height: 100%; }
  header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; color: var(--text); }
  header .source { font-size: 12px; color: var(--muted); }
  header .actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  #graph-wrap { position: relative; flex: 1; overflow: hidden; }
  svg { width: 100%; height: 100%; display: block; }
  .link { stroke: var(--link); stroke-opacity: 0.85; fill: none; stroke-width: 1.4px; transition: stroke 0.25s ease, stroke-opacity 0.25s ease, stroke-width 0.25s ease; }
  .link.dim { stroke-opacity: 0.06; }
  .link.active { stroke: #eef2ff; stroke-opacity: 1; stroke-width: 2.4px; }
  .node rect { stroke: #000; stroke-opacity: 0.3; stroke-width: 1px; cursor: grab; fill: var(--accent); transition: fill 0.25s ease, stroke 0.25s ease, stroke-width 0.25s ease; }
  .node.external rect { fill: var(--external); }
  .node rect:active { cursor: grabbing; }
  .node.moved rect { stroke: #fff; stroke-width: 2.5px; }
  .node.dim { opacity: 0.15; }
  .node.upstream rect { fill: #ffb454; }
  .node.downstream rect { fill: #b388ff; }
  .node.focus-origin rect { stroke: #fff; stroke-width: 2.5px; }
  .node.search-match rect { stroke: #ffe066; stroke-width: 3px; }
  .node.search-match { filter: drop-shadow(0 0 8px rgba(255,224,102,0.85)); }
  .node { transition: opacity 0.25s ease, filter 0.25s ease; }
  .node text { fill: #0b0d12; font-size: 11px; font-weight: 600; pointer-events: none; text-anchor: middle; dominant-baseline: middle; }
  .legend { position: absolute; bottom: 12px; left: 12px; max-width: min(480px, calc(100vw - 24px)); max-height: calc(100% - 24px); overflow-y: auto; background: rgba(23,25,35,0.85); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; font-size: 12px; color: var(--muted); }
  .legend span.dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: middle; }
  .tooltip { position: absolute; pointer-events: none; background: #1f2330; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 12px; color: var(--text); max-width: 320px; white-space: pre-wrap; opacity: 0; transition: opacity 0.1s; z-index: 5; }
  .error-banner { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); background: #3a1414; border: 1px solid var(--danger); color: #ffd4d4; padding: 8px 14px; border-radius: 6px; font-size: 12px; max-width: 80%; display: none; }
  .live-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; }
  .live-badge .dot { width: 7px; height: 7px; border-radius: 50%; background: #4caf50; }
  .live-badge.disconnected .dot { background: var(--danger); }
  .search-wrap { position: relative; display: flex; align-items: center; }
  .search-wrap input { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px 54px 6px 10px; font-size: 12px; width: 200px; }
  .search-wrap input:focus { outline: none; border-color: var(--accent); }
  .search-wrap .search-count { position: absolute; right: 28px; font-size: 11px; color: var(--muted); pointer-events: none; }
  .search-wrap .search-clear { position: absolute; right: 4px; width: 20px; height: 20px; display: none; align-items: center; justify-content: center; border: none; background: transparent; color: var(--muted); font-size: 15px; line-height: 1; cursor: pointer; border-radius: 50%; }
  .search-wrap .search-clear:hover { color: var(--text); background: rgba(255,255,255,0.08); }
  .search-wrap.has-query .search-clear { display: flex; }
  .toast { position: absolute; top: 12px; right: 12px; background: #172a1f; border: 1px solid #2f6b45; color: #bdf5cf; padding: 6px 12px; border-radius: 6px; font-size: 12px; opacity: 0; transform: translateY(-6px); transition: opacity 0.2s, transform 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>wireit task graph</h1>
    <div class="source" id="source-label">${escapeHtml(meta.source)}</div>
    ${live ? '<div class="live-badge" id="live-badge"><span class="dot"></span>watching for changes</div>' : ''}
    <div class="search-wrap" id="search-wrap">
      <input type="text" id="search-input" placeholder="Search tasks…" autocomplete="off" spellcheck="false" />
      <span class="search-count" id="search-count"></span>
      <button type="button" class="search-clear" id="search-clear" title="Clear search" aria-label="Clear search">×</button>
    </div>
    <div class="actions">
      <button id="toggle-orientation">Switch to top-down</button>
      <button id="reset-layout">Reset layout</button>
    </div>
  </header>
  <div id="graph-wrap">
    <svg></svg>
    <div class="error-banner" id="error-banner"></div>
    <div class="toast" id="toast"></div>
    <div class="legend">
      <div><span class="dot" style="background:var(--accent)"></span>local task</div>
      <div><span class="dot" style="background:var(--external)"></span>external / cross-package task</div>
      <div style="margin-top:4px;color:var(--muted)">Arrows point from a task to the dependency it needs (i.e. "depends on"). <strong>Hover a node</strong> to highlight its upstream (amber) / downstream (purple) chain and dim the rest. <strong>Search</strong> to light up matching tasks. Drag a node to move it; dragged nodes get a white ring. "Reset layout" restores the automatic layered layout.</div>
      <div style="margin-top:2px;"><span class="dot" style="background:#ffb454"></span>upstream (dependencies) <span class="dot" style="background:#b388ff;margin-left:8px"></span>downstream (dependents)</div>
    </div>
    <div class="tooltip"></div>
  </div>
</div>
<script>
let graphData = ${dataJson};
let meta = ${metaJson};
const LIVE = ${liveJson};

const svg = d3.select('svg');
const wrap = document.getElementById('graph-wrap');
const tooltip = d3.select('.tooltip');
const errorBanner = document.getElementById('error-banner');

const container = svg.append('g');

const zoomBehavior = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event) => {
  container.attr('transform', event.transform);
});
svg.call(zoomBehavior);

svg.append('defs').append('marker')
  .attr('id', 'arrow')
  .attr('viewBox', '0 -5 10 10')
  .attr('refX', 9)
  .attr('refY', 0)
  .attr('markerWidth', 7)
  .attr('markerHeight', 7)
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-5L10,0L0,5')
  .attr('fill', 'var(--link)');

svg.append('defs').append('marker')
  .attr('id', 'arrow-active')
  .attr('viewBox', '0 -5 10 10')
  .attr('refX', 9)
  .attr('refY', 0)
  .attr('markerWidth', 7)
  .attr('markerHeight', 7)
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-5L10,0L0,5')
  .attr('fill', '#eef2ff');

const linkLayer = container.append('g');
const nodeLayer = container.append('g');

let orientation = 'LR'; // 'LR' = left-to-right, 'TB' = top-to-bottom
let searchQuery = '';
let nodesById = new Map();
let links = [];
let layoutWidth = 0;
let layoutHeight = 0;
let parentsOf = new Map(); // id -> [dependency ids]
let childrenOf = new Map(); // id -> [dependent ids]

function estimateBoxSize(label) {
  const width = Math.max(70, Math.min(240, label.length * 7.2 + 28));
  const height = 34;
  return [width, height];
}

/** Rebuilds the parentsOf / childrenOf adjacency maps from graphData. */
function buildAdjacency() {
  parentsOf = new Map();
  childrenOf = new Map();
  graphData.nodes.forEach((n) => {
    parentsOf.set(n.id, n.parentIds || []);
    if (!childrenOf.has(n.id)) childrenOf.set(n.id, []);
  });
  graphData.nodes.forEach((n) => {
    (n.parentIds || []).forEach((pid) => {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(n.id);
    });
  });
}

/** BFS over the given adjacency map, returning the transitive closure (excluding start). */
function collectReachable(startId, adjacency) {
  const seen = new Set();
  const stack = [...(adjacency.get(startId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) || []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/**
 * Determines which side of a node's box an edge should exit/enter from,
 * based on the direction toward (otherX, otherY) — normalized by the box's
 * half-width/half-height so the choice reflects which edge the other node
 * is actually closest to (a wide box favors left/right, a tall one favors
 * top/bottom), not just raw left-right vs up-down screen position.
 */
function computeSide(node, otherX, otherY) {
  const dx = otherX - node.x;
  const dy = otherY - node.y;
  const rx = node.w > 0 ? dx / (node.w / 2) : dx;
  const ry = node.h > 0 ? dy / (node.h / 2) : dy;
  if (Math.abs(rx) >= Math.abs(ry)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

/** Returns the [x, y] point on a node's box border for the given side + offset along that edge. */
function portPointForSide(node, side, offset) {
  switch (side) {
    case 'left': return [node.x - node.w / 2, node.y + offset];
    case 'right': return [node.x + node.w / 2, node.y + offset];
    case 'top': return [node.x + offset, node.y - node.h / 2];
    default: return [node.x + offset, node.y + node.h / 2]; // 'bottom'
  }
}

/**
 * For every link, picks the box side (on each end) closest to the other
 * endpoint, then fans out multiple links sharing the same node+side across
 * that edge (rather than letting them converge on the exact same point),
 * sorted by the other endpoint's position so crossings are minimized.
 * Recomputed whenever node positions change (layout, reset, or drag) so
 * edges stay attached to whichever side currently faces their counterpart.
 */
function assignPorts() {
  links.forEach((link) => {
    const s = nodesById.get(link.sourceId);
    const t = nodesById.get(link.targetId);
    link.sourceSide = s && t ? computeSide(s, t.x, t.y) : null;
    link.targetSide = s && t ? computeSide(t, s.x, s.y) : null;
  });

  const groups = new Map(); // "nodeId|side|dir" -> [{ link, isSource }]
  function addTo(nodeId, side, dir, entry) {
    const k = nodeId + '|' + side + '|' + dir;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(entry);
  }
  links.forEach((link) => {
    if (link.sourceSide) addTo(link.sourceId, link.sourceSide, 'out', { link, isSource: true });
    if (link.targetSide) addTo(link.targetId, link.targetSide, 'in', { link, isSource: false });
  });

  for (const [key, entries] of groups) {
    const [nodeId, side] = key.split('|');
    const node = nodesById.get(nodeId);
    if (!node) continue;
    const horizontal = side === 'left' || side === 'right';
    const span = (horizontal ? node.h : node.w) * 0.7;
    const otherOf = (e) => nodesById.get(e.isSource ? e.link.targetId : e.link.sourceId);
    entries.sort((a, b) => {
      const oa = otherOf(a), ob = otherOf(b);
      const ca = oa ? (horizontal ? oa.y : oa.x) : 0;
      const cb = ob ? (horizontal ? ob.y : ob.x) : 0;
      return ca - cb;
    });
    const count = entries.length;
    entries.forEach((entry, i) => {
      const frac = count === 1 ? 0.5 : i / (count - 1);
      const offset = (frac - 0.5) * span;
      if (entry.isSource) entry.link.sourceOffset = offset;
      else entry.link.targetOffset = offset;
    });
  }
}

/**
 * Runs the d3-dag Sugiyama layered layout for the current orientation and
 * (re)builds nodesById / links with fresh {x, y} coordinates. Any manual
 * drag positions are discarded (used on init and "Reset layout").
 */
/**
 * Computes the total polyline length and the number of pairwise segment
 * crossings for a candidate layout's links (evaluated in raw sugiyama
 * coordinate space, before edges are snapped to box borders) — used to
 * score candidate layouts against each other. Segments belonging to links
 * that share an endpoint node aren't counted as "crossing" each other,
 * since they legitimately meet at that shared box.
 */
function scoreCandidate(candidateLinks) {
  let totalLength = 0;
  const segments = [];
  for (const link of candidateLinks) {
    const pts = link.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      totalLength += Math.hypot(x2 - x1, y2 - y1);
      segments.push({ a: pts[i], b: pts[i + 1], link });
    }
  }
  function ccw(A, B, C) { return (C[1] - A[1]) * (B[0] - A[0]) > (B[1] - A[1]) * (C[0] - A[0]); }
  function intersects(a, b, c, d) {
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
  }
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    const s1 = segments[i];
    for (let j = i + 1; j < segments.length; j++) {
      const s2 = segments[j];
      if (s1.link === s2.link) continue;
      if (
        s1.link.sourceId === s2.link.sourceId || s1.link.sourceId === s2.link.targetId ||
        s1.link.targetId === s2.link.sourceId || s1.link.targetId === s2.link.targetId
      ) continue;
      if (intersects(s1.a, s1.b, s2.a, s2.b)) crossings++;
    }
  }
  // Crossings dominate the score (readability suffers far more from a
  // crossing than from moderately longer edges); total length only breaks
  // ties between candidates with an equal (usually zero) crossing count.
  return { crossings, totalLength, score: crossings * 1e6 + totalLength };
}

/**
 * Runs one full sugiyama layout attempt with the given layering/decross/
 * coord algorithms and returns { nodesById, links, width, height, metrics }
 * in screen space (orientation already applied), or null if this
 * combination throws (e.g. an exact algorithm refusing a too-large input).
 */
function layoutAttempt(dagNodes, layeringAlgo, decrossAlgo, coordAlgo) {
  try {
    const stratify = d3.graphStratify();
    const dag = stratify(dagNodes);
    const nodeSize = (node) => {
      const [w, h] = estimateBoxSize(node.data.id);
      return orientation === 'LR' ? [h, w] : [w, h];
    };
    const layout = d3.sugiyama()
      .layering(layeringAlgo)
      .decross(decrossAlgo)
      .coord(coordAlgo)
      .nodeSize(nodeSize)
      .gap([40, 90]);

    const { width, height } = layout(dag);

    const candidateNodesById = new Map();
    for (const node of dag.nodes()) {
      const [bw, bh] = estimateBoxSize(node.data.id);
      let x = node.x;
      let y = node.y;
      if (orientation === 'LR') { const t = x; x = y; y = t; }
      candidateNodesById.set(node.data.id, {
        id: node.data.id, external: !!node.data.external, command: node.data.command,
        x, y, w: bw, h: bh, moved: false,
      });
    }

    const candidateLinks = [];
    for (const link of dag.links()) {
      const points = link.points.map(([px, py]) => orientation === 'LR' ? [py, px] : [px, py]);
      points.reverse();
      candidateLinks.push({ sourceId: link.target.data.id, targetId: link.source.data.id, points, sourceOffset: 0, targetOffset: 0 });
    }

    return {
      nodesById: candidateNodesById,
      links: candidateLinks,
      width: orientation === 'LR' ? height : width,
      height: orientation === 'LR' ? width : height,
      metrics: scoreCandidate(candidateLinks),
    };
  } catch (_err) {
    return null;
  }
}

/**
 * Runs the d3-dag Sugiyama layered layout for the current orientation and
 * (re)builds nodesById / links with fresh {x, y} coordinates. Any manual
 * drag positions are discarded (used on init and "Reset layout").
 *
 * Since exact minimization of crossings (NP-hard) and joint crossing+length
 * optimization has no efficient exact solution, this tries a handful of
 * different layering/decross/coordinate-assignment strategies — including
 * an exact per-two-layer optimizer where the graph is small enough for it
 * to be feasible — and keeps whichever produced the fewest edge crossings,
 * using total edge length as a tiebreaker.
 */
function computeLayout() {
  errorBanner.style.display = 'none';
  buildAdjacency();
  try {
    const layeringAlgo = d3.layeringSimplex();
    const candidates = [
      layoutAttempt(graphData.nodes, layeringAlgo, d3.decrossTwoLayer().passes(30), d3.coordSimplex()),
      layoutAttempt(graphData.nodes, layeringAlgo, d3.decrossTwoLayer().order(d3.twolayerGreedy()).passes(30), d3.coordSimplex()),
      layoutAttempt(graphData.nodes, layeringAlgo, d3.decrossTwoLayer().order(d3.twolayerOpt()).passes(10), d3.coordSimplex()),
      layoutAttempt(graphData.nodes, layeringAlgo, d3.decrossTwoLayer().passes(30), d3.coordQuad()),
    ].filter(Boolean);

    if (candidates.length === 0) throw new Error('all layout strategies failed');

    candidates.sort((a, b) => a.metrics.score - b.metrics.score);
    const best = candidates[0];

    nodesById = best.nodesById;
    links = best.links;
    layoutWidth = best.width;
    layoutHeight = best.height;
  } catch (err) {
    errorBanner.textContent = 'Could not compute an automatic layout (possible cycle among tasks): ' + err.message;
    errorBanner.style.display = 'block';
    // Fallback: place nodes in a simple grid so something is still visible.
    nodesById = new Map();
    const cols = Math.max(1, Math.ceil(Math.sqrt(graphData.nodes.length)));
    graphData.nodes.forEach((n, i) => {
      const [bw, bh] = estimateBoxSize(n.id);
      nodesById.set(n.id, {
        id: n.id, external: !!n.external, command: n.command,
        x: (i % cols) * 200 + 100, y: Math.floor(i / cols) * 120 + 80,
        w: bw, h: bh, moved: false,
      });
    });
    links = [];
    graphData.nodes.forEach((n) => {
      (n.parentIds || []).forEach((pid) => {
        const s = nodesById.get(pid), t = nodesById.get(n.id);
        // Same reversal as the main layout: arrow points from the task (n)
        // to the dependency (pid) it needs, meaning "depends on".
        if (s && t) links.push({ sourceId: n.id, targetId: pid, points: [[t.x, t.y], [s.x, s.y]], sourceOffset: 0, targetOffset: 0 });
      });
    });
    layoutWidth = cols * 200 + 200;
    layoutHeight = Math.ceil(graphData.nodes.length / cols) * 120 + 200;
  }
  assignPorts();
}

const lineGen = d3.line().x(d => d[0]).y(d => d[1]).curve(d3.curveCatmullRom.alpha(0.5));

function pathFor(link) {
  const pts = link.points.slice();
  const s = nodesById.get(link.sourceId);
  const t = nodesById.get(link.targetId);
  if (s && link.sourceSide) pts[0] = portPointForSide(s, link.sourceSide, link.sourceOffset || 0);
  if (t && link.targetSide) pts[pts.length - 1] = portPointForSide(t, link.targetSide, link.targetOffset || 0);
  return lineGen(pts);
}

function render() {
  const nodes = Array.from(nodesById.values());

  const linkSel = linkLayer.selectAll('path.link').data(links, d => d.sourceId + '->' + d.targetId);
  linkSel.exit().remove();
  linkSel.enter().append('path')
    .attr('class', 'link')
    .attr('marker-end', 'url(#arrow)')
    .merge(linkSel)
    .attr('d', pathFor);

  const nodeSel = nodeLayer.selectAll('g.node').data(nodes, d => d.id);
  nodeSel.exit().remove();
  const nodeEnter = nodeSel.enter().append('g').attr('class', 'node');
  nodeEnter.append('rect');
  nodeEnter.append('text');

  const nodeMerged = nodeEnter.merge(nodeSel);
  nodeMerged
    .classed('external', d => d.external)
    .classed('moved', d => d.moved)
    .attr('transform', d => \`translate(\${d.x - d.w / 2},\${d.y - d.h / 2})\`)
    .call(drag);

  nodeMerged.select('rect')
    .attr('width', d => d.w)
    .attr('height', d => d.h)
    .attr('rx', 6)
    .attr('ry', 6);

  nodeMerged.select('text')
    .attr('x', d => d.w / 2)
    .attr('y', d => d.h / 2)
    .text(d => d.id.length > 32 ? d.id.slice(0, 30) + '…' : d.id);

  nodeMerged.on('mouseenter', (event, d) => {
    const lines = [d.id];
    if (d.command) lines.push('command: ' + d.command);
    if (d.external) lines.push('(external / not defined in this package.json)');
    tooltip.style('opacity', 1).text(lines.join('\\n'));
    applyFocus(d.id);
  }).on('mousemove', (event) => {
    const [x, y] = d3.pointer(event, wrap);
    tooltip.style('left', (x + 16) + 'px').style('top', (y + 8) + 'px');
  }).on('mouseleave', () => {
    tooltip.style('opacity', 0);
    restoreBaseHighlight();
  }).on('dblclick', (event, d) => {
    event.preventDefault();
    event.stopPropagation();
    if (d.external) {
      showToast(\`"\${d.id}" is external — not defined in this package.json\`);
      return;
    }
    if (!LIVE) {
      showToast('Double-click-to-open requires "unwireit serve" mode');
      return;
    }
    fetch('/api/open?id=' + encodeURIComponent(d.id))
      .then((res) => res.json())
      .then((payload) => {
        if (payload.ok) {
          showToast(\`Opened "\${d.id}" at line \${payload.line}\`);
        } else {
          showToast('Could not open editor: ' + payload.error);
        }
      })
      .catch((err) => showToast('Could not open editor: ' + err.message));
  });

  applySearchHighlight();
}

/**
 * Declutters a busy graph on hover: dims every node/edge not connected to
 * \`id\`, and colors its upstream dependencies (amber) vs. downstream
 * dependents (purple) so the direction of the relationship is obvious even
 * when the base graph has many crossing edges.
 */
function applyFocus(id) {
  const upstream = collectReachable(id, parentsOf);
  const downstream = collectReachable(id, childrenOf);
  const involved = new Set([id, ...upstream, ...downstream]);

  nodeLayer.selectAll('g.node')
    .classed('dim', (d) => !involved.has(d.id))
    .classed('upstream', (d) => upstream.has(d.id))
    .classed('downstream', (d) => downstream.has(d.id))
    .classed('focus-origin', (d) => d.id === id);

  linkLayer.selectAll('path.link')
    .classed('active', (d) => involved.has(d.sourceId) && involved.has(d.targetId))
    .classed('dim', (d) => !(involved.has(d.sourceId) && involved.has(d.targetId)))
    .attr('marker-end', (d) => involved.has(d.sourceId) && involved.has(d.targetId) ? 'url(#arrow-active)' : 'url(#arrow)');
}

/**
 * Restores whatever the "resting" highlight state should be once a hover
 * ends: the active search's matches if a search is in progress, or a fully
 * neutral view otherwise.
 */
function restoreBaseHighlight() {
  nodeLayer.selectAll('g.node').classed('upstream', false).classed('downstream', false).classed('focus-origin', false);
  linkLayer.selectAll('path.link').classed('active', false).classed('dim', false).attr('marker-end', 'url(#arrow)');
  applySearchHighlight();
}

/**
 * Highlights nodes whose id matches the current search query (case
 * insensitive substring match) with a glowing ring, and dims the rest.
 * Clears all search styling when the query is empty.
 */
function applySearchHighlight() {
  const query = searchQuery;
  const active = query.length > 0;
  let matchCount = 0;

  nodeLayer.selectAll('g.node').each(function (d) {
    const isMatch = active && d.id.toLowerCase().includes(query);
    if (isMatch) matchCount += 1;
    d3.select(this).classed('search-match', isMatch).classed('dim', active && !isMatch);
  });

  const countEl = document.getElementById('search-count');
  if (countEl) countEl.textContent = active ? \`\${matchCount} match\${matchCount === 1 ? '' : 'es'}\` : '';
}

function clearFocus() {
  nodeLayer.selectAll('g.node').classed('dim', false).classed('upstream', false).classed('downstream', false).classed('focus-origin', false);
  linkLayer.selectAll('path.link').classed('active', false).classed('dim', false).attr('marker-end', 'url(#arrow)');
}

function updateAttachedLinks(nodeId) {
  // Dragging a node can change which side any of its links attach on (both
  // at this node and at the far end, since "closest side" depends on both
  // positions), so recompute port sides/fan offsets for all links, then
  // redraw only the ones actually touching the dragged node.
  assignPorts();
  linkLayer.selectAll('path.link')
    .attr('d', pathFor);
}

const drag = d3.drag()
  .on('start', function () {
    d3.select(this).raise();
  })
  .on('drag', function (event, d) {
    d.x = event.x;
    d.y = event.y;
    d.moved = true;
    d3.select(this).classed('moved', true)
      .attr('transform', \`translate(\${d.x - d.w / 2},\${d.y - d.h / 2})\`);
    updateAttachedLinks(d.id);
  });

function fitToView() {
  const { width: viewW, height: viewH } = wrap.getBoundingClientRect();
  const margin = 60;
  const scale = Math.min(1.5, Math.max(0.15, Math.min(
    (viewW - margin * 2) / Math.max(layoutWidth, 1),
    (viewH - margin * 2) / Math.max(layoutHeight, 1)
  )));
  const tx = (viewW - layoutWidth * scale) / 2;
  const ty = (viewH - layoutHeight * scale) / 2;
  svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

function relayout() {
  computeLayout();
  render();
  fitToView();
}

relayout();

document.getElementById('reset-layout').addEventListener('click', relayout);

document.getElementById('toggle-orientation').addEventListener('click', function () {
  orientation = orientation === 'LR' ? 'TB' : 'LR';
  this.textContent = orientation === 'LR' ? 'Switch to top-down' : 'Switch to left-right';
  relayout();
});

const searchWrap = document.getElementById('search-wrap');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');

function setSearchQuery(value) {
  searchInput.value = value;
  searchQuery = value.trim().toLowerCase();
  searchWrap.classList.toggle('has-query', searchQuery.length > 0);
  applySearchHighlight();
}

searchInput.addEventListener('input', () => setSearchQuery(searchInput.value));
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setSearchQuery('');
    searchInput.blur();
  }
});
searchClear.addEventListener('click', () => {
  setSearchQuery('');
  searchInput.focus();
});

window.addEventListener('resize', () => {
  // Keep current node positions; just refit the viewport.
  fitToView();
});

const toast = document.getElementById('toast');
let toastTimer = null;

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

if (LIVE) {
  const liveBadge = document.getElementById('live-badge');
  const sourceLabel = document.getElementById('source-label');

  /**
   * Fetches the latest graph from the server and re-renders, preserving
   * the on-screen position of any node the user has manually dragged
   * (matched by id) and keeping the current pan/zoom instead of
   * re-fitting the view.
   */
  function reloadGraph() {
    fetch('/api/graph', { cache: 'no-store' })
      .then((res) => res.json())
      .then((payload) => {
        if (payload.error) {
          errorBanner.textContent = payload.error;
          errorBanner.style.display = 'block';
          showToast('package.json changed, but has an error');
          return;
        }
        const preserved = new Map();
        for (const [id, n] of nodesById) {
          if (n.moved) preserved.set(id, { x: n.x, y: n.y });
        }
        graphData = payload.graph;
        meta = payload.meta;
        sourceLabel.textContent = meta.source;
        computeLayout();
        for (const [id, pos] of preserved) {
          const n = nodesById.get(id);
          if (n) { n.x = pos.x; n.y = pos.y; n.moved = true; }
        }
        render();
        showToast('Reloaded — package.json changed');
      })
      .catch((err) => {
        showToast('Failed to reload: ' + err.message);
      });
  }

  const events = new EventSource('/events');
  events.addEventListener('open', () => liveBadge.classList.remove('disconnected'));
  events.addEventListener('error', () => liveBadge.classList.add('disconnected'));
  events.addEventListener('message', (event) => {
    if (event.data === 'reload') reloadGraph();
  });
}
</script>
</body>
</html>
`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function openInBrowser(filePath) {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      execSync(`open "${filePath}"`);
    } else if (platform === 'win32') {
      execSync(`start "" "${filePath}"`);
    } else {
      execSync(`xdg-open "${filePath}"`);
    }
  } catch (err) {
    console.warn(`Could not auto-open browser: ${err.message}`);
  }
}

/**
 * Reads and parses the package.json fresh from disk, builds the graph,
 * and returns { graph, meta } — or throws with a descriptive message if
 * the file is missing/invalid or has no wireit tasks.
 */
function loadGraphFromDisk(inputPath) {
  const { pkg, resolved } = loadPackageJson(inputPath);
  if (!pkg.wireit || Object.keys(pkg.wireit).length === 0) {
    throw new Error(`No "wireit" tasks found in ${resolved}`);
  }
  return { graph: buildGraph(pkg), meta: { name: pkg.name, source: resolved } };
}

/**
 * Starts a local HTTP server that renders the live graph, and watches
 * the input package.json for changes, notifying connected browser tabs
 * over Server-Sent Events so they can refetch and re-render in place.
 */
function startServer(args) {
  const resolvedInput = path.resolve(process.cwd(), args.input);
  let current;
  try {
    current = loadGraphFromDisk(args.input);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const editorTemplate = resolveEditorTemplate(args.editor);
  if (!editorTemplate) {
    console.warn('Warning: no editor detected ($VISUAL/$EDITOR unset, and no known editor found on PATH). Double-click-to-open will not work; pass --editor "<cmd> {file}:{line}" to configure one.');
  }

  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtml(current.graph, current.meta, { live: true }));
    } else if (url.pathname === '/api/graph') {
      try {
        current = loadGraphFromDisk(args.input);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(current));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    } else if (url.pathname === '/api/open') {
      const taskId = url.searchParams.get('id') || '';
      try {
        if (!editorTemplate) {
          throw new Error('No editor configured (set $VISUAL/$EDITOR or pass --editor).');
        }
        const rawText = fs.readFileSync(resolvedInput, 'utf8');
        const offset = findWireitTaskOffset(rawText, taskId);
        const { line } = offsetToLineColumn(rawText, offset != null ? offset : 0);
        launchEditor(editorTemplate, resolvedInput, line);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, found: offset != null, line }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    } else if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(':ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  function broadcastReload() {
    for (const res of clients) {
      res.write('data: reload\n\n');
    }
  }

  // Watch the containing directory (not the file directly) since many
  // editors save by replacing the file (unlink + rename), which can
  // silently break a watch handle placed on the file itself.
  const watchDir = path.dirname(resolvedInput);
  const watchBase = path.basename(resolvedInput);
  let debounceTimer = null;
  fs.watch(watchDir, (eventType, filename) => {
    if (filename && filename !== watchBase) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`Detected change in ${resolvedInput} — reloading ${clients.size} connected client(s)...`);
      broadcastReload();
    }, 150);
  });

  // Bind to localhost only: this server can execute local editor commands
  // via /api/open, so it must not be reachable from other machines.
  server.listen(args.port, '127.0.0.1', () => {
    const url = `http://localhost:${args.port}/`;
    console.log(`Serving live wireit task graph at ${url}`);
    console.log(`Watching ${resolvedInput} for changes. Press Ctrl+C to stop.`);
    if (editorTemplate) console.log(`Double-click a node to open it in: ${editorTemplate}`);
    if (args.open) openInBrowser(url);
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'serve') {
    startServer(args);
    return;
  }

  let graph, meta;
  try {
    ({ graph, meta } = loadGraphFromDisk(args.input));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const html = renderHtml(graph, meta);

  const outPath = path.resolve(process.cwd(), args.output);
  fs.writeFileSync(outPath, html, 'utf8');
  const depCount = graph.nodes.reduce((sum, n) => sum + (n.parentIds ? n.parentIds.length : 0), 0);
  console.log(`Wrote graph (${graph.nodes.length} tasks, ${depCount} dependencies) to ${outPath}`);

  if (args.open) {
    openInBrowser(outPath);
  }
}

main();
