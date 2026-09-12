

https://github.com/user-attachments/assets/af8a63af-564b-4f0e-811d-54025d2fb9c5

# unwireit

A tiny CLI tool that reads a `package.json`, extracts its `wireit` task
configuration, and renders the task dependency graph as an interactive
**layered DAG (Sugiyama-style) layout** using D3.js + [d3-dag](https://github.com/erikbrinkman/d3-dag).

A build dependency graph is a directed acyclic graph with no meaningful
edge weights, so a layered/hierarchical layout (dependencies flow in one
direction, arranged in ranks) gives far more clarity than a force-directed
layout — no arbitrary clustering, no jitter, and dependency order is
readable at a glance.

## Installation

Use it without installing anything, via `npx`:

```bash
npx unwireit serve
```

Or add it as a dev dependency of the project whose `wireit` graph you
want to visualize:

```bash
npm install --save-dev unwireit
```

then run it via `npx`, or wire it into a `package.json` script:

```json
{
  "scripts": {
    "graph": "unwireit serve"
  }
}
```

Or install it globally so the `unwireit` command is always available:

```bash
npm install -g unwireit
```

Requires Node.js 16 or later.

## Usage

```bash
# Static export (default)
unwireit [path-to-package.json] [-o output.html] [--no-open]

# Live server: watches package.json and pushes updates to the browser
unwireit serve [path-to-package.json] [-p port] [--no-open] [--editor <cmd>]

# Terminal UI: searchable dependency explorer, no browser needed
unwireit tui [path-to-package.json] [--editor <cmd>]
```

(If you're running from a source checkout instead of an installed
package, substitute `node index.js` for `unwireit` in the examples
above.)

- Defaults to `./package.json` if no path is given.
- **Default mode** generates a self-contained HTML file (default
  `wireit-graph.html`) and opens it in your default browser (unless
  `--no-open` is passed).
- **`serve` mode** starts a local HTTP server (default port `5183`,
  bound to `127.0.0.1` only) and watches the package.json file on disk.
  When it changes, connected browser tabs are notified over
  Server-Sent Events, refetch the graph, and re-render — any nodes
  you've manually dragged keep their position across reloads, and the
  current pan/zoom is preserved. Press `Ctrl+C` to stop the server.
  - `--editor "<cmd>"` sets the command used to open a task's
    definition (see "Jump to source" below). Supports `{file}` and
    `{line}` placeholders, e.g. `--editor "code --goto {file}:{line}"`.
    If omitted, it's auto-detected from `$VISUAL`/`$EDITOR`, then by
    checking common editors on `PATH` (VS Code, Cursor, Sublime, Atom,
    JetBrains IDEs, vim/nvim/emacs/nano).
- **`tui` mode** renders an interactive dependency explorer directly in
  your terminal (see "Terminal UI" below) — useful for huge graphs
  where a 2D box-and-line drawing gets cluttered, or when you just
  don't want to leave the terminal.

## Terminal UI (`tui` mode)

A 2D drawing of a dependency graph gets hard to read well before a
terminal-sized text UI does — line crossings and box overlap get worse
with graph size, in a browser or otherwise. `tui` mode sidesteps that
entirely: instead of drawing the whole graph at once, it lets you
search the full task list and drill into **one task's immediate
neighborhood at a time** (its direct dependencies and dependents),
which stays equally readable whether the graph has 10 tasks or 1000.

```bash
unwireit tui
```

- **Type to search** — filters the current list by substring match, live.
- **↑ / ↓ / Page Up / Page Down** — move the selection; the detail
  panel below always shows the highlighted task's command, its direct
  dependencies, and what depends on it.
- **Enter** — drill into the highlighted task, replacing the list with
  just its dependencies (`deps:`) and dependents (`used-by:`). A
  breadcrumb trail at the top shows how you got there.
- **Backspace** — edits the search box; with an empty search box, it
  pops back up to the previous level instead.
- **Esc** — clears the current search box without changing level.
- **Ctrl+O** — opens the highlighted task's definition in your editor,
  at the exact line under `"wireit"` (same editor resolution as
  `serve` mode's `--editor` flag / `$VISUAL` / `$EDITOR` / PATH
  auto-detection). Not available for external tasks.
- **Ctrl+R** — re-reads `package.json` from disk and resets to the
  root task list (handy if you've been editing it in another window).
- **Ctrl+C** — quit.
- External/cross-package tasks (not defined in this `package.json`,
  e.g. `../other:build`) are shown dimmed with a hollow marker (`○`
  vs `●`) and can't be opened in an editor, but their dependents still
  show up when you drill into them.

## Features

- Nodes = wireit tasks, drawn as labeled boxes arranged in dependency
  layers. Orange boxes are external/cross-package tasks referenced only
  as a dependency (e.g. `../other:build`) and not defined locally.
- Arrows point from a task to the dependency it needs (i.e. "depends
  on" order). Exact joint minimization of crossings + edge length is
  NP-hard, so on load/reset/orientation-toggle the layout engine tries
  several layering/decrossing/coordinate-assignment strategies
  (including an exact optimal-crossing solver for the parts of the
  graph small enough for it to be tractable) and keeps whichever
  candidate has the fewest edge crossings, using total edge length as
  a tiebreaker.
- Edges attach to whichever side of a box (left/right/top/bottom) is
  actually closest to the other endpoint, fanning out multiple edges
  sharing a side, and stay attached correctly as you drag nodes.
- Default orientation is left-to-right; click "Switch to top-down" to
  flip to a vertical flowchart-style layout.
- **Drag a node to move it** anywhere for manual rearrangement/clarity —
  moved nodes get a white ring, and connected edges follow live as you
  drag. Click "Reset layout" to discard manual positions and recompute
  the automatic layered layout.
- Zoom/pan supported (mouse wheel + drag on empty canvas), with
  auto-fit-to-view on load and on layout changes.
- Hover a node to see its command in a tooltip; hovering also dims
  unrelated nodes/edges and colors upstream (amber) / downstream
  (purple) chains for decluttering large graphs, with smooth fade
  transitions.
- Search box in the header: matching nodes glow and everything else
  dims, with a live match count. Press `Escape` to clear.
- **Jump to source** (serve mode only): double-click a node to open
  `package.json` in your editor at the exact line where that task is
  *defined* under `"wireit"` — not its `"scripts"` entry. Requires an
  editor to be detected/configured (see `--editor` above); external
  nodes (not defined in this package.json) can't be opened.
- If the wireit config contains a dependency cycle, an error banner is
  shown and a simple grid fallback is rendered instead.

## Example

```bash
unwireit ./my-project/package.json -o graph.html
unwireit serve ./my-project/package.json -p 4000
unwireit tui ./my-project/package.json
```

## License

MIT © Søren Skovsbøll — see [LICENSE](./LICENSE).
