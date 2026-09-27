import { useState, useEffect, useCallback, useRef } from 'react'
import MeshViewer from './components/MeshViewer'
import Controls from './components/Controls'
import ShapeCanvas from './components/ShapeCanvas'
import ConvergenceModal from './components/ConvergenceModal'
import WelcomeModal from './components/WelcomeModal'

const API = 'http://localhost:8000'
const SHAPE_SCALE = 120 // px per meter, used when converting drawn points to FEM coordinates

export const PROBLEMS = {
  cantilever: {
    label: 'Cantilever',
    icon: '⊣',
    desc: 'Fixed left · tip load',
    defaults: { nx: 16, ny: 8, width: 2, height: 0.5, E: 200e9, nu: 0.3, load: -10000 },
  },
  simply_supported: {
    label: 'Simply Supp.',
    icon: '△',
    desc: 'Pin–roller · center load',
    defaults: { nx: 20, ny: 8, width: 3, height: 0.5, E: 200e9, nu: 0.3, load: -10000 },
  },
  fixed_fixed: {
    label: 'Fixed–Fixed',
    icon: '⊢⊣',
    desc: 'Both ends clamped · center load',
    defaults: { nx: 20, ny: 8, width: 2, height: 0.5, E: 200e9, nu: 0.3, load: -10000 },
  },
  plate_hole: {
    label: 'Plate + Hole',
    icon: '⊙',
    desc: 'Square plate · circular hole · tension',
    defaults: { nx: 30, ny: 30, width: 1, height: 1, E: 200e9, nu: 0.3, load: 100000 },
  },
  l_bracket: {
    label: 'L-Bracket',
    icon: '⌐',
    desc: 'Fixed top leg · shear at free end',
    defaults: { nx: 24, ny: 24, width: 1, height: 1, E: 200e9, nu: 0.3, load: -8000 },
  },
  t_beam: {
    label: 'T-Beam',
    icon: '⊤',
    desc: 'Pin–roller web supports · flange load',
    defaults: { nx: 28, ny: 18, width: 2, height: 1, E: 200e9, nu: 0.3, load: -20000 },
  },
  beam_hole: {
    label: 'Beam + Hole',
    icon: '⊕',
    desc: 'Cantilever · central stress concentrator',
    defaults: { nx: 24, ny: 12, width: 2, height: 0.5, E: 200e9, nu: 0.3, load: -10000 },
  },
}

