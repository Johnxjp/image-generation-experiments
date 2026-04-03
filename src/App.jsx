import { useState, useRef, useCallback, useEffect } from 'react'
import { generateDescription, generateSpectrumPrompts } from './genai'

// ── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0
const uid = () => `n${++_id}`

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y)
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

function countDots(distance) {
  if (distance < 100) return 0
  if (distance < 180) return 1
  if (distance < 280) return 2
  if (distance < 400) return 3
  if (distance < 540) return 4
  return 5
}

function mockColor(index, total) {
  const hue = 30 + (index / total) * 180
  return `hsl(${hue}, 55%, ${55 + index * 4}%)`
}

// ── Canvas coordinate transforms ─────────────────────────────────────────────

function screenToCanvas(sx, sy, pan, zoom) {
  return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }
}

// Reposition intermediates equidistantly along the anchor→endpoint line
function redistributeIntermediates(spectrum, nodesMap) {
  const anchor = nodesMap[spectrum.anchorId]
  const endpoint = nodesMap[spectrum.endpointId]
  if (!anchor || !endpoint) return nodesMap

  const next = { ...nodesMap }
  const count = spectrum.intermediateIds.length
  spectrum.intermediateIds.forEach((id, i) => {
    if (!next[id]) return
    const t = (i + 1) / (count + 1)
    next[id] = { ...next[id], pos: lerp(anchor.pos, endpoint.pos, t) }
  })
  return next
}

// ── Drop zone overlay ────────────────────────────────────────────────────────

function DropHint({ visible }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', pointerEvents: visible ? 'auto' : 'none',
      background: visible ? 'rgba(0,0,0,0.15)' : 'transparent',
      transition: 'background 0.2s', zIndex: 100,
    }}>
      <div style={{
        opacity: visible ? 1 : 0, transition: 'opacity 0.25s',
        border: '2px dashed var(--accent)', borderRadius: 16, padding: '48px 64px',
        color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 15,
        letterSpacing: 0.5,
      }}>
        Drop an image to begin
      </div>
    </div>
  )
}

// ── Image card ───────────────────────────────────────────────────────────────

const CARD_W = 200

