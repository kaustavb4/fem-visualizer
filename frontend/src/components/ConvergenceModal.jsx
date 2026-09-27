import { useEffect, useState } from 'react'
import * as d3 from 'd3'

const API = 'http://localhost:8000'

// Relative to the currently-solved mesh: ~coarse, medium, fine, very fine.
const LEVEL_FACTORS = [0.4, 0.7, 1, 1.5]
const LEVEL_LABELS  = ['Coarse', 'Medium', 'Fine', 'Very Fine']

function computeLevels(mode, params, meshDensity) {
  const seen = new Set()
  const levels = []
  LEVEL_FACTORS.forEach((f, i) => {
    if (mode === 'draw') {
      const d = Math.max(4, Math.min(40, Math.round(meshDensity * f)))
      if (seen.has(d)) return
      seen.add(d)
      levels.push({ label: LEVEL_LABELS[i], meshDensity: d })
    } else {
      const nx = Math.max(2, Math.min(80, Math.round(params.nx * f)))
      const ny = Math.max(2, Math.min(40, Math.round(params.ny * f)))
      const key = `${nx}x${ny}`
      if (seen.has(key)) return
      seen.add(key)
      levels.push({ label: LEVEL_LABELS[i], nx, ny })
    }
  })
  return levels
}

export default function ConvergenceModal({
  mode, problemType, params, loadType, customLoads, femPoints, meshDensity, onClose,
}) {
  const [status, setStatus]     = useState('loading') // 'loading' | 'done' | 'error'
  const [points, setPoints]     = useState([])
  const [errorMsg, setErrorMsg] = useState(null)

  // Runs once per mount — the modal is fully remounted each time it's
  // opened, so this always reflects the params/loads at open-time.
  useEffect(() => {
    let cancelled = false

    const fetchOne = async (lvl) => {
      const isDraw = mode === 'draw'
      const loadsPayload = loadType === 'custom'
        ? customLoads.map(({ node, fx, fy }) => ({ node, fx, fy }))
        : undefined
      const url  = isDraw ? `${API}/solve_custom` : `${API}/solve`
      const body = isDraw
        ? {
            points: femPoints,
            E: params.E, nu: params.nu, load: params.load,
            mesh_density: lvl.meshDensity,
            custom_loads: loadsPayload,
          }
        : {
            ...params, nx: lvl.nx, ny: lvl.ny,
            problem_type: problemType, load_type: loadType,
            custom_loads: loadsPayload,
          }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || 'Server error')
      }
      const data = await res.json()
      return { label: lvl.label, elements: data.elements.length, maxVM: data.max_von_mises }
    }

    const run = async () => {
      setStatus('loading')
      setErrorMsg(null)

      if (mode === 'draw' && !femPoints) {
        setStatus('error')
        setErrorMsg('No solved shape to base the study on.')
        return
      }

      const levels = computeLevels(mode, params, meshDensity)
      const results = await Promise.allSettled(levels.map(fetchOne))
      if (cancelled) return

      const ok = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => a.elements - b.elements)

      if (ok.length === 0) {
        setStatus('error')
        setErrorMsg('Could not run the convergence study — is the backend reachable?')
        return
      }
      setPoints(ok)
      setStatus('done')
    }

    run()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="convergence-backdrop" onClick={onClose}>
      <div className="convergence-modal" onClick={(e) => e.stopPropagation()}>
        <div className="convergence-modal-header">
          <span>Mesh Convergence Study</span>
          <button className="convergence-close-btn" onClick={onClose} title="Close">×</button>
        </div>
        <div className="convergence-modal-body">
          {status === 'loading' && (
            <div className="status-msg loading convergence-status">
              <span className="big-spinner" />
              <span>Running solves at multiple mesh densities…</span>
            </div>
          )}
          {status === 'error' && (
            <div className="status-msg error convergence-status">
              <span>⚠</span>
              <span>{errorMsg}</span>
            </div>
          )}
          {status === 'done' && points.length >= 2 && (
            <>
              <ConvergenceChart points={points} />
              <p className="convergence-hint">
                Max von Mises stress vs. element count across {points.length} mesh densities.
                Values flattening out indicate the solution has converged.
              </p>
            </>
          )}
          {status === 'done' && points.length < 2 && (
            <div className="status-msg convergence-status">
              <span>Not enough distinct mesh densities to plot — try a coarser or finer base mesh.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ConvergenceChart({ points }) {
  const W = 460, H = 280
  const M = { top: 20, right: 24, bottom: 44, left: 56 }
  const innerW = W - M.left - M.right
  const innerH = H - M.top - M.bottom

  const xs = points.map((p) => p.elements)
  const ysMPa = points.map((p) => p.maxVM / 1e6)
  const xScale = d3.scaleLinear().domain([Math.min(...xs), Math.max(...xs)]).nice()
    .range([M.left, M.left + innerW])
  const yMax = Math.max(...ysMPa)
  const yScale = d3.scaleLinear().domain([0, yMax > 0 ? yMax * 1.15 : 1]).nice()
    .range([M.top + innerH, M.top])

  const lineGen = d3.line().x((p) => xScale(p.elements)).y((p) => yScale(p.maxVM / 1e6))
  const xTicks = xScale.ticks(Math.min(5, points.length))
  const yTicks = yScale.ticks(5)

  return (
    <svg className="convergence-svg" viewBox={`0 0 ${W} ${H}`}>
      {yTicks.map((t) => (
        <line key={`gy-${t}`} x1={M.left} x2={M.left + innerW} y1={yScale(t)} y2={yScale(t)}
          className="convergence-grid" />
      ))}
      <line x1={M.left} y1={M.top} x2={M.left} y2={M.top + innerH} className="convergence-axis" />
      <line x1={M.left} y1={M.top + innerH} x2={M.left + innerW} y2={M.top + innerH} className="convergence-axis" />

      {yTicks.map((t) => (
        <text key={`y-${t}`} x={M.left - 8} y={yScale(t) + 3} textAnchor="end" className="convergence-tick-label">
          {t.toFixed(2)}
        </text>
      ))}
      {xTicks.map((t) => (
        <text key={`x-${t}`} x={xScale(t)} y={M.top + innerH + 18} textAnchor="middle" className="convergence-tick-label">
          {t}
        </text>
      ))}

      <text x={M.left + innerW / 2} y={H - 4} textAnchor="middle" className="convergence-axis-label">
        Number of Elements
      </text>
      <text x={14} y={M.top + innerH / 2} textAnchor="middle" className="convergence-axis-label"
        transform={`rotate(-90, 14, ${M.top + innerH / 2})`}>
        Max von Mises [MPa]
      </text>

      <path d={lineGen(points)} className="convergence-line" fill="none" />
      {points.map((p) => (
        <g key={p.elements}>
          <circle cx={xScale(p.elements)} cy={yScale(p.maxVM / 1e6)} r={4} className="convergence-point" />
          <text x={xScale(p.elements)} y={yScale(p.maxVM / 1e6) - 10} textAnchor="middle"
            className="convergence-point-label">
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  )
}