export default function App() {
  const [mode, setMode]                   = useState('preset') // 'preset' | 'draw'
  const [problemType, setProblemType]     = useState('cantilever')
  const [params, setParams]               = useState(PROBLEMS.cantilever.defaults)
  const [meshData, setMeshData]           = useState(null)
  const [meshData2, setMeshData2]         = useState(null)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState(null)
  const [viewMode, setViewMode]           = useState('stress')
  const [dispScale, setDispScale]         = useState(500)
  const [loadType, setLoadType]           = useState('point')
  const [showOriginal, setShowOriginal]   = useState(false)
  const [yieldStrength, setYieldStrength] = useState('')
  const [compareMode, setCompareMode]     = useState(false)
  const [compareNx, setCompareNx]         = useState(8)
  const [compareNy, setCompareNy]         = useState(4)
  const [showVectors, setShowVectors]     = useState(false)
  const [vectorDensity, setVectorDensity] = useState(2)

  // Crack propagation state
  const [crackElemIdx, setCrackElemIdx]       = useState(null)
  const [crackMeshData, setCrackMeshData]     = useState(null)
  const [crackFailedElems, setCrackFailedElems] = useState(new Set())
  const [propSteps, setPropSteps]             = useState([])
  const [propStepIdx, setPropStepIdx]         = useState(-1)
  const [propSpeed, setPropSpeed]             = useState(400)
  const [propComputing, setPropComputing]     = useState(false)
  const [propPlaying, setPropPlaying]         = useState(false)
  const propAnimRef    = useRef(null)
  const propSpeedRef   = useRef(400)

  // Custom (click-to-place) loads — array of { node, fx, fy }. Shared between
  // preset and draw modes; cleared whenever the underlying mesh/geometry
  // changes since node indices are only valid for the mesh they were placed on.
  const [customLoads, setCustomLoads]     = useState([])

  const [showConvergence, setShowConvergence] = useState(false)

  // Draw Shape mode state
  const [shapePoints, setShapePoints]     = useState([])
  const [shapeClosed, setShapeClosed]     = useState(false)
  const [customMeshData, setCustomMeshData] = useState(null)
  const [customLoading, setCustomLoading] = useState(false)
  const [customError, setCustomError]     = useState(null)
  const [meshDensity, setMeshDensity]     = useState(16)
  const [snapToGrid, setSnapToGrid]       = useState(true)
  const [canvasHeightPx, setCanvasHeightPx] = useState(null)
  const canvasRef = useRef(null)

  // Undo/redo history for shape drawing — each entry is a {points, closed}
  // snapshot taken just before a point is added or the shape is closed.
  const [shapeHistory, setShapeHistory]   = useState([])
  const [shapeFuture, setShapeFuture]     = useState([])

  const mountedRef       = useRef(false)
  const skipAutoSolveRef = useRef(false)
  const meshViewerRef    = useRef(null)

  const solve = useCallback(async (p, pt, lt = 'point') => {
    setLoading(true)
    setError(null)
    try {
      setShowOriginal(false)

      const loadsPayload = lt === 'custom'
        ? customLoads.map(({ node, fx, fy }) => ({ node, fx, fy }))
        : undefined

      const fetchSolve = (body) =>
        fetch(`${API}/solve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(async (res) => {
          if (!res.ok) {
            const err = await res.json()
            throw new Error(err.detail || 'Server error')
          }
          return res.json()
        })

      if (compareMode) {
        const [data1, data2] = await Promise.all([
          fetchSolve({ ...p, problem_type: pt, load_type: lt, custom_loads: loadsPayload }),
          fetchSolve({ ...p, nx: compareNx, ny: compareNy, problem_type: pt, load_type: lt, custom_loads: loadsPayload }),
        ])
        setMeshData(data1)
        setMeshData2(data2)
        if (data1.max_displacement > 0) {
          const auto = Math.round((p.height * 0.1) / data1.max_displacement)
          setDispScale(Math.max(1, Math.min(auto, 50000)))
        }
      } else {
        const data = await fetchSolve({ ...p, problem_type: pt, load_type: lt, custom_loads: loadsPayload })
        setMeshData(data)
        setMeshData2(null)
        if (data.max_displacement > 0) {
          const auto = Math.round((p.height * 0.1) / data.max_displacement)
          setDispScale(Math.max(1, Math.min(auto, 50000)))
        }
      }
    } catch (e) {
      setError(e.message.includes('fetch')
        ? 'Cannot reach backend — is uvicorn running on :8000?'
        : e.message)
    } finally {
      setLoading(false)
    }
  }, [compareMode, compareNx, compareNy, customLoads])

  // Auto re-solve (debounced) whenever the active params/load type/compare
  // settings change in preset mode, so tweaking material/load/mesh fields
  // is reflected without having to remember to click Solve. The very first
  // mount solves immediately; explicit actions that already solve directly
  // (switchProblem) set skipAutoSolveRef to avoid a redundant duplicate fetch.
  // Custom-load mode is excluded: it should only solve when the user
  // explicitly clicks Solve (placing/editing loads is a pure client-side
  // preview), and auto-resolving here would also flip `loading` true/false
  // while the load-edit popup is open, unmounting it mid-edit.
  useEffect(() => {
    if (mode !== 'preset' || loadType === 'custom') return
    if (!mountedRef.current) {
      mountedRef.current = true
      solve(params, problemType, loadType)
      return
    }
    if (skipAutoSolveRef.current) {
      skipAutoSolveRef.current = false
      return
    }
    const t = setTimeout(() => solve(params, problemType, loadType), 500)
    return () => clearTimeout(t)
  }, [mode, params, loadType, compareMode, compareNx, compareNy])

  const switchProblem = (pt) => {
    skipAutoSolveRef.current = true
    setProblemType(pt)
    setLoadType('point')
    setCustomLoads([])
    const p = PROBLEMS[pt].defaults
    setParams(p)
    solve(p, pt, 'point')
  }

  const toggleCompareMode = () => {
    if (!compareMode) {
      setCompareNx(Math.max(1, Math.floor(params.nx / 2)))
      setCompareNy(Math.max(1, Math.floor(params.ny / 2)))
    }
    setCompareMode((prev) => !prev)
  }

  // Custom load node indices are only valid for the mesh they were placed
  // on, so any change to the preset's resolution/geometry (or the draw-mode
  // mesh density, which re-triangulates) invalidates them.
  useEffect(() => {
    setCustomLoads([])
  }, [params.nx, params.ny, params.width, params.height, meshDensity])

  const resetShape = () => {
    setShapePoints([])
    setShapeClosed(false)
    setCustomMeshData(null)
    setCustomError(null)
    setCanvasHeightPx(null)
    setCustomLoads([])
    setShapeHistory([])
    setShapeFuture([])
  }

  // ── Draw Shape undo/redo ──────────────────────────────────────────
  // Each point placed or shape-close action records a {points, closed}
  // snapshot of the *previous* state so it can be restored later.
  const pushShapeHistory = () => {
    setShapeHistory((h) => [...h, { points: shapePoints, closed: shapeClosed }])
    setShapeFuture([])
  }

  const addShapePoint = (pt) => {
    pushShapeHistory()
    setShapePoints((pts) => [...pts, pt])
  }

  const closeShape = () => {
    pushShapeHistory()
    setShapeClosed(true)
  }

  const undoShapePoint = () => {
    if (shapeHistory.length === 0) return
    const prev = shapeHistory[shapeHistory.length - 1]
    setShapeHistory((h) => h.slice(0, -1))
    setShapeFuture((f) => [{ points: shapePoints, closed: shapeClosed }, ...f])
    setShapePoints(prev.points)
    setShapeClosed(prev.closed)
  }

  const redoShapePoint = () => {
    if (shapeFuture.length === 0) return
    const next = shapeFuture[0]
    setShapeFuture((f) => f.slice(1))
    setShapeHistory((h) => [...h, { points: shapePoints, closed: shapeClosed }])
    setShapePoints(next.points)
    setShapeClosed(next.closed)
  }

  const solveCustomShape = async () => {
    if (!shapeClosed || shapePoints.length < 3) return
    let H = canvasHeightPx
    if (H == null) {
      if (!canvasRef.current) return
      H = canvasRef.current.clientHeight
      setCanvasHeightPx(H)
    }
    setCustomLoading(true)
    setCustomError(null)
    try {
      const femPoints = shapePoints.map(([x, y]) => [x / SHAPE_SCALE, (H - y) / SHAPE_SCALE])
      const res = await fetch(`${API}/solve_custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: femPoints,
          E: params.E,
          nu: params.nu,
          load: params.load,
          mesh_density: meshDensity,
          custom_loads: loadType === 'custom'
            ? customLoads.map(({ node, fx, fy }) => ({ node, fx, fy }))
            : undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || 'Server error')
      }
      const data = await res.json()
      setCustomMeshData(data)
      if (data.max_displacement > 0) {
        const span = Math.max(...femPoints.map((p) => p[1])) - Math.min(...femPoints.map((p) => p[1]))
        const auto = Math.round((span * 0.1) / data.max_displacement)
        setDispScale(Math.max(1, Math.min(auto, 50000)))
      }
    } catch (e) {
      setCustomError(e.message.includes('fetch')
        ? 'Cannot reach backend — is uvicorn running on :8000?'
        : e.message)
    } finally {
      setCustomLoading(false)
    }
  }

  // Once a drawn shape has been solved at least once, auto re-solve
  // (debounced) on subsequent material/load/mesh-density tweaks — mirrors
  // the preset-mode behavior above. Shape editing itself never triggers
  // this since customMeshData stays null until the first explicit solve.
  useEffect(() => {
    if (mode !== 'draw' || !customMeshData) return
    const t = setTimeout(() => solveCustomShape(), 500)
    return () => clearTimeout(t)
  }, [mode, params.E, params.nu, params.load, meshDensity])

  useEffect(() => { propSpeedRef.current = propSpeed }, [propSpeed])

  const clearCrack = () => {
    if (propAnimRef.current) clearTimeout(propAnimRef.current)
    setCrackElemIdx(null)
    setCrackMeshData(null)
    setCrackFailedElems(new Set())
    setPropSteps([])
    setPropStepIdx(-1)
    setPropPlaying(false)
    setPropComputing(false)
  }

  const switchMode = (m) => {
    setMode(m)
    setError(null)
    setCustomLoads([])
    if (m !== 'crack') clearCrack()
  }

  const handleCrackPlace = useCallback(async (elemIdx, centX, centY) => {
    if (propAnimRef.current) clearTimeout(propAnimRef.current)
    setCrackElemIdx(elemIdx)
    setCrackFailedElems(new Set([elemIdx]))
    setPropSteps([])
    setPropStepIdx(-1)
    setPropPlaying(false)
    setCrackMeshData(null)
    try {
      const res = await fetch(`${API}/solve_crack_step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          problem_type: problemType,
          load_type: loadType === 'custom' ? 'point' : loadType,
          load_factor: 1.0,
          excluded_elements: [elemIdx],
        }),
      })
      if (res.ok) setCrackMeshData(await res.json())
    } catch { /* fall back to original meshData */ }
  }, [params, problemType, loadType])

  const startPropAnimation = (steps) => {
    setPropPlaying(true)
    let idx = 0
    const tick = () => {
      if (idx >= steps.length) { setPropPlaying(false); return }
      const step = steps[idx]
      setCrackMeshData(step.meshData)
      setCrackFailedElems(step.failedElems)
      setPropStepIdx(idx)
      idx++
      propAnimRef.current = setTimeout(tick, propSpeedRef.current)
    }
    propAnimRef.current = setTimeout(tick, propSpeedRef.current)
  }

  const stopPropagation = () => {
    if (propAnimRef.current) clearTimeout(propAnimRef.current)
    setPropPlaying(false)
  }

  const replayCrack = () => {
    if (propSteps.length === 0) return
    if (propAnimRef.current) clearTimeout(propAnimRef.current)
    startPropAnimation(propSteps)
  }

  const runPropagation = async () => {
    if (!meshData || crackElemIdx === null || !yieldStrength) return
    if (propAnimRef.current) clearTimeout(propAnimRef.current)
    setPropComputing(true)
    setPropSteps([])
    setPropStepIdx(-1)
    setCrackFailedElems(new Set([crackElemIdx]))
    setPropPlaying(false)

    const N   = 20
    const yPa = parseFloat(yieldStrength) * 1e6
    let collected = []
    let failed    = new Set([crackElemIdx])

    for (let s = 0; s <= N; s++) {
      try {
        const res = await fetch(`${API}/solve_crack_step`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...params,
            problem_type: problemType,
            load_type: loadType === 'custom' ? 'point' : loadType,
            load_factor: s / N,
            excluded_elements: Array.from(failed),
          }),
        })
        if (!res.ok) break
        const data = await res.json()
        const nf = new Set(failed)
        data.von_mises.forEach((vm, i) => { if (!nf.has(i) && vm > yPa) nf.add(i) })
        collected = [...collected, { loadFactor: s / N, meshData: data, failedElems: new Set(nf) }]
        setPropSteps(collected)
        failed = nf
      } catch { break }
    }

    setPropComputing(false)
    if (collected.length > 0) startPropAnimation(collected)
  }

  const displayMeshData = mode === 'draw' ? customMeshData : meshData

  // ── Save / Load project ──────────────────────────────────────────
  const handleSaveProject = () => {
    const project = {
      version: 1,
      mode,
      problemType,
      params,
      shapePoints,
      shapeClosed,
      canvasHeightPx,
      meshDensity,
      loadType,
      yieldStrength,
      snapToGrid,
    }
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `fem-project-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1500)
  }

  const handleLoadProject = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const p = JSON.parse(ev.target.result)
        if (p.version !== 1) return
        if (p.mode)                               setMode(p.mode)
        if (p.problemType)                        setProblemType(p.problemType)
        if (p.params)                             setParams(p.params)
        if (Array.isArray(p.shapePoints))         setShapePoints(p.shapePoints)
        if (typeof p.shapeClosed === 'boolean')   setShapeClosed(p.shapeClosed)
        if (p.canvasHeightPx != null)             setCanvasHeightPx(p.canvasHeightPx)
        if (p.meshDensity != null)                setMeshDensity(p.meshDensity)
        if (p.loadType)                           setLoadType(p.loadType)
        if (p.yieldStrength !== undefined)        setYieldStrength(p.yieldStrength)
        if (typeof p.snapToGrid === 'boolean')    setSnapToGrid(p.snapToGrid)
        setCustomMeshData(null)
        setCustomError(null)
        setCustomLoads([])
        setShapeHistory([])
        setShapeFuture([])
      } catch {
        // silently ignore malformed files
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // Same conversion solveCustomShape() uses — recomputed for the
  // convergence study so it can re-mesh the same drawn shape at other
  // densities without disturbing the currently-displayed solve.
  const femPointsForConvergence = mode === 'draw' && canvasHeightPx != null
    ? shapePoints.map(([x, y]) => [x / SHAPE_SCALE, (canvasHeightPx - y) / SHAPE_SCALE])
    : null

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-brand">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <polygon points="10,2 18,7 18,13 10,18 2,13 2,7" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <circle cx="10" cy="10" r="2.5" fill="currentColor"/>
          </svg>
          <h1>FEM Visualizer</h1>
        </div>

        <div className="mode-toggle">
          <button
            className={`mode-btn${mode === 'preset' ? ' active' : ''}`}
            onClick={() => switchMode('preset')}
          >
            Preset Beam
          </button>
          <button
            className={`mode-btn${mode === 'draw' ? ' active' : ''}`}
            onClick={() => switchMode('draw')}
          >
            Draw Shape
          </button>
          <button
            className={`mode-btn mode-btn-crack${mode === 'crack' ? ' active' : ''}`}
            onClick={() => switchMode('crack')}
            title="Place a crack notch and simulate progressive fracture"
          >
            Crack
          </button>
        </div>

        {mode === 'preset' && (
          <nav className="problem-tabs">
            {Object.entries(PROBLEMS).map(([id, p]) => (
              <button
                key={id}
                className={`problem-tab${problemType === id ? ' active' : ''}`}
                onClick={() => switchProblem(id)}
              >
                <span className="tab-icon">{p.icon}</span>
                {p.label}
              </button>
            ))}
          </nav>
        )}

        {mode !== 'crack' && (
          <button
            className="solve-btn-header"
            onClick={mode === 'preset' ? () => solve(params, problemType, loadType) : solveCustomShape}
            disabled={mode === 'preset' ? loading : (customLoading || !shapeClosed)}
            title={mode === 'draw' && !shapeClosed ? 'Close the shape first' : undefined}
          >
            {(mode === 'preset' ? loading : customLoading) ? <span className="spinner" /> : '▶'}
            {(mode === 'preset' ? loading : customLoading) ? 'Solving…' : 'Solve'}
          </button>
        )}
      </header>

      <div className="app-body">
        <main className={`viewer-pane${compareMode && mode === 'preset' ? ' compare' : ''}`}>
          {mode === 'preset' && (
            <>
              {error && (
                <div className="status-msg error">
                  <span>⚠</span>
                  <span>{error}</span>
                </div>
              )}
              {loading && (
                <div className="status-msg loading">
                  <span className="big-spinner" />
                  <span>Assembling &amp; solving…</span>
                </div>
              )}
              {meshData && !loading && !compareMode && (
                <MeshViewer
                  ref={meshViewerRef}
                  meshData={meshData}
                  viewMode={viewMode}
                  dispScale={dispScale}
                  params={params}
                  showOriginal={showOriginal}
                  yieldStrength={yieldStrength}
                  loadType={loadType}
                  customLoads={customLoads}
                  setCustomLoads={setCustomLoads}
                  showVectors={showVectors}
                  vectorDensity={vectorDensity}
                />
              )}
              {meshData && !loading && compareMode && (
                <>
                  <div className="compare-panel">
                    <span className="compare-label">Fine — {params.nx}×{params.ny}</span>
                    <MeshViewer
                      ref={meshViewerRef}
                      key="fine"
                      meshData={meshData}
                      viewMode={viewMode}
                      dispScale={dispScale}
                      params={params}
                      showOriginal={showOriginal}
                      yieldStrength={yieldStrength}
                      compact
                    />
                  </div>
                  <div className="compare-panel">
                    <span className="compare-label">Coarse — {compareNx}×{compareNy}</span>
                    {meshData2 ? (
                      <MeshViewer
                        key="coarse"
                        meshData={meshData2}
                        viewMode={viewMode}
                        dispScale={dispScale}
                        params={params}
                        showOriginal={showOriginal}
                        yieldStrength={yieldStrength}
                        compact
                      />
                    ) : (
                      <div className="status-msg">
                        <span>Click Solve to compare</span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}

          {mode === 'crack' && (
            <div className="crack-pane">
              {!meshData ? (
                <div className="status-msg">
                  <span>Solve a preset beam first, then enter Crack mode</span>
                </div>
              ) : (
                <>
                  {propComputing && (
                    <div className="crack-computing">
                      <span className="big-spinner" style={{ width: 16, height: 16 }} />
                      Computing step {propSteps.length} / 21…
                    </div>
                  )}
                  <MeshViewer
                    ref={meshViewerRef}
                    meshData={crackMeshData || meshData}
                    viewMode={viewMode}
                    dispScale={dispScale}
                    params={params}
                    showOriginal={false}
                    yieldStrength={yieldStrength}
                    loadType={loadType}
                    showVectors={false}
                    crackPlacementActive={!propComputing && !propPlaying}
                    crackElemIdx={crackElemIdx}
                    crackFailedElems={crackFailedElems}
                    onCrackPlace={handleCrackPlace}
                  />
                </>
              )}
            </div>
          )}

          {mode === 'draw' && (
            <div className="draw-pane">
              {!customMeshData ? (
                <>
                  <div className="shape-canvas-wrap" ref={canvasRef}>
                    <ShapeCanvas
                      points={shapePoints}
                      closed={shapeClosed}
                      onAddPoint={addShapePoint}
                      onClose={closeShape}
                      containerRef={canvasRef}
                      snapEnabled={snapToGrid}
                      onUndo={undoShapePoint}
                      onRedo={redoShapePoint}
                      canUndo={shapeHistory.length > 0}
                      canRedo={shapeFuture.length > 0}
                    />
                  </div>
                  <div className="draw-toolbar">
                    <span className="draw-hint">
                      {shapePoints.length === 0
                        ? 'Click to start drawing a shape outline · scroll to zoom · drag to pan'
                        : shapeClosed
                          ? `${shapePoints.length} points · shape closed`
                          : `${shapePoints.length} point${shapePoints.length === 1 ? '' : 's'} · click near the first point or double-click to close · scroll to zoom · drag to pan`}
                    </span>
                    <div className="draw-actions">
                      {shapePoints.length > 0 && (
                        <button className="draw-btn draw-btn-reset" onClick={resetShape}>Reset</button>
                      )}
                      {shapeClosed && (
                        <button className="draw-btn draw-btn-solve" onClick={solveCustomShape} disabled={customLoading}>
                          {customLoading ? <span className="spinner" /> : '▶'}
                          {customLoading ? 'Meshing…' : 'Mesh & Solve'}
                        </button>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <MeshViewer
                  ref={meshViewerRef}
                  meshData={customMeshData}
                  viewMode={viewMode}
                  dispScale={dispScale}
                  params={params}
                  showOriginal={showOriginal}
                  yieldStrength={yieldStrength}
                  loadType={loadType}
                  customLoads={customLoads}
                  setCustomLoads={setCustomLoads}
                  showVectors={showVectors}
                  vectorDensity={vectorDensity}
                />
              )}

              {customError && (
                <div className="status-msg error">
                  <span>⚠</span>
                  <span>{customError}</span>
                </div>
              )}
              {customLoading && (
                <div className="status-msg loading">
                  <span className="big-spinner" />
                  <span>Triangulating &amp; solving…</span>
                </div>
              )}
            </div>
          )}

          {/* Consolidated right-side viewer overlay toolbar */}
          {(meshData || customMeshData) && (
            <div className="viewer-right-toolbar">
              <button
                className="viewer-action-btn"
                onClick={() => meshViewerRef.current?.resetView()}
                title="Reset zoom and pan to fit"
              >
                ⤢ Reset View
              </button>
              {mode === 'crack' && crackElemIdx !== null && !propComputing && !propPlaying && (
                <button
                  className="viewer-action-btn viewer-action-btn-danger"
                  onClick={clearCrack}
                  title="Remove the placed crack"
                >
                  ↺ Remove Crack
                </button>
              )}
              {mode === 'draw' && customMeshData && (
                <button
                  className="viewer-action-btn viewer-action-btn-danger"
                  onClick={resetShape}
                  title="Clear the drawn shape and start over"
                >
                  ↺ Reset Shape
                </button>
              )}
            </div>
          )}
        </main>

        <Controls
          mode={mode}
          params={params}
          setParams={setParams}
          viewMode={viewMode}
          setViewMode={(m) => { setViewMode(m); if (m !== 'deformed') setShowOriginal(false) }}
          dispScale={dispScale}
          setDispScale={setDispScale}
          loadType={loadType}
          setLoadType={setLoadType}
          showOriginal={showOriginal}
          setShowOriginal={setShowOriginal}
          meshData={mode === 'crack' ? (crackMeshData || meshData) : displayMeshData}
          problemType={problemType}
          yieldStrength={yieldStrength}
          setYieldStrength={setYieldStrength}
          compareMode={compareMode}
          toggleCompareMode={toggleCompareMode}
          compareNx={compareNx}
          setCompareNx={setCompareNx}
          compareNy={compareNy}
          setCompareNy={setCompareNy}
          meshDensity={meshDensity}
          setMeshDensity={setMeshDensity}
          snapToGrid={snapToGrid}
          setSnapToGrid={setSnapToGrid}
          customLoads={customLoads}
          setCustomLoads={setCustomLoads}
          onOpenConvergence={() => setShowConvergence(true)}
          onSaveProject={handleSaveProject}
          onLoadProject={handleLoadProject}
          showVectors={showVectors}
          setShowVectors={setShowVectors}
          vectorDensity={vectorDensity}
          setVectorDensity={setVectorDensity}
          crackElemIdx={crackElemIdx}
          propStepIdx={propStepIdx}
          propSteps={propSteps}
          propComputing={propComputing}
          propSpeed={propSpeed}
          setPropSpeed={setPropSpeed}
          propPlaying={propPlaying}
          onRunPropagation={runPropagation}
          onStopPropagation={stopPropagation}
          onReplayCrack={replayCrack}
          onExportPng={() => meshViewerRef.current?.exportPng()}
          onExportReport={() => meshViewerRef.current?.exportReport()}
        />
      </div>

      {showConvergence && (
        <ConvergenceModal
          mode={mode}
          problemType={problemType}
          params={params}
          loadType={loadType}
          customLoads={customLoads}
          femPoints={femPointsForConvergence}
          meshDensity={meshDensity}
          onClose={() => setShowConvergence(false)}
        />
      )}

      <WelcomeModal />
    </div>
  )
}
