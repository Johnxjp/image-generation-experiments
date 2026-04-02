# Spectrum Canvas — Prototype Spec

## What This Is

An interactive canvas tool that lets users explore image variations along a user-defined dimension. The user drops a starter image, drags to create a spectrum of variations, and types a dimension (e.g. "sweetness", "seasons", "loneliness"). The system generates graded intermediate images that form a visual progression along that dimension.

This is an experiment / prototype. Prioritise feel and playfulness over polish.

## Core Interaction Flow

### 1. Canvas & Image Drop
- Full-screen dark canvas (think Figma/Miro infinite canvas vibes — minimal UI, the content is the interface)
- User drops an image onto the canvas (drag-and-drop from filesystem or paste)
- The image appears on the canvas as a card/thumbnail (e.g. ~200px wide) at the drop location
- The image is now the **anchor node**

### 2. Select & Move Images
- Clicking an image **selects** it (highlighted with a blue selection border + glow). It does NOT open a lightbox/enlarged view.
- Clicking empty canvas deselects
- Dragging a selected image **moves only that image**. The connecting line stretches and bends elastically:
  - **Anchor or endpoint drag**: intermediates redistribute equidistantly along the stretched line
  - **Intermediate drag**: the intermediate moves freely and the line **bends through it** (polyline through all nodes in order). This lets you reshape the spectrum layout.
- All node types (anchor, intermediate, endpoint) support: **select, move, delete, and create new spectrums** (via the "+" button, if the node has an image)
- Pressing Esc deselects

### 3. Drag to Create Spectrum (via Plus Button)
- When an image is selected, a circular **"+" button** appears to its right
- User clicks, holds and drags the "+" button to create a spectrum
- The source image stays in place — it does NOT move
- A line extends from the source toward the cursor
- A **light grey empty placeholder** appears at the cursor position as the **endpoint node** (indicating "this will become the extreme variation")
- As the line gets longer, **dots appear along the line** between source and endpoint, evenly spaced
  - These dots represent intermediate variation nodes
  - Number of dots scales with drag distance:
    - Short drag: 1 dot
    - Medium drag: 2-3 dots
    - Long drag: 4 dots
    - Maximum: 5 intermediate dots (so 7 total images including source + endpoint)
  - Dots should animate in smoothly as they appear (subtle pop/fade-in)
- The line and dots should feel elastic/alive — not rigid
- Direction of drag doesn't matter semantically (it's purely spatial layout)

### 4. Release & Dimension Input
- When the user releases the drag:
  - The line, dots, and endpoint lock in position
  - A text input field appears to the right of the endpoint node
  - Placeholder text: "Describe the dimension of change..."
  - The input auto-focuses so user can type immediately
  - Examples shown as subtle hint text below: e.g. "e.g. sweetness, seasons, time of day, love for Ferrari"

### 5. Submit Dimension → Generation
- User types a dimension and hits Enter
- The text input disappears
- A label appears along the line showing the dimension text (e.g. "sweetness →")
- Each dot and the endpoint node enter a **loading state**:
  - Subtle pulsing animation
  - Maybe a small spinner or shimmer effect
- In the real system, this is where API calls fire:
  1. Vision model describes the anchor image
  2. LLM generates N graded prompts (N = number of dots + 1 for endpoint)
  3. Image edit model generates each variation using anchor as source
- For the prototype: **mock the generation** — after a staggered delay (e.g. 1-2 seconds each, left to right), replace each dot with a placeholder image (can be coloured rectangles, or load from a preset array of test images if provided)
- Images fill in sequentially from anchor → endpoint to reinforce the progression feel

### 5b. Cancel Generation
- User can press **Esc** at any time during generation to cancel all pending image generations
- Cancelling removes the entire spectrum (endpoint, intermediates, and the line) — a clean undo
- Esc during the dimension input also removes the pending spectrum and its placeholder nodes

### 5c. Delete Node
- Select a node and press **Delete** or **Backspace** to remove it
- The deleted node and all spectrums it belongs to are removed
- Already-generated nodes (with an image or colour) from those spectrums are **kept** as standalone cards on the canvas
- Ungenerated/empty nodes from those spectrums are cleaned up

### 6. Interaction After Generation
- Once generated, each node (including intermediates) becomes a full image card on the canvas, **centred on its position along the line**
- User can click any image to **select** it (not enlarge)
- User can select any generated image and use its "+" button to create a NEW spectrum from it (same flow as step 3)
  - This creates a branching tree structure on the canvas
  - No cascading changes — each spectrum is independent
- User can also drop a completely new image onto an empty area of the canvas to start a separate spectrum

## Visual Design Direction

