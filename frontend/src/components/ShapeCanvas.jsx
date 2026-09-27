import { useState, useRef, useEffect } from 'react'
import * as d3 from 'd3'

const SNAP_RADIUS = 14
const GRID_PX     = 24 // must match the .shape-canvas background-size pitch in App.css

export default function ShapeCanvas({
  points, closed, onAddPoint, onClose, containerRef, snapEnabled,
  onUndo, onRedo, canUndo, canRedo,
}) {
  const [cursor, setCursor] = useState(null)
  const [nearFirst, setNearFirst] = useState(false)
  const [transform, setTransform] = useState(d3.zoomIdentity)
  const [snapPoint, setSnapPoint] = useState(null)

  const svgElRef       = useRef(null)
  const transformRef    = useRef(transform)
  const zoomBehaviorRef = useRef(null)
  transformRef.current = transform

  // Scroll to zoom, drag to pan — attached once; click-to-place-a-point
  // still works because d3-drag only suppresses the click when an actual
  // drag occurred, not on a stationary click.
  useEffect(() => {
    if (!svgElRef.current) return
    const svgSel = d3.select(svgElRef.current)
    const zoomBehavior = d3.zoom()
      .scaleExtent([0.4, 8])
      .on('zoom', (event) => setTransform(event.transform))
    svgSel.call(zoomBehavior)
    zoomBehaviorRef.current = zoomBehavior
    return () => svgSel.on('.zoom', null)
  }, [])

  // Click/cursor coordinates are inverted through the current zoom transform
  // so points are always stored in the original (unzoomed) pixel space that
  // the FEM solve's canvasHeightPx/SHAPE_SCALE conversion expects.
  const getLocalPoint = (e) => {
    const rect = containerRef.current.getBoundingClientRect()
    return transformRef.current.invert([e.clientX - rect.left, e.clientY - rect.top])
  }

  // The grid pattern is a fixed-pitch CSS background painted in screen space
  // (unaffected by the zoom transform), so snapping rounds the cursor to the
  // nearest grid intersection in screen space first, then inverts that back
  // into local storage space — keeping the snapped dot visually on the grid.
  const getSnappedLocalPoint = (e) => {
    const rect = containerRef.current.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const snappedScreen = [Math.round(sx / GRID_PX) * GRID_PX, Math.round(sy / GRID_PX) * GRID_PX]
    return transformRef.current.invert(snappedScreen)
  }

  const handleClick = (e) => {
    if (closed) return
    const [x, y] = snapEnabled ? getSnappedLocalPoint(e) : getLocalPoint(e)
    if (points.length >= 3) {
      const [fx, fy] = points[0]
      if (Math.hypot(x - fx, y - fy) < SNAP_RADIUS) {
        onClose()
        return
      }
    }
    onAddPoint([x, y])
  }

  const handleDoubleClick = () => {
    if (closed || points.length < 3) return
    onClose()
  }

  // Cmd/Ctrl+Z undoes the last placed point, Cmd/Ctrl+Shift+Z redoes it.
  // Skipped while a form field has focus so native text-input undo (e.g.
  // editing the Force field) keeps working as expected.
  useEffect(() => {
    const isFormField = (el) => el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
    const onKeyDown = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      if (isFormField(document.activeElement)) return
      e.preventDefault()
      if (e.shiftKey) onRedo()
      else onUndo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onUndo, onRedo])

  const handleMouseMove = (e) => {
    if (closed) return
    const p = getLocalPoint(e)
    setCursor(p)
    const snapped = snapEnabled ? getSnappedLocalPoint(e) : null
    setSnapPoint(snapped)
    const effective = snapped || p
    if (points.length >= 3) {
      const [fx, fy] = points[0]
      setNearFirst(Math.hypot(effective[0] - fx, effective[1] - fy) < SNAP_RADIUS)
    }
  }

  const resetView = () => {
    if (!svgElRef.current || !zoomBehaviorRef.current) return
    d3.select(svgElRef.current)
      .transition().duration(300)
      .call(zoomBehaviorRef.current.transform, d3.zoomIdentity)
  }

  const polyStr = points.map((p) => p.join(',')).join(' ')

  return (
    <>
      <svg
        ref={svgElRef}
        className="shape-canvas"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => { setCursor(null); setSnapPoint(null) }}
      >
        <g transform={transform.toString()}>
          {closed ? (
            <polygon points={polyStr} className="shape-poly-closed" vectorEffect="non-scaling-stroke" />
          ) : (
            <>
              {points.length > 1 && (
                <polyline points={polyStr} className="shape-poly-open" vectorEffect="non-scaling-stroke" />
              )}
              {points.length > 0 && cursor && (
                <line
                  x1={points[points.length - 1][0]} y1={points[points.length - 1][1]}
                  x2={(snapPoint || cursor)[0]} y2={(snapPoint || cursor)[1]}
                  className="shape-rubber-band"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </>
          )}

          {points.length >= 3 && !closed && (
            <circle
              cx={points[0][0]} cy={points[0][1]} r={SNAP_RADIUS}
              className={`shape-snap-ring${nearFirst ? ' active' : ''}`}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {points.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={4} className="shape-point" vectorEffect="non-scaling-stroke" />
          ))}

          {snapEnabled && !closed && snapPoint && (
            <circle
              cx={snapPoint[0]} cy={snapPoint[1]} r={3.5}
              className="grid-snap-dot"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      </svg>

      {(points.length > 0 || canUndo || canRedo) && (
        <div className="shape-canvas-toolbar">
          <button
            className="shape-canvas-icon-btn"
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo last point (⌘Z)"
          >
            ↶
          </button>
          <button
            className="shape-canvas-icon-btn"
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (⌘⇧Z)"
          >
            ↷
          </button>
          <button className="shape-canvas-icon-btn" onClick={resetView} title="Reset zoom & pan">⤢</button>
        </div>
      )}
    </>
  )
}
