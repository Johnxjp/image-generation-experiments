import { useState, useRef, useCallback, useEffect } from 'react'
import { generateDescription, generateSpectrumPrompts, uploadToFalCdn, generateImage, generateTransitionPrompt, generateInterpolationVideo, extractFramesFromVideo } from './genai'

// ── Helpers ──────────────────────────────────────────────────────────────────

let _copiedNode = null   // stashed node data from in-app copy
let _id = 0
const uid = () => `n${++_id}`

/** Ensure _id is above all existing node keys so uid() never collides. */
function syncIdCounter(nodes) {
  for (const key of Object.keys(nodes)) {
    const num = parseInt(key.slice(1), 10)
    if (num > _id) _id = num
  }
}

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

// ── Save / Load helpers ─────────────────────────────────────────────────────

function formatSaveTitle() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `canvas ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${String(now.getFullYear()).slice(2)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function getSaves() {
  try { return JSON.parse(localStorage.getItem('spectrum-saves') || '[]') }
  catch { return [] }
}

function storeSave(entry) {
  const saves = getSaves()
  saves.push(entry)
  localStorage.setItem('spectrum-saves', JSON.stringify(saves))
}

function deleteSave(id) {
  const saves = getSaves().filter(s => s.id !== id)
  localStorage.setItem('spectrum-saves', JSON.stringify(saves))
}

async function generateThumbnail(nodes, spectrums) {
  const THUMB_W = 800, THUMB_H = 600, PAD = 40
  const nodeList = Object.values(nodes)
  if (nodeList.length === 0) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const node of nodeList) {
    const ar = node.image ? (node.naturalH / node.naturalW || 1) : 0.75
    const h = CARD_W * ar
    minX = Math.min(minX, node.pos.x - CARD_W / 2)
    minY = Math.min(minY, node.pos.y - h / 2)
    maxX = Math.max(maxX, node.pos.x + CARD_W / 2)
    maxY = Math.max(maxY, node.pos.y + h / 2)
  }

  const cw = maxX - minX + PAD * 2
  const ch = maxY - minY + PAD * 2
  const scale = Math.min(THUMB_W / cw, THUMB_H / ch)

  const cvs = document.createElement('canvas')
  cvs.width = THUMB_W; cvs.height = THUMB_H
  const ctx = cvs.getContext('2d')

  // Background
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0e0e1a'
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, THUMB_W, THUMB_H)

  const ox = (THUMB_W - cw * scale) / 2 - minX * scale + PAD * scale
  const oy = (THUMB_H - ch * scale) / 2 - minY * scale + PAD * scale

  // Draw spectrum lines
  const lineColor = getComputedStyle(document.documentElement).getPropertyValue('--line-color').trim() || 'rgba(255,255,255,0.15)'
  ctx.strokeStyle = lineColor
  ctx.lineWidth = Math.max(1, 1.5 * scale)
  ctx.lineJoin = 'round'
  for (const s of spectrums) {
    const anchor = nodes[s.anchorId], endpoint = nodes[s.endpointId]
    if (!anchor || !endpoint) continue
    const pts = [anchor.pos, ...s.intermediateIds.map(id => nodes[id]?.pos).filter(Boolean), endpoint.pos]
    ctx.beginPath()
    pts.forEach((p, i) => {
      const x = p.x * scale + ox, y = p.y * scale + oy
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.stroke()
  }

  // Load images
  const loaded = await Promise.all(nodeList.map(node => {
    if (!node.image) return Promise.resolve({ node, img: null })
    return new Promise(resolve => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve({ node, img })
      img.onerror = () => resolve({ node, img: null })
      img.src = node.image
    })
  }))

  // Draw nodes
  for (const { node, img } of loaded) {
    const ar = node.image ? (node.naturalH / node.naturalW || 1) : 0.75
    const h = CARD_W * ar
    const x = (node.pos.x - CARD_W / 2) * scale + ox
    const y = (node.pos.y - h / 2) * scale + oy
    const w = CARD_W * scale, sh = h * scale

    // Rounded rect clip
    const r = 6 * scale
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, w, sh, r)
    ctx.clip()

    if (img) {
      ctx.drawImage(img, x, y, w, sh)
    } else if (node.color) {
      ctx.fillStyle = node.color
      ctx.fillRect(x, y, w, sh)
    }
    ctx.restore()

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(x, y, w, sh, r)
    ctx.stroke()
  }

  return cvs.toDataURL('image/png', 0.8)
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
      justifyContent: 'center', pointerEvents: 'none',
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

function findNodeAtPosition(pos, nodesMap, excludeId, excludeIds) {
  for (const node of Object.values(nodesMap)) {
    if (excludeIds ? excludeIds.has(node.id) : node.id === excludeId) continue
    if (!node.image || !node.falUrl) continue
    const ar = node.naturalH / node.naturalW || 1
    const h = CARD_W * ar
    const left = node.pos.x - CARD_W / 2
    const top = node.pos.y - h / 2
    if (pos.x >= left && pos.x <= left + CARD_W && pos.y >= top && pos.y <= top + h) {
      return node.id
    }
  }
  return null
}

function SideButton({ node, offsetIndex, dataAttr, onClick, children }) {
  const aspectRatio = node.image ? (node.naturalH / node.naturalW || 1) : 0.75
  const h = CARD_W * aspectRatio

  return (
    <div
      {...{ [dataAttr]: true }}
      onMouseDown={e => { e.stopPropagation(); e.preventDefault() }}
      onClick={e => { e.stopPropagation(); onClick(e, node) }}
      style={{
        position: 'absolute',
        left: node.pos.x - CARD_W / 2 - 32,
        top: node.pos.y - h / 2 + offsetIndex * 30,
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
      {children}
    </div>
  )
}

function PromptButton({ node, onClick }) {
  return (
    <SideButton node={node} offsetIndex={0} dataAttr="data-prompt-btn" onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <line x1="1" y1="2" x2="13" y2="2" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="1" y1="5.5" x2="13" y2="5.5" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="1" y1="9" x2="13" y2="9" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <line x1="1" y1="12.5" x2="9" y2="12.5" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </SideButton>
  )
}

function DownloadButton({ node, offsetIndex = 0, onClick }) {
  return (
    <SideButton node={node} offsetIndex={offsetIndex} dataAttr="data-download-btn" onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <line x1="7" y1="1" x2="7" y2="9.5" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
        <polyline points="3.5,7 7,10.5 10.5,7" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <line x1="2" y1="13" x2="12" y2="13" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </SideButton>
  )
}

function ImageCard({ node, selected, highlightAsTarget, onMouseDown, onClick }) {
  const isPlaceholder = !node.image && node.color
  const isLoading = node.loading
  const hasSourceImage = isLoading && node.sourceImage
  const aspectRatio = node.image
    ? (node.naturalH / node.naturalW || 1)
    : hasSourceImage
      ? (node.sourceNaturalH / node.sourceNaturalW || 1)
      : 0.75
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
        border: highlightAsTarget
          ? '2px solid var(--accent)'
          : selected
            ? '2px solid var(--selection)'
            : '1px solid var(--card-border)',
        background: isPlaceholder ? node.color : 'var(--card-bg)',
        overflow: 'hidden',
        cursor: 'pointer',
        opacity: node.ghosted ? 0.45 : 1,
        transition: 'opacity 0.3s, box-shadow 0.3s, border-color 0.15s',
        boxShadow: highlightAsTarget
          ? '0 0 0 4px var(--accent-glow), 0 4px 24px rgba(0,0,0,0.12)'
          : selected
            ? '0 0 0 3px var(--selection-glow), 0 4px 24px rgba(0,0,0,0.12)'
            : '0 4px 24px rgba(0,0,0,0.08)',
        userSelect: 'none',
      }}
    >
      {isLoading && (
        <div style={{
          width: CARD_W, height: hasSourceImage ? h : CARD_W * 0.75,
          position: 'relative',
        }}>
          {hasSourceImage && (
            <img
              src={node.sourceImage}
              draggable={false}
              style={{ width: '100%', display: 'block', opacity: 0.3 }}
            />
          )}
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              border: '2px solid var(--accent)', borderTopColor: 'transparent',
              animation: 'spin 0.8s linear infinite',
            }} />
          </div>
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

function PromptPanel({ node, dimension, onClose }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!node?.prompt) return
    navigator.clipboard.writeText(node.prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div data-prompt-panel style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 340,
      background: 'var(--card-bg)', borderLeft: '1px solid var(--card-border)',
      zIndex: 200, display: 'flex', flexDirection: 'column',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
    }}>
      {/* Close button pinned top-right */}
      <div style={{
        display: 'flex', justifyContent: 'flex-end',
        padding: '12px 16px 0',
      }}>
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
      <div style={{ padding: '8px 20px 20px', flex: 1, overflowY: 'auto' }}>
        {dimension && (
          <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--card-border)' }}>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 500,
              color: 'var(--text-dim)', letterSpacing: 0.5, textTransform: 'uppercase',
              marginBottom: 6,
            }}>
              Dimension
            </div>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)',
            }}>
              {dimension}
            </div>
          </div>
        )}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 12,
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 500,
            color: 'var(--text-dim)', letterSpacing: 0.5, textTransform: 'uppercase',
          }}>
            Image Prompt
          </span>
          {node?.prompt && !node.promptLoading && (
            <div
              onClick={handleCopy}
              style={{
                width: 24, height: 24, borderRadius: 4, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: copied ? 'var(--accent)' : 'var(--text-dim)',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,0,0,0.06)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              title="Copy to clipboard"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                {copied ? (
                  <path d="M3 7.5L5.5 10L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                ) : (
                  <>
                    <rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M10 4V2.5A1.5 1.5 0 008.5 1H2.5A1.5 1.5 0 001 2.5v6A1.5 1.5 0 002.5 10H4" stroke="currentColor" strokeWidth="1.3" />
                  </>
                )}
              </svg>
            </div>
          )}
        </div>
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
            userSelect: 'text', cursor: 'text',
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

// ── Saved boards modal ──────────────────────────────────────────────────────

function SavedBoardsModal({ onLoad, onClose, onImport }) {
  const [saves, setSaves] = useState(getSaves())
  const fileRef = useRef(null)

  const handleDelete = (e, id) => {
    e.stopPropagation()
    deleteSave(id)
    setSaves(getSaves())
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card-bg)', borderRadius: 12, padding: 24,
        maxWidth: 720, width: '90%', maxHeight: '80vh', overflow: 'auto',
        border: '1px solid var(--card-border)',
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: 20,
        }}>
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500, color: 'var(--text)',
          }}>Saved Canvases</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={() => fileRef.current?.click()} style={{
              padding: '6px 12px', borderRadius: 6, background: 'transparent',
              border: '1px solid var(--card-border)', color: 'var(--text)',
              fontFamily: 'var(--mono)', fontSize: 12, cursor: 'pointer',
            }}>Import JSON</button>
            <div onClick={onClose} style={{
              width: 24, height: 24, borderRadius: 4, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-dim)', fontSize: 18,
            }}>&times;</div>
          </div>
        </div>

        <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }}
          onChange={e => {
            const file = e.target.files?.[0]
            if (!file) return
            const reader = new FileReader()
            reader.onload = ev => {
              try { onImport(JSON.parse(ev.target.result)) } catch { /* invalid */ }
            }
            reader.readAsText(file)
            e.target.value = ''
          }}
        />

        {saves.length === 0 && (
          <p style={{
            fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
            textAlign: 'center', padding: 40, margin: 0,
          }}>No saved canvases yet. Use Import JSON to load a saved canvas.</p>
        )}

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16,
        }}>
          {saves.map(save => (
            <div key={save.id} onClick={() => onLoad(save)} style={{
              borderRadius: 8, border: '1px solid var(--card-border)',
              overflow: 'hidden', cursor: 'pointer', transition: 'border-color 0.15s',
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
              onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--card-border)'}
            >
              {save.thumbnail && (
                <img src={save.thumbnail} draggable={false}
                  style={{ width: '100%', display: 'block', aspectRatio: '4/3', objectFit: 'cover' }} />
              )}
              <div style={{ padding: '8px 10px' }}>
                <div style={{
                  fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', marginBottom: 4,
                }}>{save.title}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{
                    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
                  }}>{save.nodeCount ?? Object.keys(save.nodes || {}).length} nodes</span>
                  <div onClick={e => handleDelete(e, save.id)} style={{
                    fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer',
                    fontFamily: 'var(--mono)',
                  }}
                    onMouseEnter={e => e.currentTarget.style.color = '#e55'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
                  >delete</div>
                </div>
              </div>
            </div>
          ))}
        </div>
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
  const [dragging, setDragging] = useState(null)       // spectrum creation: { anchorIds, current }
  const [moveDrag, setMoveDrag] = useState(null)        // moving node: { lastMouse }
  const [pendingSpectrumIndices, setPendingSpectrumIndices] = useState(null) // array of spectrum indices awaiting dimension input
  const [pendingInputPos, setPendingInputPos] = useState(null) // canvas position for dimension input
  const [selected, setSelected] = useState(new Set())   // selected node ids
  const [dropHover, setDropHover] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [generationTimers, setGenerationTimers] = useState([])
  const [generatingSpectrumIndices, setGeneratingSpectrumIndices] = useState(null)
  const [promptPanelOpen, setPromptPanelOpen] = useState(false)
  const [showLoadModal, setShowLoadModal] = useState(false)
  const [hoverTargetId, setHoverTargetId] = useState(null)

  const containerRef = useRef(null)
  const panStart = useRef(null)
  const inputRef = useRef(null)
  const panRef = useRef(pan)
  const zoomRef = useRef(zoom)
  const nodesRef = useRef(nodes)
  const mousePosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  panRef.current = pan
  zoomRef.current = zoom
  nodesRef.current = nodes

  // Keep _id in sync with existing node keys (guards against HMR / module reload)
  useEffect(() => { syncIdCounter(nodes) }, [nodes])

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
    console.log('[drop] event fired')
    e.preventDefault()
    setDropHover(false)

    console.log('[drop] files:', e.dataTransfer?.files?.length, 'types:', [...(e.dataTransfer?.types || [])])
    let file = e.dataTransfer?.files?.[0]

    // Handle images dragged from browser (URL instead of file)
    if (!file || !file.type.startsWith('image/')) {
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
      if (url && /^https?:\/\/.+/i.test(url)) {
        console.log('[drop] fetching image from URL:', url)
        try {
          const resp = await fetch(url)
          const blob = await resp.blob()
          if (!blob.type.startsWith('image/')) { console.log('[drop] URL is not an image, type:', blob.type); return }
          file = new File([blob], 'dropped-image', { type: blob.type })
        } catch (err) {
          console.log('[drop] failed to fetch URL:', err)
          // Try extracting from HTML (e.g. <img src="...">)
          const html = e.dataTransfer.getData('text/html')
          const match = html?.match(/<img[^>]+src=["']([^"']+)["']/)
          if (match) {
            console.log('[drop] trying img src from HTML:', match[1])
            try {
              const resp = await fetch(match[1])
              const blob = await resp.blob()
              if (!blob.type.startsWith('image/')) { console.log('[drop] HTML img is not an image'); return }
              file = new File([blob], 'dropped-image', { type: blob.type })
            } catch (err2) { console.log('[drop] HTML img fetch also failed:', err2); return }
          } else { return }
        }
      } else {
        // Last resort: try HTML img src
        const html = e.dataTransfer.getData('text/html')
        const match = html?.match(/<img[^>]+src=["']([^"']+)["']/)
        if (match) {
          console.log('[drop] trying img src from HTML:', match[1])
          try {
            const resp = await fetch(match[1])
            const blob = await resp.blob()
            if (!blob.type.startsWith('image/')) { console.log('[drop] HTML img is not an image'); return }
            file = new File([blob], 'dropped-image', { type: blob.type })
          } catch (err) { console.log('[drop] HTML img fetch failed:', err); return }
        } else {
          console.log('[drop] no file or image URL found'); return
        }
      }
    }
    console.log('[drop] image file:', file.name, file.type, file.size)

    const { src, w, h } = await readImageFile(file)
    console.log('[drop] image loaded:', w, 'x', h)
    const canvasPos = screenToCanvas(e.clientX, e.clientY, pan, zoom)
    console.log('[drop] canvas position:', canvasPos)
    const id = uid()
    console.log('[image uploaded]', id)

    setNodes(prev => ({
      ...prev,
      [id]: { id, pos: canvasPos, image: src, naturalW: w, naturalH: h, type: 'anchor', prompt: null, promptLoading: true },
    }))

    console.log('[prompt requested]', id)
    generateDescription(src).then(desc => {
      console.log('[prompt generated]', id, desc)
      setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], prompt: desc, promptLoading: false } } : prev)
    })
    uploadToFalCdn(src).then(falUrl => {
      console.log('[fal cdn uploaded]', id, falUrl)
      setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], falUrl } } : prev)
    })
  }, [pan, zoom, readImageFile])

  // ── Paste handling ───────────────────────────────────────────────────────

  useEffect(() => {
    const handlePaste = async (e) => {
      if (pendingSpectrumIndices !== null) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          const { src, w, h } = await readImageFile(file)
          const canvasPos = screenToCanvas(mousePosRef.current.x, mousePosRef.current.y, panRef.current, zoomRef.current)
          const id = uid()
          const copied = _copiedNode
          _copiedNode = null
          console.log('[image uploaded]', id, copied ? '(from board copy)' : '(external)')
          if (copied?.prompt) {
            setNodes(prev => ({
              ...prev,
              [id]: { id, pos: canvasPos, image: src, naturalW: w, naturalH: h, type: 'anchor', prompt: copied.prompt, promptLoading: false, falUrl: copied.falUrl || null },
            }))
          } else {
            setNodes(prev => ({
              ...prev,
              [id]: { id, pos: canvasPos, image: src, naturalW: w, naturalH: h, type: 'anchor', prompt: null, promptLoading: true },
            }))
            generateDescription(src).then(desc => {
              console.log('[prompt generated]', id, desc)
              setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], prompt: desc, promptLoading: false } } : prev)
            })
          }
          uploadToFalCdn(src).then(falUrl => {
            console.log('[fal cdn uploaded]', id, falUrl)
            setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], falUrl } } : prev)
          })
          break
        }
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [pan, zoom, readImageFile, pendingSpectrumIndices])

  // ── Save board ───────────────────────────────────────────────────────────

  const saveBoard = useCallback(async () => {
    // Strip transient fields
    const cleanNodes = {}
    for (const [id, node] of Object.entries(nodes)) {
      cleanNodes[id] = { ...node, loading: false, promptLoading: false }
    }

    let thumbnail = null
    try { thumbnail = await generateThumbnail(cleanNodes, spectrums) }
    catch (err) { console.warn('Thumbnail generation failed:', err) }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const title = formatSaveTitle()
    const savedAt = new Date().toISOString()

    const fullEntry = {
      id, title, thumbnail,
      nodes: cleanNodes, spectrums, idCounter: _id,
      version: 1, savedAt,
    }

    // Download as JSON (full data with images)
    const blob = new Blob([JSON.stringify(fullEntry)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/[/:]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    // Save lightweight index entry to localStorage (no image data)
    const nodeCount = Object.keys(cleanNodes).length
    storeSave({ id, title, thumbnail, nodeCount, savedAt })
  }, [nodes, spectrums])

  // ── Load board ──────────────────────────────────────────────────────────

  const loadBoard = useCallback((data) => {
    if (!data?.nodes || !data?.spectrums || data.version !== 1) return

    setNodes(data.nodes)
    setSpectrums(data.spectrums.map(s => ({ ...s, type: s.type || 'dimension' })))
    if (data.idCounter != null) _id = data.idCounter

    // Clear transient state
    setSelected(new Set())
    setDragging(null)
    setMoveDrag(null)
    setPendingSpectrumIndices(null)
    setPendingInputPos(null)
    setPromptPanelOpen(false)
    setShowLoadModal(false)
    setGenerationTimers([])
    setGeneratingSpectrumIndices(null)

    // Center camera on last-created node (highest numeric id)
    const nodeList = Object.values(data.nodes)
    if (nodeList.length > 0) {
      const last = nodeList.reduce((best, n) => {
        const num = parseInt(n.id.slice(1), 10) || 0
        const bestNum = parseInt(best.id.slice(1), 10) || 0
        return num > bestNum ? n : best
      })
      setPan({
        x: window.innerWidth / 2 - last.pos.x,
        y: window.innerHeight / 2 - last.pos.y,
      })
      setZoom(1)
    }
  }, [])

  // ── Plus button drag to create spectrum ─────────────────────────────────

  const handleSpectrumDragStart = useCallback((e, node) => {
    if (!node.image && !node.color) return
    e.preventDefault()
    const canvasPos = screenToCanvas(e.clientX, e.clientY, pan, zoom)
    setDragging({ anchorIds: [...selected], current: canvasPos })
  }, [pan, zoom, selected])

  // ── Image mousedown: start move drag ────────────────────────────────────

  const handleImageMouseDown = useCallback((e, node) => {
    if (e.shiftKey) {
      // Shift: don't change selection here (let click handle toggle)
    } else if (!selected.has(node.id)) {
      setSelected(new Set([node.id]))
    }
    e.preventDefault()

    setMoveDrag({
      lastMouse: screenToCanvas(e.clientX, e.clientY, pan, zoom),
    })
  }, [pan, zoom, selected])

  // ── Image click: select ─────────────────────────────────────────────────

  const handleImageClick = useCallback((e, node) => {
    e.stopPropagation()
    if (e.shiftKey) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        return next
      })
    } else {
      setSelected(new Set([node.id]))
    }
  }, [])

  // ── Prompt button click ──────────────────────────────────────────────────

  const handlePromptClick = useCallback((e, node) => {
    e.stopPropagation()
    setSelected(new Set([node.id]))
    setPromptPanelOpen(true)
  }, [])

  // ── Download button click ───────────────────────────────────────────────

  const handleDownloadClick = useCallback(async (e, node) => {
    e.stopPropagation()
    if (!node.image) return
    const name = node.label || node.id
    const triggerDownload = (blob, ext) => {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name + ext
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
    if (node.image.startsWith('data:')) {
      const [meta, base64] = node.image.split(',')
      const mimeType = meta.match(/:(.*?);/)?.[1] ?? 'image/jpeg'
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const ext = mimeType === 'image/png' ? '.png' : '.jpg'
      triggerDownload(new Blob([bytes], { type: mimeType }), ext)
    } else {
      const res = await fetch(node.image, {
        headers: { Authorization: `Key ${import.meta.env.VITE_FAL_KEY}` },
      })
      const blob = await res.blob()
      const ext = blob.type === 'image/png' ? '.png' : '.jpg'
      triggerDownload(blob, ext)
    }
  }, [])

  // ── Canvas click: deselect ──────────────────────────────────────────────

  const handleCanvasClick = useCallback((e) => {
    const isInteractive = e.target.closest('[data-card]') || e.target.closest('[data-plus]') || e.target.closest('[data-prompt-btn]') || e.target.closest('[data-download-btn]') || e.target.closest('[data-prompt-panel]')
    if (!isInteractive) {
      setSelected(new Set())
    }
  }, [])

  // ── Interpolation generation pipeline ─────────────────────────────────────

  const startInterpolationGeneration = useCallback(async (anchorNode, targetNode, intermediateIds) => {
    try {
      console.log('[interpolation] generating transition prompt')
      const transitionPrompt = await generateTransitionPrompt(
        anchorNode.prompt || '',
        targetNode.prompt || ''
      )
      console.log('[interpolation] transition prompt:', transitionPrompt)

      console.log('[interpolation] generating video')
      const videoUrl = await generateInterpolationVideo(
        transitionPrompt,
        anchorNode.falUrl,
        targetNode.falUrl
      )
      console.log('[interpolation] video URL:', videoUrl)

      console.log('[interpolation] extracting frames')
      const frames = await extractFramesFromVideo(videoUrl, [1, 2, 3, 4])
      console.log('[interpolation] frames extracted:', frames.length)

      setNodes(prev => {
        const next = { ...prev }
        intermediateIds.forEach((id, i) => {
          if (!next[id] || !frames[i]) return
          next[id] = {
            ...next[id],
            loading: false,
            image: frames[i].dataUrl,
            naturalW: frames[i].width,
            naturalH: frames[i].height,
          }
        })
        return next
      })

      // Upload frames to FAL CDN in background
      intermediateIds.forEach(async (id, i) => {
        if (!frames[i]) return
        try {
          const falUrl = await uploadToFalCdn(frames[i].dataUrl)
          setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], falUrl } } : prev)
        } catch (err) {
          console.error(`[interpolation] CDN upload failed for ${id}`, err)
        }
      })
    } catch (err) {
      console.error('[interpolation] generation failed:', err)
      setNodes(prev => {
        const next = { ...prev }
        intermediateIds.forEach(id => {
          if (next[id]) next[id] = { ...next[id], loading: false }
        })
        return next
      })
    }
  }, [])

  // ── Mouse move ───────────────────────────────────────────────────────────

  useEffect(() => {
    const handleMouseMove = (e) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY }

      // Spectrum creation drag
      if (dragging) {
        const canvasPos = screenToCanvas(e.clientX, e.clientY, panRef.current, zoomRef.current)
        setDragging(prev => prev ? { ...prev, current: canvasPos } : null)
        const excludeSet = new Set(dragging.anchorIds)
        const hitId = findNodeAtPosition(canvasPos, nodesRef.current, null, excludeSet)
        setHoverTargetId(hitId)
      }

      // Move drag — move all selected nodes together
      if (moveDrag) {
        const canvasPos = screenToCanvas(e.clientX, e.clientY, panRef.current, zoomRef.current)
        const dx = canvasPos.x - moveDrag.lastMouse.x
        const dy = canvasPos.y - moveDrag.lastMouse.y
        setMoveDrag(prev => prev ? { ...prev, lastMouse: canvasPos } : null)

        setNodes(prev => {
          let next = { ...prev }
          const selectedIds = selected
          let anyMoved = false

          for (const nodeId of selectedIds) {
            const node = next[nodeId]
            if (!node) continue
            anyMoved = true
            next[nodeId] = {
              ...node,
              pos: { x: node.pos.x + dx, y: node.pos.y + dy },
            }
          }

          if (!anyMoved) return prev

          // Redistribute intermediates for any spectrum involving moved nodes
          for (const s of spectrums) {
            if (selectedIds.has(s.anchorId) || selectedIds.has(s.endpointId)) {
              next = redistributeIntermediates(s, next)
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
        const anchorIds = dragging.anchorIds
        const firstAnchor = nodes[anchorIds[0]]
        if (!firstAnchor) { setDragging(null); setHoverTargetId(null); return }

        // Interpolation: dropped on an existing node (only for single-anchor drags)
        const currentHoverTarget = hoverTargetId
        setHoverTargetId(null)

        if (currentHoverTarget && anchorIds.length === 1) {
          const anchorNode = firstAnchor
          const targetNode = nodes[currentHoverTarget]
          if (targetNode && targetNode.image && targetNode.falUrl && anchorNode.image && anchorNode.falUrl) {
            syncIdCounter(nodes)
            const intermediateIds = []
            const newNodes = {}
            for (let i = 1; i <= 4; i++) {
              const t = i / 5
              const pos = lerp(anchorNode.pos, targetNode.pos, t)
              const id = uid()
              intermediateIds.push(id)
              newNodes[id] = {
                id, pos, image: null, color: null, loading: true,
                type: 'intermediate', interpolation: true,
                naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
                sourceImage: anchorNode.image,
                sourceNaturalW: anchorNode.naturalW,
                sourceNaturalH: anchorNode.naturalH,
              }
            }

            setNodes(prev => ({ ...prev, ...newNodes }))
            setSpectrums(prev => [...prev, {
              anchorId: anchorIds[0],
              endpointId: currentHoverTarget,
              intermediateIds,
              dimension: null,
              type: 'interpolation',
            }])
            setDragging(null)
            setSelected(new Set())

            startInterpolationGeneration(anchorNode, targetNode, intermediateIds)
            return
          }
        }

        // Dimension spectrum: create one per selected anchor
        const canvasPos = screenToCanvas(e.clientX, e.clientY, panRef.current, zoomRef.current)

        // Check if any anchor is far enough
        let anyValid = false
        for (const aid of anchorIds) {
          const anchor = nodes[aid]
          if (anchor && countDots(dist(anchor.pos, canvasPos)) > 0) { anyValid = true; break }
        }

        if (!anyValid) {
          setDragging(null)
          return
        }

        syncIdCounter(nodes)
        const allNewNodes = {}
        const newSpectrums = []

        for (const anchorId of anchorIds) {
          const anchorNode = nodes[anchorId]
          if (!anchorNode) continue
          const d = dist(anchorNode.pos, canvasPos)
          const dotCount = countDots(d)
          if (dotCount === 0) continue

          const endId = uid()
          const intermediateIds = []

          for (let i = 1; i < dotCount; i++) {
            const t = i / dotCount
            const pos = lerp(anchorNode.pos, canvasPos, t)
            const id = uid()
            intermediateIds.push(id)
            allNewNodes[id] = {
              id, pos, image: null, color: null, loading: false,
              type: 'intermediate', naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
            }
          }

          allNewNodes[endId] = {
            id: endId, pos: canvasPos, image: null, color: '#e8e8ec', ghosted: true,
            type: 'endpoint', naturalW: anchorNode.naturalW, naturalH: anchorNode.naturalH,
          }

          newSpectrums.push({
            anchorId,
            endpointId: endId,
            intermediateIds,
            dimension: null,
            type: 'dimension',
          })
        }

        if (newSpectrums.length === 0) {
          setDragging(null)
          return
        }

        setNodes(prev => ({ ...prev, ...allNewNodes }))

        const baseIndex = spectrums.length
        const newIndices = newSpectrums.map((_, i) => baseIndex + i)
        console.log('[spectrum create multi]', { count: newSpectrums.length, baseIndex, newIndices })
        setSpectrums(prev => [...prev, ...newSpectrums])

        setDragging(null)
        setSelected(new Set())
        setPendingSpectrumIndices(newIndices)
        setPendingInputPos(canvasPos)
        console.log('[spectrum pendingSpectrumIndices set to]', newIndices)
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
  }, [dragging, moveDrag, nodes, spectrums, selected, hoverTargetId, startInterpolationGeneration])

  // ── Auto-focus dimension input ───────────────────────────────────────────

  useEffect(() => {
    if (pendingSpectrumIndices !== null && inputRef.current) {
      inputRef.current.focus()
    }
  }, [pendingSpectrumIndices])

  // ── Esc key: cancel generation or deselect ──────────────────────────────

  const removeSpectrum = useCallback((spectrumIdx) => {
    const spectrum = spectrums[spectrumIdx]
    if (!spectrum) return
    console.log('[spectrum REMOVE]', {
      spectrumIdx,
      anchor: spectrum.anchorId,
      end: spectrum.endpointId,
      removingNodes: [...spectrum.intermediateIds, spectrum.endpointId],
      allSpectrums: spectrums.map((s, i) => ({ i, anchor: s.anchorId, end: s.endpointId })),
    })
    console.trace('[spectrum REMOVE stack]')
    const idsToRemove = spectrum.type === 'interpolation'
      ? [...spectrum.intermediateIds]
      : [...spectrum.intermediateIds, spectrum.endpointId]
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
        // Cancel dimension input — remove all pending spectrums and their nodes
        if (pendingSpectrumIndices !== null) {
          console.log('[Escape] removing spectrums at pendingSpectrumIndices=', pendingSpectrumIndices)
          const indicesToRemove = new Set(pendingSpectrumIndices)
          const nodesToRemove = new Set()
          for (const idx of pendingSpectrumIndices) {
            const s = spectrums[idx]
            if (!s) continue
            s.intermediateIds.forEach(id => nodesToRemove.add(id))
            if (s.type !== 'interpolation') nodesToRemove.add(s.endpointId)
          }
          setNodes(prev => {
            const next = { ...prev }
            nodesToRemove.forEach(id => delete next[id])
            return next
          })
          setSpectrums(prev => prev.filter((_, i) => !indicesToRemove.has(i)))
          setPendingSpectrumIndices(null)
          setPendingInputPos(null)
          return
        }

        // Cancel ongoing generation — remove the spectrums and their nodes
        if (generationTimers.length > 0) {
          generationTimers.forEach(t => clearTimeout(t))
          setGenerationTimers([])
          if (generatingSpectrumIndices !== null) {
            const indicesToRemove = new Set(generatingSpectrumIndices)
            const nodesToRemove = new Set()
            for (const idx of generatingSpectrumIndices) {
              const s = spectrums[idx]
              if (!s) continue
              s.intermediateIds.forEach(id => nodesToRemove.add(id))
              if (s.type !== 'interpolation') nodesToRemove.add(s.endpointId)
            }
            setNodes(prev => {
              const next = { ...prev }
              nodesToRemove.forEach(id => delete next[id])
              return next
            })
            setSpectrums(prev => prev.filter((_, i) => !indicesToRemove.has(i)))
            setGeneratingSpectrumIndices(null)
          }
          return
        }

        // Deselect all
        setSelected(new Set())
      }

      // Copy selected node's image to clipboard (only when single node selected)
      if (e.key === 'c' && (e.metaKey || e.ctrlKey) && selected.size === 1 && pendingSpectrumIndices === null) {
        const selId = [...selected][0]
        const selNode = nodes[selId]
        if (selNode?.image) {
          e.preventDefault()
          _copiedNode = { prompt: selNode.prompt, falUrl: selNode.falUrl }
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            const cvs = document.createElement('canvas')
            cvs.width = img.naturalWidth
            cvs.height = img.naturalHeight
            cvs.getContext('2d').drawImage(img, 0, 0)
            cvs.toBlob(blob => {
              if (blob) navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
            }, 'image/png')
          }
          img.src = selNode.image
        }
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0 && pendingSpectrumIndices === null) {
        e.preventDefault()
        const toRemoveNodes = new Set()
        const affectedSpectrumIndices = new Set()

        for (const selId of selected) {
          const selNode = nodes[selId]
          if (!selNode) continue

          if (selNode.type === 'intermediate') {
            toRemoveNodes.add(selId)
          } else {
            toRemoveNodes.add(selId)
            const affected = spectrums
              .map((s, i) => ({ s, i }))
              .filter(({ s }) => s.anchorId === selId || s.endpointId === selId)

            for (const { s, i } of affected) {
              affectedSpectrumIndices.add(i)
              for (const id of s.intermediateIds) toRemoveNodes.add(id)
              if (s.type !== 'interpolation') {
                const otherEnd = s.anchorId === selId ? s.endpointId : s.anchorId
                const node = nodes[otherEnd]
                if (node && !node.image && !node.color) toRemoveNodes.add(otherEnd)
              }
            }
          }
        }

        setNodes(prev => {
          const next = { ...prev }
          toRemoveNodes.forEach(id => delete next[id])
          return next
        })

        // Remove affected spectrums, and also splice deleted intermediates out of surviving spectrums
        setSpectrums(prev => prev
          .filter((_, i) => !affectedSpectrumIndices.has(i))
          .map(s => {
            const filtered = s.intermediateIds.filter(id => !toRemoveNodes.has(id))
            return filtered.length === s.intermediateIds.length ? s : { ...s, intermediateIds: filtered }
          })
        )

        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pendingSpectrumIndices, generationTimers, generatingSpectrumIndices, removeSpectrum, selected, spectrums, nodes])

  // ── Submit dimension → mock generation ───────────────────────────────────

  const handleDimensionSubmit = useCallback((e) => {
    e.preventDefault()
    const value = inputRef.current?.value?.trim()
    if (!value || pendingSpectrumIndices === null) return

    const pendingIndices = pendingSpectrumIndices
    const pendingSpectrums = pendingIndices.map(i => spectrums[i]).filter(Boolean)
    if (pendingSpectrums.length === 0) return
    console.log('[dimension submit multi]', { pendingIndices, value })

    // Set dimension on all pending spectrums
    setSpectrums(prev => prev.map((s, i) =>
      pendingIndices.includes(i) ? { ...s, dimension: value } : s
    ))

    // Mark all nodes as loading
    setNodes(prev => {
      const next = { ...prev }
      for (const spectrum of pendingSpectrums) {
        const anchor = prev[spectrum.anchorId]
        const allIds = [...spectrum.intermediateIds, spectrum.endpointId]
        allIds.forEach(id => {
          if (next[id]) next[id] = {
            ...next[id], loading: true, ghosted: false,
            sourceImage: anchor?.image || null,
            sourceNaturalW: anchor?.naturalW,
            sourceNaturalH: anchor?.naturalH,
          }
        })
      }
      return next
    })

    setPendingSpectrumIndices(null)
    setPendingInputPos(null)
    setGeneratingSpectrumIndices(pendingIndices)

    // Generate for each spectrum in parallel
    for (const spectrum of pendingSpectrums) {
      const anchorNode = nodes[spectrum.anchorId]
      const description = anchorNode?.prompt || ''
      const falUrl = anchorNode?.falUrl
      const allIds = [...spectrum.intermediateIds, spectrum.endpointId]

      console.log('[spectrum prompt requested]', { anchor: spectrum.anchorId, dimension: value, steps: allIds.length })
      generateSpectrumPrompts(description, value, allIds.length).then(prompts => {
        console.log('[spectrum prompt generated]', { anchor: spectrum.anchorId, prompts })
        setNodes(prev => {
          const anchor = prev[spectrum.anchorId]
          const next = { ...prev }
          allIds.forEach((id, i) => {
            if (!next[id]) return
            next[id] = {
              ...next[id],
              prompt: prompts[i] || null,
              sourceImage: anchor?.image || null,
              sourceNaturalW: anchor?.naturalW,
              sourceNaturalH: anchor?.naturalH,
            }
          })
          return next
        })
        allIds.forEach((id, i) => {
          const prompt = prompts[i]
          if (!prompt || !falUrl) {
            setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], loading: false } } : prev)
            return
          }
          console.log(`[node ${id} generating image]`)
          generateImage(falUrl, prompt).then(imageUrl => {
            console.log(`[node ${id} image generated]`, imageUrl)
            setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], loading: false, image: imageUrl, falUrl: imageUrl } } : prev)
          }).catch(err => {
            console.error(`[node ${id} image error]`, err)
            setNodes(prev => prev[id] ? { ...prev, [id]: { ...prev[id], loading: false } } : prev)
          })
        })
      }).catch(() => {
        setNodes(prev => {
          const next = { ...prev }
          allIds.forEach(id => {
            if (next[id]) next[id] = { ...next[id], loading: false }
          })
          return next
        })
      })
    }
    setGeneratingSpectrumIndices(null)
  }, [pendingSpectrumIndices, spectrums, nodes])

  // ── Canvas pan (mouse down on empty space) ───────────────────────────────

  const handleCanvasMouseDown = useCallback((e) => {
    // Pan if clicking on empty canvas — not on an image card, button, or input
    const tag = e.target.tagName.toLowerCase()
    const isInteractive = e.target.closest('[data-card]') || e.target.closest('[data-plus]') || e.target.closest('[data-prompt-btn]') || e.target.closest('[data-download-btn]') || tag === 'input'
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

  let dragPreviews = []
  if (dragging) {
    const targetNode = hoverTargetId ? nodes[hoverTargetId] : null
    for (const anchorId of dragging.anchorIds) {
      const anchor = nodes[anchorId]
      if (!anchor) continue
      const endPoint = targetNode ? targetNode.pos : dragging.current
      const dotCount = targetNode ? 4 : countDots(dist(anchor.pos, dragging.current))
      const dots = []
      for (let i = 1; i <= dotCount; i++) {
        dots.push(lerp(anchor.pos, endPoint, i / (dotCount + 1)))
      }
      dragPreviews.push({ anchor: anchor.pos, endpoint: endPoint, dots, isInterpolation: !!targetNode })
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const selectedNodes = [...selected].map(id => nodes[id]).filter(Boolean)
  const singleSelectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null

  return (
    <div
      ref={containerRef}
      onMouseDown={handleCanvasMouseDown}
      onClick={handleCanvasClick}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropHover(true) }}
      onDragEnter={e => { e.preventDefault(); e.stopPropagation(); console.log('[dragenter] target:', e.target.tagName, e.target.className) }}
      onDragLeave={(e) => { console.log('[dragleave] target:', e.target.tagName); setDropHover(false) }}
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
              </g>
            )
          })}

          {/* Drag preview lines + dots */}
          {dragPreviews.map((dp, pi) => (
            <g key={`dp-${pi}`}>
              <line
                x1={dp.anchor.x + 10000} y1={dp.anchor.y + 10000}
                x2={dp.endpoint.x + 10000} y2={dp.endpoint.y + 10000}
                stroke="var(--line-color)" strokeWidth={1.5}
                strokeDasharray="6 4"
              />
              {dp.dots.map((dot, i) => (
                <circle
                  key={i}
                  cx={dot.x + 10000} cy={dot.y + 10000}
                  r={5} fill="var(--dot-color)" filter="url(#glow)"
                  style={{
                    animation: `dotPop 0.25s ease-out ${i * 0.05}s both`,
                  }}
                />
              ))}
              {!dp.isInterpolation && pi === 0 && (
                <circle
                  cx={dp.endpoint.x + 10000} cy={dp.endpoint.y + 10000}
                  r={7} fill="none" stroke="var(--accent)" strokeWidth={1.5}
                  opacity={0.5}
                />
              )}
            </g>
          ))}
        </svg>

        {/* Image cards */}
        <div style={{ pointerEvents: 'auto' }}>
          {Object.values(nodes).map(node => (
            <ImageCard
              key={node.id}
              node={node}
              selected={selected.has(node.id)}
              highlightAsTarget={hoverTargetId === node.id}
              onMouseDown={handleImageMouseDown}
              onClick={handleImageClick}
            />
          ))}

          {/* Prompt button — only on single selected image (not interpolation intermediates) */}
          {singleSelectedNode && singleSelectedNode.image && !singleSelectedNode.interpolation && (singleSelectedNode.prompt || singleSelectedNode.promptLoading) && (
            <PromptButton key={`pb-${singleSelectedNode.id}`} node={singleSelectedNode} onClick={handlePromptClick} />
          )}

          {/* Download button — only on single selected image */}
          {singleSelectedNode && singleSelectedNode.image && (
            <DownloadButton key={`dl-${singleSelectedNode.id}`} node={singleSelectedNode} offsetIndex={(singleSelectedNode.prompt || singleSelectedNode.promptLoading) ? 1 : 0} onClick={handleDownloadClick} />
          )}

          {/* Plus button on all selected nodes */}
          {selectedNodes
            .filter(n => n.image || n.color)
            .map(n => (
              <PlusButton key={`plus-${n.id}`} node={n} onDragStart={handleSpectrumDragStart} />
            ))
          }
        </div>

        {/* Dimension input */}
        {pendingSpectrumIndices !== null && pendingInputPos && (
          <div style={{
            position: 'absolute',
            left: pendingInputPos.x + 120,
            top: pendingInputPos.y - 20,
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
        )}
      </div>

      {/* Save / Load buttons */}
      <div style={{
        position: 'fixed', top: 16, left: 16, display: 'flex', gap: 6, zIndex: 50,
      }}>
        {hasNodes && (
          <div onClick={saveBoard} title="Save canvas" style={{
            width: 32, height: 32, borderRadius: 6, cursor: 'pointer',
            background: 'var(--card-bg)', border: '1px solid var(--card-border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-dim)', transition: 'border-color 0.15s, color 0.15s',
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--card-border)'; e.currentTarget.style.color = 'var(--text-dim)' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v9M3.5 6.5L7 10l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M1 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </div>
        )}
        <div onClick={() => setShowLoadModal(true)} title="Load canvas" style={{
          width: 32, height: 32, borderRadius: 6, cursor: 'pointer',
          background: 'var(--card-bg)', border: '1px solid var(--card-border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-dim)', transition: 'border-color 0.15s, color 0.15s',
        }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--text)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--card-border)'; e.currentTarget.style.color = 'var(--text-dim)' }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 3.5A1.5 1.5 0 012.5 2h3l1.5 1.5h4.5A1.5 1.5 0 0113 5v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 011 10.5z"
              stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      {/* Saved boards modal */}
      {showLoadModal && (
        <SavedBoardsModal
          onLoad={loadBoard}
          onClose={() => setShowLoadModal(false)}
          onImport={data => loadBoard(data)}
        />
      )}

      {/* Prompt side panel */}
      {promptPanelOpen && singleSelectedNode && (
        <PromptPanel node={singleSelectedNode} dimension={spectrums.find(s => s.anchorId === singleSelectedNode.id || s.endpointId === singleSelectedNode.id || s.intermediateIds?.includes(singleSelectedNode.id))?.dimension} onClose={() => setPromptPanelOpen(false)} />
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