- **Aesthetic**: Clean, minimal, tool-like. Think creative dev tool, not consumer app.
- **Palette**: White canvas background. Dark grey/black for lines and text. Warm amber accent for interactive states. Blue for selection highlights.
- **Typography**: Monospace or semi-monospace for the dimension input and labels. Something like JetBrains Mono, IBM Plex Mono, or Space Mono.
- **Image cards**: Subtle rounded corners (4-8px), thin border or soft shadow to lift off canvas. No heavy frames. Cards are **centred on their node position** (both horizontally and vertically). Selected cards show a blue border and glow.
- **Lines**: Thin (1-2px), slightly translucent. The dots on the line should be small circles (8-12px) with a subtle glow or fill.
- **Animations**: Smooth and responsive. Dots appearing should feel organic. Loading shimmer should feel alive but not distracting.

## Canvas Behaviour

- Canvas should support pan (click + drag on empty space) and zoom (scroll wheel) so the user can navigate as spectrums branch and grow
- Keep it simple — no snapping, no grid, no alignment tools
- The canvas is infinite in all directions

## Data Model

### Node

Represents a single image card on the canvas.

```
Node {
  id: string               — unique identifier (e.g. "n1", "n2")
  pos: { x, y }            — position in canvas coordinates (centre of the card)
  type: 'anchor' | 'intermediate' | 'endpoint'
  image: string | null      — data URL of the image, or null if not yet generated
  color: string | null      — placeholder fill colour (used for mock-generated intermediates)
  naturalW: number          — original image width in pixels (for aspect ratio)
  naturalH: number          — original image height in pixels
  loading: boolean          — true while mock generation is in progress
  ghosted: boolean          — true for faded endpoint placeholders before generation
}
```

- **Anchor**: a user-dropped image or a previously generated image used as the starting point of a spectrum. Freely positionable.
- **Endpoint**: the far end of a spectrum line. Initially a light grey placeholder. Freely positionable. After generation, receives a mock image.
- **Intermediate**: sits on the line between anchor and endpoint. Initially positioned equidistantly and redistributed when anchor/endpoint are dragged. Can also be **freely dragged** to bend the line. Supports selection, deletion (spliced out of spectrum), moving, and creating new spectrums via the "+" button.

### Spectrum

Represents one line of image variations between two nodes.

```
Spectrum {
  anchorId: string          — id of the starting node
  endpointId: string        — id of the far-end node
  intermediateIds: string[] — ordered list of intermediate node ids (anchor→endpoint)
  dimension: string | null  — the user-typed dimension label (e.g. "sweetness"), null before submission
}
```

- A spectrum owns its intermediate nodes — they exist only as part of this spectrum.
- The anchor node is NOT owned by the spectrum (it may be shared with or originate from another spectrum).
- Cancelling a spectrum (Esc) deletes the endpoint and all intermediates, and removes the spectrum. The anchor is preserved.
- The number of intermediates is fixed at creation time based on drag distance (1–5). It does not change when the line is stretched.

### Canvas State

```
CanvasState {
  nodes: { [id]: Node }     — all nodes keyed by id
  spectrums: Spectrum[]      — all spectrums
  pan: { x, y }             — canvas translation offset in screen pixels
  zoom: number              — canvas scale factor (0.15–3.0)
  selected: string | null   — id of the currently selected node
}
```

### Relationships

```
                    Spectrum
                 ┌─────────────────────────────────────┐
                 │                                     │
              anchorId          intermediateIds       endpointId
                 │              │    │    │             │
                 ▼              ▼    ▼    ▼             ▼
               ┌───┐  ────── ┌───┐┌───┐┌───┐ ────── ┌───┐
               │ A │─────────│ I ││ I ││ I │─────────│ E │
               └───┘         └───┘└───┘└───┘         └───┘
                 │             equidistant on line
                 │
                 ├── Can be anchor of another spectrum (branching)
                 └── Can be an endpoint/intermediate promoted to anchor
```

- A node can be the anchor of multiple spectrums (branching).
- Dragging an anchor that belongs to multiple spectrums stretches all of them — intermediates in each spectrum redistribute independently.

## Technical Notes

- Build as a single-page React app (single .jsx file)
- Use HTML5 Canvas API or SVG for the lines/dots overlay, with DOM elements for the image cards and inputs
- For the prototype, image generation is mocked:
  - Accept image drop and display it
  - Mock the generation step with placeholder coloured rectangles or a predefined set of images
  - The API integration layer can be added later

## What's Out of Scope for V1