function PromptButton({ node, onClick }) {
  const aspectRatio = node.image ? (node.naturalH / node.naturalW || 1) : 0.75
  const h = CARD_W * aspectRatio

  return (
    <div
      data-prompt-btn
      onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
      onClick={e => { e.stopPropagation(); onClick(e, node) }}
      style={{
        position: 'absolute',
        left: node.pos.x - CARD_W / 2 - 32,
        top: node.pos.y - h / 2,
        width: 24, height: 24, borderRadius: 4,
        background: 'var(--card-bg)',
        border: '1px solid var(--card-border)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', userSelect: 'none',
        boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
        opacity: 0.35,
        transition: 'border-color 0.15s, box-shadow 0.15s, opacity 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = 'var(--accent)'
        e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)'
        e.currentTarget.style.opacity = '1'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = 'var(--card-border)'
        e.currentTarget.style.boxShadow = '0 2px 6px rgba(0,0,0,0.08)'
        e.currentTarget.style.opacity = '0.35'
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <line x1="1" y1="2" x2="13" y2="2" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="1" y1="5.5" x2="13" y2="5.5" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="1" y1="9" x2="13" y2="9" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="1" y1="12.5" x2="9" y2="12.5" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  )
}

function ImageCard({ node, selected, onMouseDown, onClick }) {
  const isPlaceholder = !node.image && node.color
  const isLoading = node.loading
  const aspectRatio = node.image ? (node.naturalH / node.naturalW || 1) : 0.75
  const h = CARD_W * aspectRatio

  return (
    <div
      data-card
      onMouseDown={e => { e.stopPropagation(); onMouseDown(e, node) }}
      onClick={e => { e.stopPropagation(); onClick(e, node) }}
      style={{
        position: 'absolute',
        left: node.pos.x - CARD_W / 2,
        top: node.pos.y - h / 2,
        width: CARD_W,
        borderRadius: 6,
        border: selected
          ? '2px solid var(--selection)'
          : '1px solid var(--card-border)',
        background: isPlaceholder ? node.color : 'var(--card-bg)',
        overflow: 'hidden',
        cursor: 'pointer',
        opacity: node.ghosted ? 0.45 : 1,
        transition: 'opacity 0.3s, box-shadow 0.3s, border-color 0.15s',
        boxShadow: selected
          ? '0 0 0 3px var(--selection-glow), 0 4px 24px rgba(0,0,0,0.12)'
          : '0 4px 24px rgba(0,0,0,0.08)',
        userSelect: 'none',
      }}
    >
      {isLoading && (
        <div style={{
          width: CARD_W, height: CARD_W * 0.75, display: 'flex', alignItems: 'center',
          justifyContent: 'center',
        }}>
          <div style={{
            width: 24, height: 24, borderRadius: '50%',
            border: '2px solid var(--accent)', borderTopColor: 'transparent',
            animation: 'spin 0.8s linear infinite',
          }} />
        </div>
      )}
      {isPlaceholder && !isLoading && (
        <div style={{ width: CARD_W, height: h }} />
      )}
      {!node.image && !isPlaceholder && !isLoading && (
        <div style={{ width: CARD_W, height: h }} />
      )}
      {node.image && (
        <img
          src={node.image}
          draggable={false}
          style={{ width: '100%', display: 'block' }}
        />
      )}
    </div>
  )
}

// ── Plus button (appears on selected node) ──────────────────────────────────

function PlusButton({ node, onDragStart }) {
  const aspectRatio = node.image ? (node.naturalH / node.naturalW || 1) : 0.75
  const h = CARD_W * aspectRatio

  return (
    <div
      data-plus
      onMouseDown={e => { e.stopPropagation(); e.preventDefault(); onDragStart(e, node) }}
      style={{
        position: 'absolute',
        left: node.pos.x + CARD_W / 2 + 12,
        top: node.pos.y - 14,
        width: 28, height: 28, borderRadius: '50%',
        background: 'var(--accent)',
        color: '#fff', fontSize: 18, lineHeight: '28px', textAlign: 'center',
        cursor: 'grab', userSelect: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        transition: 'transform 0.15s',
      }}
      onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.15)'}
      onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
    >
      +
    </div>
  )
}

// ── Prompt side panel ────────────────────────────────────────────────────────

