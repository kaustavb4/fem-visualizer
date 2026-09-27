import { useRef } from 'react'
import { PROBLEMS } from '../App'

const MATERIAL_PRESETS = [
  { label: 'Steel',    E: 200e9, nu: 0.30 },
  { label: 'Aluminum', E: 70e9,  nu: 0.33 },
  { label: 'Concrete', E: 30e9,  nu: 0.20 },
  { label: 'Titanium', E: 116e9, nu: 0.34 },
]

export default function Controls({
  mode,
  params, setParams,
  viewMode, setViewMode,
  dispScale, setDispScale,
  loadType, setLoadType,
  showOriginal, setShowOriginal,
  meshData, problemType,
  yieldStrength, setYieldStrength,
  compareMode, toggleCompareMode,
  compareNx, setCompareNx,
  compareNy, setCompareNy,
  meshDensity, setMeshDensity,
  snapToGrid, setSnapToGrid,
  customLoads, setCustomLoads,
  onOpenConvergence,
  onSaveProject,
  onLoadProject,
  showVectors, setShowVectors,
  vectorDensity, setVectorDensity,
  crackElemIdx,
  propStepIdx, propSteps, propComputing,
  propSpeed, setPropSpeed,
  propPlaying,
  onRunPropagation,
  onStopPropagation,
  onReplayCrack,
  onExportPng,
  onExportReport,
}) {
  const fileInputRef = useRef(null)
  const set = (key) => (e) => {
    const n = parseFloat(e.target.value)
    setParams((p) => ({ ...p, [key]: isNaN(n) ? e.target.value : n }))
  }
  const setInt = (key) => (e) => {
    const n = parseInt(e.target.value)
    if (!isNaN(n)) setParams((p) => ({ ...p, [key]: n }))
  }

  const isDraw = mode === 'draw'
  const isCrack = mode === 'crack'
  const isRectBeam = !isDraw && ['cantilever', 'simply_supported', 'fixed_fixed'].includes(problemType)

  const activePreset = MATERIAL_PRESETS.find(
    (m) => Math.abs(m.E - params.E) < 1e9 && Math.abs(m.nu - params.nu) < 0.005,
  )?.label ?? ''

  const yPa          = yieldStrength && parseFloat(yieldStrength) > 0 ? parseFloat(yieldStrength) * 1e6 : null
  const failingCount = yPa && meshData ? meshData.von_mises.filter((vm) => vm > yPa).length : 0
  const marginalCount = yPa && meshData ? meshData.von_mises.filter((vm) => vm > yPa / 2 && vm <= yPa).length : 0
  const safeCount    = yPa && meshData ? meshData.von_mises.filter((vm) => vm <= yPa / 2).length : 0
  const minFoS       = yPa && meshData && meshData.max_von_mises > 0
    ? yPa / meshData.max_von_mises : null

  return (
    <aside className="controls">
      <div className="controls-inner">

        {/* ── Section 1: VIEW ── */}
        <div className="bp-section bp-view">
          <span className="bp-header">View</span>
          <div className="bp-body">
            <div className="segmented segmented-view">
              {[
                { id: 'undeformed', label: 'Mesh' },
                { id: 'deformed',   label: 'Deformed' },
                { id: 'stress',     label: 'Stress' },
                { id: 'safety',     label: 'Safety' },
              ].map(({ id, label }) => (
                <button
                  key={id}
                  className={`segmented-btn${viewMode === id ? ' active' : ''}`}
                  onClick={() => setViewMode(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {viewMode !== 'undeformed' && viewMode !== 'safety' && (
              <div className="slider-row">
                <span className="field-label" style={{ flexShrink: 0 }}>Scale</span>
                <input
                  type="range" min="1" max="20000"
                  value={dispScale}
                  onChange={(e) => setDispScale(parseInt(e.target.value))}
                  title="Displacement scale"
                />
                <span className="slider-value">{dispScale}×</span>
              </div>
            )}

            {viewMode === 'deformed' && (
              <button
                className={`bp-link-btn${showOriginal ? ' active' : ''}`}
                onClick={() => setShowOriginal(!showOriginal)}
                title="Toggle between deformed shape and original undeformed mesh"
              >
                {showOriginal ? '↩ Back to Deformed' : '⟷ Compare Original'}
              </button>
            )}

            <div className="vectors-row">
              <button
                className={`bp-link-btn${showVectors ? ' active' : ''}`}
                onClick={() => setShowVectors(!showVectors)}
                disabled={!meshData}
                title="Overlay principal stress direction arrows on each element"
              >
                {showVectors ? '⊕ Vectors: On' : '○ Vectors'}
              </button>
              {showVectors && (
                <div className="slider-row vectors-density">
                  <input
                    type="range" min="1" max="5"
                    value={vectorDensity}
                    onChange={(e) => setVectorDensity(parseInt(e.target.value))}
                    title="Arrow density — show every Nth element"
                  />
                  <span className="slider-value">÷{vectorDensity}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Section 2: MESH ── */}
        <div className="bp-section bp-mesh">
          <span className="bp-header">Mesh</span>
          <div className="bp-body">
            {!isDraw ? (
              <>
                <div className="bp-grid-2x2">
                  <Field label="Elem X">
                    <input type="number" min="1" max="80" value={params.nx} onChange={setInt('nx')} />
                  </Field>
                  <Field label="Elem Y">
                    <input type="number" min="1" max="40" value={params.ny} onChange={setInt('ny')} />
                  </Field>
                  <Field label="Width (m)">
                    <input type="number" step="0.1" min="0.1" value={params.width} onChange={set('width')} />
                  </Field>
                  <Field label="Height (m)">
                    <input type="number" step="0.05" min="0.05" value={params.height} onChange={set('height')} />
                  </Field>
                </div>
                <div className="bp-compare-row">
                  <button
                    className={`bp-icon-btn${compareMode ? ' active' : ''}`}
                    onClick={toggleCompareMode}
                    title="Compare two mesh densities side by side"
                  >
                    {compareMode ? '⊠' : '⊞'}
                  </button>
                  {compareMode && (
                    <>
                      <input
                        type="number" min="1" max="80" className="bp-mini-input"
                        value={compareNx}
                        title="Compare Elements X"
                        onChange={(e) => setCompareNx(Math.max(1, parseInt(e.target.value) || 1))}
                      />
                      <input
                        type="number" min="1" max="40" className="bp-mini-input"
                        value={compareNy}
                        title="Compare Elements Y"
                        onChange={(e) => setCompareNy(Math.max(1, parseInt(e.target.value) || 1))}
                      />
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="slider-field">
                  <span className="field-label">Mesh Density</span>
                  <div className="slider-row">
                    <input
                      type="range" min="6" max="36"
                      value={meshDensity}
                      onChange={(e) => setMeshDensity(parseInt(e.target.value))}
                    />
                    <span className="slider-value">{meshDensity}</span>
                  </div>
                </div>
                <button
                  className={`bp-link-btn${snapToGrid ? ' active' : ''}`}
                  onClick={() => setSnapToGrid(!snapToGrid)}
                  title="Snap drawn points to the nearest grid intersection"
                >
                  {snapToGrid ? '◫ Grid: On' : '◫ Grid: Off'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Section 3: MATERIAL ── */}
        <div className="bp-section bp-material">
          <span className="bp-header">Material</span>
          <div className="bp-body">
            <select
              className="preset-select"
              value={activePreset}
              onChange={(e) => {
                const m = MATERIAL_PRESETS.find((m) => m.label === e.target.value)
                if (m) setParams((p) => ({ ...p, E: m.E, nu: m.nu }))
              }}
            >
              <option value="" disabled>Preset…</option>
              {MATERIAL_PRESETS.map((m) => (
                <option key={m.label} value={m.label}>{m.label}</option>
              ))}
            </select>

            <Row>
              <Field label="E (GPa)">
                <input
                  type="number" step="10" min="0.001"
                  value={+(params.E / 1e9).toPrecision(4)}
                  onChange={(e) => setParams((p) => ({ ...p, E: parseFloat(e.target.value) * 1e9 }))}
                />
              </Field>
              <Field label="ν">
                <input type="number" step="0.01" min="0.01" max="0.49" value={params.nu} onChange={set('nu')} />
              </Field>
            </Row>
          </div>
        </div>

        {/* ── Section 4: LOAD ── */}
        <div className="bp-section bp-load">
          <span className="bp-header">Load</span>
          <div className="bp-body">
            <div className="segmented segmented-sm">
              {isRectBeam && (
                <button
                  className={`segmented-btn${loadType === 'point' ? ' active' : ''}`}
                  onClick={() => setLoadType('point')}
                  title="Single force at a point"
                >
                  Point
                </button>
              )}
              {isRectBeam && (
                <button
                  className={`segmented-btn${loadType === 'distributed' ? ' active' : ''}`}
                  onClick={() => setLoadType('distributed')}
                  title="Uniform load along entire top edge"
                >
                  Dist.
                </button>
              )}
              {!isRectBeam && (
                <button
                  className={`segmented-btn${loadType !== 'custom' ? ' active' : ''}`}
                  onClick={() => setLoadType('point')}
                  title="Single force at the load node"
                >
                  Point
                </button>
              )}
              <button
                className={`segmented-btn${loadType === 'custom' ? ' active' : ''}`}
                onClick={() => setLoadType('custom')}
                title="Click nodes on the solved mesh to place loads"
              >
                Custom
              </button>
            </div>

            {loadType === 'custom' ? (
              <div className="bp-custom-load">
                <span className="bp-subtext">
                  {customLoads.length > 0
                    ? `${customLoads.length} load${customLoads.length === 1 ? '' : 's'} placed`
                    : 'Click any node on the solved mesh'}
                </span>
                {customLoads.length > 0 && (
                  <button
                    className="bp-link-btn"
                    onClick={() => { setCustomLoads([]); setLoadType('point') }}
                  >
                    ✕ Clear Loads
                  </button>
                )}
              </div>
            ) : (
              <>
                <Field label="Force (N)">
                  <input type="number" step="1000" value={params.load} onChange={set('load')} />
                </Field>
                {isRectBeam && loadType === 'distributed' && (
                  <span className="bp-subtext">w = {(params.load / params.width / 1000).toFixed(2)} kN/m</span>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Section 5: ANALYSIS ── */}
        <div className="bp-section bp-analysis">
          <span className="bp-header">Analysis</span>
          <div className="bp-body">
            <Field label="Yield σ (MPa)">
              <input
                type="number"
                step="10"
                min="1"
                placeholder="e.g. 250"
                value={yieldStrength}
                onChange={(e) => setYieldStrength(e.target.value)}
              />
            </Field>

            {minFoS !== null && (
              <div className="bp-fos-inline">
                <span className={`fos-val ${minFoS < 1 ? 'fos-fail' : minFoS < 1.5 ? 'fos-warn' : 'fos-ok'}`}>
                  {minFoS.toFixed(2)}×
                </span>
                <span className="bp-subtext" style={{ color: failingCount > 0 ? 'var(--red)' : 'var(--green)' }}>
                  {failingCount > 0 ? `${failingCount} fail` : 'All OK'}
                </span>
              </div>
            )}

            {isCrack && (
              <>
                <span className="bp-subtext crack-status-text">
                  {propComputing
                    ? `Computing… ${propSteps.length} / 21`
                    : propStepIdx >= 0 && propSteps.length > 0
                      ? `Step ${propStepIdx + 1}/${propSteps.length} · ${((propSteps[propStepIdx]?.loadFactor ?? 0) * 100).toFixed(0)}% load`
                      : crackElemIdx !== null
                        ? 'Crack placed — click Propagate'
                        : 'Click mesh element to place crack'}
                </span>

                <button
                  className="propagate-panel-btn"
                  onClick={propPlaying ? onStopPropagation : propSteps.length > 0 ? onReplayCrack : onRunPropagation}
                  disabled={propComputing || crackElemIdx === null || !yieldStrength}
                  title={
                    !yieldStrength ? 'Enter a yield strength first'
                    : crackElemIdx === null ? 'Click an element to place a crack first'
                    : undefined
                  }
                >
                  {propComputing
                    ? <><span className="spinner spinner-dark" /> Computing…</>
                    : propPlaying ? '■ Stop'
                    : propSteps.length > 0 ? '▶ Replay'
                    : '▶ Propagate'}
                </button>

                <div className="slider-row">
                  <span className="field-label" style={{ flexShrink: 0 }}>Speed</span>
                  <input
                    type="range" min="50" max="2000"
                    value={propSpeed}
                    onChange={(e) => setPropSpeed(parseInt(e.target.value))}
                    title="Animation speed — ms per step"
                  />
                  <span className="slider-value">{propSpeed}ms</span>
                </div>
              </>
            )}

            {viewMode === 'safety' && yPa && meshData && (
              <div className="bp-safety-breakdown">
                <span className="safety-stat safety-fail">✗ {failingCount} fail</span>
                <span className="safety-stat safety-marginal">! {marginalCount} marginal</span>
                <span className="safety-stat safety-safe">✓ {safeCount} safe</span>
              </div>
            )}
          </div>
        </div>

        {/* ── Section 6: RESULTS ── */}
        <div className="bp-section bp-results">
          <span className="bp-header">Results</span>
          <div className="bp-stat-row">
            <StatCard label="Max U"   value={meshData ? fmtDisp(meshData.max_displacement) : '–'} />
            <StatCard label="Max σ"   value={meshData ? fmtStress(meshData.max_von_mises) : '–'} />
            <StatCard label="Nodes"   value={meshData ? meshData.nodes.length : '–'} />
            <StatCard label="Elems"   value={meshData ? meshData.elements.length : '–'} />
            <StatCard label="DOFs"    value={meshData ? meshData.nodes.length * 2 : '–'} />
          </div>
        </div>

        {/* ── Section 7: ACTIONS ── */}
        <div className="bp-section bp-actions">
          <span className="bp-header">Actions</span>
          <div className="bp-body">
            <div className="actions-grid">
              <button className="action-btn" onClick={onSaveProject} title="Download current settings as a JSON file">
                ↓ Save
              </button>
              <button className="action-btn" onClick={() => fileInputRef.current?.click()} title="Restore settings from a saved JSON file">
                ↑ Load
              </button>
              <button className="action-btn" onClick={onOpenConvergence} disabled={!meshData} title="Run a mesh convergence study">
                ≈ Converge
              </button>
              <button className="action-btn" onClick={onExportPng} disabled={!meshData} title="Export stress map as PNG">
                ↓ PNG
              </button>
              <button className="action-btn" onClick={onExportReport} disabled={!meshData} title="Export PDF report">
                ↓ Report
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={onLoadProject}
            />
          </div>
        </div>

      </div>
    </aside>
  )
}

function fmtDisp(m) {
  const mm = m * 1000
  if (mm < 0.1) return `${(m * 1e6).toPrecision(3)} um`
  if (mm < 10)  return `${mm.toPrecision(3)} mm`
  return `${mm.toFixed(1)} mm`
}

function fmtStress(pa) {
  const mpa = pa / 1e6
  if (mpa >= 1000) return `${(mpa / 1000).toPrecision(3)} GPa`
  if (mpa >= 1)    return `${mpa.toPrecision(3)} MPa`
  return `${(pa / 1000).toPrecision(3)} kPa`
}

function Row({ children }) {
  return <div className="field-row">{children}</div>
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  )
}

function StatCard({ label, value }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  )
}