- Actual API integration (vision model, LLM, image generation)
- Undo/redo
- Saving/loading canvas state
- Bulk deleting nodes
- Resizing images
- Mobile support
- Any settings panel or toolbar
- Cascading changes (changing a parent doesn't update children)

## Success Criteria

The prototype is successful if:
1. Dropping an image and dragging to create a spectrum **feels good** — the interaction is smooth and responsive
2. The dots appearing along the line as you drag further gives clear feedback about how many variations you'll get
3. The dimension input flow doesn't break the spatial momentum
4. A non-technical person watching a 10-second demo would understand what the tool does
5. You can create branching spectrums (drag from a generated image) and the canvas stays navigable

## Reference Interactions

- **Figma**: Canvas pan/zoom, spatial layout of objects
- **Midjourney**: The feeling of kicking off a generation and watching results appear
- **tldraw**: Lightweight canvas interactions, drawing lines between objects
- **Runway ML**: Creative AI tool aesthetics

---

## Implementation Notes: Spectrum Creation Logic

This section documents how spectrum creation actually works in `src/App.jsx`, so new contributors can orient themselves quickly.

### Coordinate system

Everything lives in two coordinate spaces:

- **Screen space** — pixels relative to the browser viewport, from mouse events.
- **Canvas space** — the logical coordinate system that pan/zoom transforms are applied on top of.

All node positions (`node.pos`) are in canvas space. Mouse positions from events must be converted before use:

```js
function screenToCanvas(sx, sy, pan, zoom) {
  return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }
}
```

The canvas layer is a DOM div with `transform: translate(${pan.x}px, ${pan.y}px) scale(${zoom})` and `transformOrigin: '0 0'`. Nodes are positioned absolutely inside it using canvas coordinates, so they naturally follow pan and zoom.

The SVG overlay lives inside the same transformed div. Its viewport is `20000×20000px` positioned at `inset: -10000px` — a large enough surface so lines drawn between any two canvas-space points are always visible. Node positions are offset by `+10000` when rendering into the SVG to account for this.

---

### Phase 1 — Drag to preview (`dragging` state)

When the user presses down on the **"+" button** next to a selected node, `handleSpectrumDragStart` fires:

```js
const handleSpectrumDragStart = (e, node) => {
  if (!node.image && !node.color) return  // only nodes with content can start a spectrum
  const canvasPos = screenToCanvas(e.clientX, e.clientY, pan, zoom)
  setDragging({ anchorId: node.id, current: canvasPos })
}
```

`dragging` is `{ anchorId, current }` — just enough to draw the live preview. As the mouse moves, `current` updates on every `mousemove` event.

Each render frame the component computes `dragPreview` from `dragging`:

```js
let dragPreview = null
if (dragging) {
  const anchor = nodes[dragging.anchorId]
  const d = dist(anchor.pos, dragging.current)
  const dotCount = countDots(d)
  const dots = []
  for (let i = 1; i <= dotCount; i++) {
    dots.push(lerp(anchor.pos, dragging.current, i / (dotCount + 1)))
  }
  dragPreview = { anchor: anchor.pos, endpoint: dragging.current, dots }
}
```

`dragPreview` is a pure derivation — nothing is written to `nodes` or `spectrums` yet. This keeps the drag phase lightweight and fully reversible (abandoning the drag before release leaves no state behind).

**How intermediate count scales with distance** — `countDots` maps canvas-space pixel distance to a dot count (0–5):

```js
function countDots(distance) {
  if (distance < 100) return 0
  if (distance < 180) return 1
  if (distance < 280) return 2
  if (distance < 400) return 3
  if (distance < 540) return 4
  return 5
}
```

Dot positions are evenly spaced along the anchor→cursor line using linear interpolation: `lerp(anchor, endpoint, i / (count + 1))` for `i = 1..count`. The SVG renders them with a `dotPop` CSS keyframe animation (`r: 0 → 5, opacity: 0 → 1`) staggered by 50ms per dot.

If the drag distance is less than 100px, `dotCount` is 0 and releasing creates nothing.

---

### Phase 2 — Release to commit (`mouseup`)

On `mouseup`, the dragging state is consumed and converted into permanent React state:

```js
const endId = uid()
const intermediateIds = []
const newNodes = {}

// Create one intermediate node per dot, equidistant along the line
for (let i = 1; i <= dotCount; i++) {
  const t = i / (dotCount + 1)
  const pos = lerp(anchorNode.pos, canvasPos, t)
  const id = uid()
  intermediateIds.push(id)
  newNodes[id] = {
    id, pos, image: null, color: null, loading: false,
    type: 'intermediate', naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
  }
}

// Create the endpoint (ghosted grey placeholder)
newNodes[endId] = {
  id: endId, pos: canvasPos, image: null, color: '#e8e8ec', ghosted: true,
  type: 'endpoint', naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
}

setNodes(prev => ({ ...prev, ...newNodes }))
setSpectrums(prev => [...prev, {
  anchorId: dragging.anchorId,
  endpointId: endId,
  intermediateIds,
  dimension: null,
}])

setInputFor(spectrums.length)  // the new spectrum's index — triggers dimension input
```

Key points:
- `intermediateIds` preserves insertion order (anchor→endpoint direction), which matters for rendering the polyline and for the generation stagger sequence.
- The endpoint gets `ghosted: true` (rendered at 45% opacity) to signal "this is a pending placeholder, not generated content".
- `naturalW`/`naturalH` are copied from the anchor so placeholder cards maintain the same aspect ratio as the source image.
- The intermediate count is fixed at this moment. It does not change when the user later stretches the line.

---

### Phase 3 — Dimension input (`inputFor` state)

`inputFor` holds the index of the spectrum currently awaiting a dimension label. The dimension input renders adjacent to the endpoint node:

```
left: endpoint.pos.x + 120,   // just to the right of the endpoint card
top:  endpoint.pos.y - 20,
```

The input auto-focuses via a `useEffect` that watches `inputFor`. Pressing **Enter** calls `handleDimensionSubmit`; pressing **Esc** calls `removeSpectrum(inputFor)`, which deletes the endpoint and all intermediates from `nodes` and splices the spectrum out of `spectrums`.

---

### Phase 4 — Mock generation (`handleDimensionSubmit`)

When the user submits a dimension string:

1. The spectrum's `dimension` field is set to the submitted value, causing the label to appear on the line.
2. All intermediate and endpoint nodes are set to `loading: true, ghosted: false` — they render a spinning indicator.
3. A `setTimeout` is scheduled for each node with a staggered delay (`800 + i * 600` ms), filling left-to-right:

```js
const allIds = [...spectrum.intermediateIds, spectrum.endpointId]

const timers = allIds.map((id, i) => {
  return setTimeout(() => {
    setNodes(prev => {
      const total = allIds.length
      return {
        ...prev,
        [id]: {
          ...prev[id],
          loading: false,
          // Endpoint gets a copy of the anchor image; intermediates get mock colours
          image: i === total - 1 ? anchorNode?.image : null,
          color: i === total - 1 ? null : mockColor(i, total),
        },
      }
    })
  }, 800 + i * 600)
})

setGenerationTimers(timers)   // stored so Esc can cancel them
setGeneratingSpectrumIdx(...)  // stored so Esc knows which spectrum to remove
```

`mockColor` generates an HSL colour that shifts hue across the amber–teal range as `i` increases, giving visual variety. The endpoint receives a copy of the anchor's image to suggest a "completed" state.

Cancelling via **Esc** calls `clearTimeout` on every pending timer, then `removeSpectrum` to clean up all in-flight nodes.

---

### Redistribution of intermediates on drag

When the user drags an **anchor** or **endpoint** node, intermediates must stay evenly spaced along the updated line. This is handled in the `mousemove` handler after updating the dragged node's position:

```js
function redistributeIntermediates(spectrum, nodesMap) {
  const anchor = nodesMap[spectrum.anchorId]
  const endpoint = nodesMap[spectrum.endpointId]
  const count = spectrum.intermediateIds.length
  spectrum.intermediateIds.forEach((id, i) => {
    const t = (i + 1) / (count + 1)   // evenly spaced t-values: 1/N+1, 2/N+1, …
    nodesMap[id] = { ...nodesMap[id], pos: lerp(anchor.pos, endpoint.pos, t) }
  })
  return nodesMap
}
```

This runs inside the `setNodes` updater so it always operates on the latest state (including the already-updated dragged node position).

When an **intermediate** is dragged, redistribution is skipped. The intermediate moves freely and the polyline bends through it — the points array passed to `<polyline>` is `[anchor, ...intermediates, endpoint]` in order, so the visual line always passes through every node.

---

### State machine summary

```
User drops image
  → node created (type: 'anchor')

User drags "+" button
  → dragging = { anchorId, current }   [preview only, no node mutations]
  → dragPreview computed each render

User releases drag (distance ≥ 100px)
  → intermediate nodes created in nodes map
  → endpoint node created (ghosted)
  → spectrum appended to spectrums array
  → inputFor = spectrum index
  → dragging = null

User types dimension + Enter
  → spectrum.dimension set
  → nodes set to loading: true
  → generation timers scheduled
  → inputFor = null

Timers fire (left to right)
  → each node: loading: false, color/image set

Esc (any time after drag release)
  → pending timers cleared
  → spectrum + unresolved nodes removed
```