function PromptPanel({ node, onClose }) {
  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 340,
      background: 'var(--card-bg)', borderLeft: '1px solid var(--card-border)',
      zIndex: 200, display: 'flex', flexDirection: 'column',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '16px 20px', borderBottom: '1px solid var(--card-border)',
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500,
          color: 'var(--text-dim)', letterSpacing: 0.5, textTransform: 'uppercase',
        }}>
          Image Prompt
        </span>
        <div
          onClick={onClose}
          style={{
            width: 24, height: 24, borderRadius: 4, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-dim)', fontSize: 16, lineHeight: 1,
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.06)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          &times;
        </div>
      </div>
      <div style={{ padding: 20, flex: 1, overflowY: 'auto' }}>
        {node?.promptLoading && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: '50%',
              border: '2px solid var(--accent)', borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }} />
            Generating description...
          </div>
        )}
        {node?.prompt && !node.promptLoading && (
          <p style={{
            fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.7,
            color: 'var(--text)', margin: 0, whiteSpace: 'pre-wrap',
          }}>
            {node.prompt}
          </p>
        )}
        {!node?.prompt && !node?.promptLoading && (
          <p style={{
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
            margin: 0,
          }}>
            No prompt available for this image.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [nodes, setNodes] = useState({})
  const [spectrums, setSpectrums] = useState([])
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [dragging, setDragging] = useState(null)       // spectrum creation: { anchorId, current }
  const [moveDrag, setMoveDrag] = useState(null)        // moving node: { nodeId, lastMouse }
  const [inputFor, setInputFor] = useState(null)
  const [selected, setSelected] = useState(null)        // selected node id
  const [dropHover, setDropHover] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [generationTimers, setGenerationTimers] = useState([])
  const [generatingSpectrumIdx, setGeneratingSpectrumIdx] = useState(null)
  const [promptPanelOpen, setPromptPanelOpen] = useState(false)

  const containerRef = useRef(null)
  const panStart = useRef(null)
  const inputRef = useRef(null)
  const panRef = useRef(pan)
  const zoomRef = useRef(zoom)
  panRef.current = pan
  zoomRef.current = zoom

  const hasNodes = Object.keys(nodes).length > 0

  // ── File reading helper ──────────────────────────────────────────────────

  const readImageFile = useCallback((file) => {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const img = new Image()
        img.onload = () => resolve({ src: e.target.result, w: img.naturalWidth, h: img.naturalHeight })
        img.src = e.target.result
      }
      reader.readAsDataURL(file)
    })
  }, [])

  // ── Drop handling ────────────────────────────────────────────────────────

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    setDropHover(false)

    const file = e.dataTransfer?.files?.[0]
    if (!file || !file.type.startsWith('image/')) return

    const { src, w, h } = await readImageFile(file)
    const canvasPos = screenToCanvas(e.clientX, e.clientY, pan, zoom)
    const id = uid()

    setNodes(prev => ({
      ...prev,
      [id]: { id, pos: canvasPos, image: src, naturalW: w, naturalH: h, type: 'anchor', prompt: null, promptLoading: true },
    }))

    generateDescription(src).then(desc => {
      setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], prompt: desc, promptLoading: false } } : prev)
    })
  }, [pan, zoom, readImageFile])

  // ── Paste handling ───────────────────────────────────────────────────────

  useEffect(() => {
    const handlePaste = async (e) => {
      if (inputFor !== null) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          const { src, w, h } = await readImageFile(file)
          const canvasPos = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2, panRef.current, zoomRef.current)
          const id = uid()
          setNodes(prev => ({
            ...prev,
            [id]: { id, pos: canvasPos, image: src, naturalW: w, naturalH: h, type: 'anchor', prompt: null, promptLoading: true },
          }))
          generateDescription(src).then(desc => {
            setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], prompt: desc, promptLoading: false } } : prev)
          })
          break
        }
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [pan, zoom, readImageFile, inputFor])

  // ── Plus button drag to create spectrum ─────────────────────────────────

  const handleSpectrumDragStart = useCallback((e, node) => {
    if (!node.image && !node.color) return
    e.preventDefault()
    const canvasPos = screenToCanvas(e.clientX, e.clientY, pan, zoom)
    setDragging({ anchorId: node.id, current: canvasPos })
  }, [pan, zoom])

  // ── Image mousedown: start move drag ────────────────────────────────────

  const handleImageMouseDown = useCallback((e, node) => {
    setSelected(node.id)
    e.preventDefault()

    setMoveDrag({
      nodeId: node.id,
      lastMouse: screenToCanvas(e.clientX, e.clientY, pan, zoom),
    })
  }, [pan, zoom])

  // ── Image click: select ─────────────────────────────────────────────────

  const handleImageClick = useCallback((e, node) => {
    e.stopPropagation()
    setSelected(node.id)
  }, [])

  // ── Prompt button click ──────────────────────────────────────────────────

  const handlePromptClick = useCallback((e, node) => {
    e.stopPropagation()
    setSelected(node.id)
    setPromptPanelOpen(true)
  }, [])

  // ── Canvas click: deselect ──────────────────────────────────────────────

  const handleCanvasClick = useCallback((e) => {
    const isInteractive = e.target.closest('[data-card]') || e.target.closest('[data-plus]') || e.target.closest('[data-prompt-btn]')
    if (!isInteractive) {
      setSelected(null)
    }
  }, [])

  // ── Mouse move ───────────────────────────────────────────────────────────

  useEffect(() => {
    const handleMouseMove = (e) => {
      // Spectrum creation drag
      if (dragging) {
        const canvasPos = screenToCanvas(e.clientX, e.clientY, panRef.current, zoomRef.current)
        setDragging(prev => prev ? { ...prev, current: canvasPos } : null)
      }

      // Move drag — only the dragged node moves; intermediates redistribute
      if (moveDrag) {
        const canvasPos = screenToCanvas(e.clientX, e.clientY, panRef.current, zoomRef.current)
        const dx = canvasPos.x - moveDrag.lastMouse.x
        const dy = canvasPos.y - moveDrag.lastMouse.y
        setMoveDrag(prev => prev ? { ...prev, lastMouse: canvasPos } : null)

        setNodes(prev => {
          let next = { ...prev }
          const dragged = next[moveDrag.nodeId]
          if (!dragged) return prev

          // Move only the dragged node
          next[moveDrag.nodeId] = {
            ...dragged,
            pos: { x: dragged.pos.x + dx, y: dragged.pos.y + dy },
          }

          // If dragging an anchor or endpoint, redistribute intermediates along the line
          // If dragging an intermediate, it moves freely — line bends through it
          const draggedType = dragged.type
          if (draggedType === 'anchor' || draggedType === 'endpoint') {
            for (const s of spectrums) {
              if (s.anchorId === moveDrag.nodeId || s.endpointId === moveDrag.nodeId) {
                next = redistributeIntermediates(s, next)
              }
            }
          }

          return next
        })
      }

      // Pan
      if (panStart.current) {
        const dx = e.clientX - panStart.current.x
        const dy = e.clientY - panStart.current.y
        panStart.current = { x: e.clientX, y: e.clientY }
        setPan(prev => ({ x: prev.x + dx, y: prev.y + dy }))
      }
    }

    const handleMouseUp = (e) => {
      // Spectrum creation drag release
      if (dragging) {
        const anchorNode = nodes[dragging.anchorId]
        if (!anchorNode) { setDragging(null); return }

        const canvasPos = screenToCanvas(e.clientX, e.clientY, panRef.current, zoomRef.current)
        const d = dist(anchorNode.pos, canvasPos)
        const dotCount = countDots(d)

        if (dotCount === 0) {
          setDragging(null)
          return
        }

        const endId = uid()
        const intermediateIds = []
        const newNodes = {}

        for (let i = 1; i < dotCount; i++) {
          const t = i / dotCount
          const pos = lerp(anchorNode.pos, canvasPos, t)
          const id = uid()
          intermediateIds.push(id)
          newNodes[id] = {
            id, pos, image: null, color: null, loading: false,
            type: 'intermediate', naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
          }
        }

        newNodes[endId] = {
          id: endId, pos: canvasPos, image: null, color: '#e8e8ec', ghosted: true,
          type: 'endpoint', naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
        }

        setNodes(prev => ({ ...prev, ...newNodes }))

        const spectrumIndex = spectrums.length
        setSpectrums(prev => [...prev, {
          anchorId: dragging.anchorId,
          endpointId: endId,
          intermediateIds,
          dimension: null,
        }])

        setDragging(null)
        setSelected(null)
        setInputFor(spectrumIndex)
      }

      // End move drag
      if (moveDrag) {
        setMoveDrag(null)
      }

      // End pan
      if (panStart.current) {
        panStart.current = null
        setIsPanning(false)
      }
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, moveDrag, nodes, spectrums.length])

  // ── Auto-focus dimension input ───────────────────────────────────────────

  useEffect(() => {
    if (inputFor !== null && inputRef.current) {
      inputRef.current.focus()
    }
  }, [inputFor])

  // ── Esc key: cancel generation or deselect ──────────────────────────────

  const removeSpectrum = useCallback((spectrumIdx) => {
    const spectrum = spectrums[spectrumIdx]
    if (!spectrum) return
    const idsToRemove = [...spectrum.intermediateIds, spectrum.endpointId]
    setNodes(prev => {
      const next = { ...prev }
      idsToRemove.forEach(id => delete next[id])
      return next
    })
    setSpectrums(prev => prev.filter((_, i) => i !== spectrumIdx))
  }, [spectrums])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        // Cancel dimension input — remove the pending spectrum and its nodes
        if (inputFor !== null) {
          removeSpectrum(inputFor)
          setInputFor(null)
          return
        }

        // Cancel ongoing generation — remove the spectrum and its nodes
        if (generationTimers.length > 0) {
          generationTimers.forEach(t => clearTimeout(t))
          setGenerationTimers([])
          if (generatingSpectrumIdx !== null) {
            removeSpectrum(generatingSpectrumIdx)
            setGeneratingSpectrumIdx(null)
          }
          return
        }

        // Deselect
        setSelected(null)
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && inputFor === null) {
        e.preventDefault()
        const selNode = nodes[selected]
        if (!selNode) return

        if (selNode.type === 'intermediate') {
          // Splice this intermediate out of its spectrum — spectrum survives
          setNodes(prev => {
            const next = { ...prev }
            delete next[selected]
            return next
          })
          setSpectrums(prev => prev.map(s => {
            if (!s.intermediateIds.includes(selected)) return s
            return { ...s, intermediateIds: s.intermediateIds.filter(id => id !== selected) }
          }))
        } else {
          // Anchor or endpoint: dissolve all spectrums this node belongs to
          const affectedSpectrums = spectrums
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s.anchorId === selected || s.endpointId === selected)

          const toRemove = new Set([selected])
          for (const { s } of affectedSpectrums) {
            const spectrumNodeIds = [s.anchorId, ...s.intermediateIds, s.endpointId]
            for (const id of spectrumNodeIds) {
              if (id === selected) continue
              const node = nodes[id]
              if (node && !node.image && !node.color) toRemove.add(id)
            }
          }

          setNodes(prev => {
            const next = { ...prev }
            toRemove.forEach(id => delete next[id])
            return next
          })

          const affectedIndices = new Set(affectedSpectrums.map(({ i }) => i))
          setSpectrums(prev => prev.filter((_, i) => !affectedIndices.has(i)))
        }

        setSelected(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [inputFor, generationTimers, generatingSpectrumIdx, removeSpectrum, selected, spectrums, nodes])

  // ── Submit dimension → mock generation ───────────────────────────────────

  const handleDimensionSubmit = useCallback((e) => {
    e.preventDefault()
    const value = inputRef.current?.value?.trim()
    if (!value || inputFor === null) return

    const spectrum = spectrums[inputFor]
    if (!spectrum) return

    setSpectrums(prev => prev.map((s, i) =>
      i === inputFor ? { ...s, dimension: value } : s
    ))

    const allIds = [...spectrum.intermediateIds, spectrum.endpointId]
    setNodes(prev => {
      const next = { ...prev }
      allIds.forEach(id => {
        if (next[id]) next[id] = { ...next[id], loading: true, ghosted: false }
      })
      return next
    })

    const generatingIdx = inputFor
    setInputFor(null)
    setGeneratingSpectrumIdx(generatingIdx)

    const anchorNode = nodes[spectrum.anchorId]
    const description = anchorNode?.prompt || ''

    generateSpectrumPrompts(description, value, allIds.length).then(prompts => {
      setNodes(prev => {
        const next = { ...prev }
        allIds.forEach((id, i) => {
          if (!next[id]) return
          next[id] = {
            ...next[id],
            loading: false,
            prompt: prompts[i] || null,
            color: mockColor(i, allIds.length),
          }
        })
        return next
      })
      setGeneratingSpectrumIdx(null)
    }).catch(() => {
      // On error, stop loading state
      setNodes(prev => {
        const next = { ...prev }
        allIds.forEach(id => {
          if (next[id]) next[id] = { ...next[id], loading: false }
        })
        return next
      })
      setGeneratingSpectrumIdx(null)
    })
  }, [inputFor, spectrums, nodes])

  // ── Canvas pan (mouse down on empty space) ───────────────────────────────

  const handleCanvasMouseDown = useCallback((e) => {
    // Pan if clicking on empty canvas — not on an image card, button, or input
    const tag = e.target.tagName.toLowerCase()
    const isInteractive = e.target.closest('[data-card]') || e.target.closest('[data-plus]') || e.target.closest('[data-prompt-btn]') || tag === 'input'
    if (!isInteractive) {
      e.preventDefault()
      panStart.current = { x: e.clientX, y: e.clientY }
      setIsPanning(true)
    }
  }, [])

  // ── Zoom ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const handleWheel = (e) => {
      e.preventDefault()
      const scaleBy = 1.05
      const direction = e.deltaY < 0 ? 1 : -1
      const factor = direction > 0 ? scaleBy : 1 / scaleBy
      const newZoom = Math.min(3, Math.max(0.15, zoom * factor))

      const mx = e.clientX
      const my = e.clientY
      setPan(prev => ({
        x: mx - (mx - prev.x) * (newZoom / zoom),
        y: my - (my - prev.y) * (newZoom / zoom),
      }))
      setZoom(newZoom)
    }
    const el = containerRef.current
    if (el) el.addEventListener('wheel', handleWheel, { passive: false })
    return () => { if (el) el.removeEventListener('wheel', handleWheel) }
  }, [zoom])

  // ── Compute dragging preview ─────────────────────────────────────────────

  let dragPreview = null
  if (dragging) {
    const anchor = nodes[dragging.anchorId]
    if (anchor) {
      const d = dist(anchor.pos, dragging.current)
      const dotCount = countDots(d)
      const dots = []
      for (let i = 1; i <= dotCount; i++) {
        dots.push(lerp(anchor.pos, dragging.current, i / (dotCount + 1)))
      }
      dragPreview = { anchor: anchor.pos, endpoint: dragging.current, dots }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const selectedNode = selected ? nodes[selected] : null

  return (
    <div
      ref={containerRef}
      onMouseDown={handleCanvasMouseDown}
      onClick={handleCanvasClick}
      onDragOver={e => { e.preventDefault(); setDropHover(true) }}
      onDragLeave={() => setDropHover(false)}
      onDrop={handleDrop}
      style={{
        width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
        cursor: isPanning ? 'grabbing' : (dragging ? 'crosshair' : 'default'),
      }}
    >
      {/* Empty state / drop hint */}
      {!hasNodes && !dropHover && (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', pointerEvents: 'none',
        }}>
          <div style={{
            textAlign: 'center', fontFamily: 'var(--mono)', color: 'var(--text-dim)',
            fontSize: 14, lineHeight: 2,
          }}>
            <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>&#x2B21;</div>
            Drop an image to start<br />
            <span style={{ opacity: 0.5 }}>or paste from clipboard</span>
          </div>
        </div>
      )}

      <DropHint visible={dropHover} />

      {/* Transformed canvas layer */}
      <div style={{
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: '0 0',
        position: 'absolute', inset: 0, pointerEvents: 'none',
      }}>
        {/* SVG lines layer */}
        <svg style={{
          position: 'absolute', inset: '-10000px', width: '20000px', height: '20000px',
          overflow: 'visible', pointerEvents: 'none',
        }}>
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Existing spectrum lines */}
          {spectrums.map((s, i) => {
            const anchor = nodes[s.anchorId]
            const endpoint = nodes[s.endpointId]
            if (!anchor || !endpoint) return null

            // Build polyline points: anchor → intermediates → endpoint
            const allPoints = [
              anchor.pos,
              ...s.intermediateIds.map(id => nodes[id]?.pos).filter(Boolean),
              endpoint.pos,
            ]
            const pointsStr = allPoints.map(p => `${p.x + 10000},${p.y + 10000}`).join(' ')

            // Label at midpoint of the full path
            const mid = lerp(anchor.pos, endpoint.pos, 0.5)
            const angle = Math.atan2(
              endpoint.pos.y - anchor.pos.y,
              endpoint.pos.x - anchor.pos.x,
            ) * 180 / Math.PI

            return (
              <g key={i}>
                <polyline
                  points={pointsStr}
                  fill="none"
                  stroke="var(--line-color)" strokeWidth={1.5}
                  strokeLinejoin="round"
                />
                {s.dimension && (
                  <text
                    x={mid.x + 10000} y={mid.y + 10000 - 14}
                    textAnchor="middle"
                    fill="var(--text-dim)"
                    fontSize={12}
                    fontFamily="var(--mono)"
                    transform={`rotate(${Math.abs(angle) > 90 ? angle + 180 : angle}, ${mid.x + 10000}, ${mid.y + 10000 - 14})`}
                  >
                    {s.dimension} &rarr;
                  </text>
                )}
              </g>
            )
          })}

          {/* Drag preview line + dots */}
          {dragPreview && (
            <g>
              <line
                x1={dragPreview.anchor.x + 10000} y1={dragPreview.anchor.y + 10000}
                x2={dragPreview.endpoint.x + 10000} y2={dragPreview.endpoint.y + 10000}
                stroke="var(--line-color)" strokeWidth={1.5}
                strokeDasharray="6 4"
              />
              {dragPreview.dots.map((dot, i) => (
                <circle
                  key={i}
                  cx={dot.x + 10000} cy={dot.y + 10000}
                  r={5} fill="var(--dot-color)" filter="url(#glow)"
                  style={{
                    animation: `dotPop 0.25s ease-out ${i * 0.05}s both`,
                  }}
                />
              ))}
              <circle
                cx={dragPreview.endpoint.x + 10000} cy={dragPreview.endpoint.y + 10000}
                r={7} fill="none" stroke="var(--accent)" strokeWidth={1.5}
                opacity={0.5}
              />
            </g>
          )}
        </svg>

        {/* Image cards */}
        <div style={{ pointerEvents: 'auto' }}>
          {Object.values(nodes).map(node => (
            <ImageCard
              key={node.id}
              node={node}
              selected={selected === node.id}
              onMouseDown={handleImageMouseDown}
              onClick={handleImageClick}
            />
          ))}

          {/* Prompt button — only on selected image */}
          {selectedNode && selectedNode.image && (selectedNode.prompt || selectedNode.promptLoading) && (
            <PromptButton key={`pb-${selectedNode.id}`} node={selectedNode} onClick={handlePromptClick} />
          )}

          {/* Plus button on selected node */}
          {selectedNode && (selectedNode.image || selectedNode.color) && (
            <PlusButton node={selectedNode} onDragStart={handleSpectrumDragStart} />
          )}
        </div>

        {/* Dimension input */}
        {inputFor !== null && spectrums[inputFor] && (() => {
          const s = spectrums[inputFor]
          const endpoint = nodes[s.endpointId]
          if (!endpoint) return null
          return (
            <div style={{
              position: 'absolute',
              left: endpoint.pos.x + 120,
              top: endpoint.pos.y - 20,
              pointerEvents: 'auto',
            }}>
              <form onSubmit={handleDimensionSubmit}>
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Describe the dimension of change..."
                  style={{
                    width: 280, padding: '10px 14px',
                    background: 'var(--card-bg)', border: '1px solid var(--accent)',
                    borderRadius: 6, color: 'var(--text)', fontFamily: 'var(--mono)',
                    fontSize: 13, outline: 'none',
                    boxShadow: '0 0 16px var(--accent-glow)',
                  }}
                />
                <div style={{
                  marginTop: 6, fontSize: 11, color: 'var(--text-dim)',
                  fontFamily: 'var(--mono)',
                }}>
                  e.g. sweetness, seasons, time of day
                </div>
              </form>
            </div>
          )
        })()}
      </div>

      {/* Prompt side panel */}
      {promptPanelOpen && selectedNode && (
        <PromptPanel node={selectedNode} onClose={() => setPromptPanelOpen(false)} />
      )}

      {/* CSS keyframes */}
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes dotPop {
          from { r: 0; opacity: 0; }
          to { r: 5; opacity: 1; }
        }
      `}</style>
    </div>
  )
}
