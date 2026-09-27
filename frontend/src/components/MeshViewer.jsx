import { useEffect, useRef, useState, useId, forwardRef, useImperativeHandle } from 'react'
import * as d3 from 'd3'
import { PROBLEMS } from '../App'

// top: 70 = room for annotation callouts floating above force arrow
// right: 160 = 36px gap + 16px bar + 50px tick labels + 14px rotated text + slack
const M_FULL    = { top: 70, right: 160, bottom: 48, left: 56 }
const M_COMPACT = { top: 50, right: 110, bottom: 36, left: 40 }

// Geometry constants — must match fem.py
const L_BRACKET_LEG_FRAC = 0.35
const T_BEAM_WEB_FRAC    = 0.25   // web is center 25% of width
const T_BEAM_FLANGE_FRAC = 0.30   // flange is top 30% of height

const STRESS_COLORS = [
  '#1a237e', '#1565c0', '#0288d1', '#00bcd4',
  '#26a69a', '#66bb6a', '#d4e157', '#ffca28',
  '#ffa726', '#ef5350', '#b71c1c',
]
const stressInterp = d3.interpolateRgbBasis(STRESS_COLORS)

// Red → orange → yellow → lime → green  (FoS 0 → 4)
const FOS_COLORS = ['#ef4444', '#f97316', '#fbbf24', '#a3e635', '#22c55e']
const fosInterp  = d3.interpolateRgbBasis(FOS_COLORS)

const MeshViewer = forwardRef(function MeshViewer({
  meshData, viewMode, dispScale, params, showOriginal, yieldStrength, compact,
  loadType, customLoads, setCustomLoads,
  showVectors, vectorDensity,
  crackPlacementActive, crackElemIdx, crackFailedElems, onCrackPlace,
}, ref) {
  const svgRef          = useRef(null)
  const containerRef    = useRef(null)
  const tipRef          = useRef(null)
  const animFrameRef    = useRef(null)
  const zoomRef         = useRef(d3.zoomIdentity)
  const zoomBehaviorRef = useRef(null)
  // Re-triggerable from the Replay button; (re)assigned on every redraw so it
  // always closes over the latest drawFrame/dispScale.
  const replayWaveRef   = useRef(null)
  // Namespaces the wave mask/gradient ids so multiple MeshViewer instances
  // (e.g. the two compare-mode panels) never collide on the same SVG id.
  const instanceId      = useId()

  // Set in its own effect (deps: [meshData] only) and consumed by the main
  // draw effect below. Kept separate — rather than comparing meshData
  // against a ref mutated inline inside the draw effect — because in dev
  // StrictMode React runs effects twice per commit; mutating the comparison
  // ref inline made the second invocation always see "no change" and skip
  // the entrance animation on every solve. A dedicated effect still fires
  // twice under StrictMode, but idempotently (sets the same flag both
  // times), so the draw effect reliably sees one true reading per solve.
  const newSolvePendingRef = useRef(false)
  useEffect(() => {
    newSolvePendingRef.current = true
  }, [meshData])

  // Custom load editor popup — { node, x, y } screen position of the click
  // that opened it; cleared whenever custom-load mode is exited.
  const [editingLoad, setEditingLoad] = useState(null)
  useEffect(() => {
    if (loadType !== 'custom') setEditingLoad(null)
  }, [loadType])

  // ── Scroll to zoom, drag to pan ────────────────────────────────────
  // Attached once to the <svg> root and left alone; the draw effect below
  // rebuilds the SVG's contents on every redraw, but the zoom listeners
  // live on the (stable) root node and the current transform is preserved
  // across redraws via zoomRef, then reapplied to the freshly-built
  // '.zoom-layer' group.
  useEffect(() => {
    if (!svgRef.current) return
    const svgSel = d3.select(svgRef.current)
    const zoomBehavior = d3.zoom()
      .scaleExtent([0.5, 10])
      .on('zoom', (event) => {
        zoomRef.current = event.transform
        svgSel.select('.zoom-layer').attr('transform', event.transform)
      })
    svgSel.call(zoomBehavior)
    zoomBehaviorRef.current = zoomBehavior
    return () => svgSel.on('.zoom', null)
  }, [])

  const handleResetView = () => {
    if (!svgRef.current || !zoomBehaviorRef.current) return
    d3.select(svgRef.current)
      .transition().duration(300)
      .call(zoomBehaviorRef.current.transform, d3.zoomIdentity)
  }

  // ── PNG export ──────────────────────────────────────────────────
  const handleExport = () => {
    const svgEl = svgRef.current
    if (!svgEl) return
    const serializer = new XMLSerializer()
    let svgStr = serializer.serializeToString(svgEl)
    svgStr = svgStr.replace(/var\(--bg\)/g, '#0A0A0A')
    const W = svgEl.clientWidth  || 800
    const H = svgEl.clientHeight || 500
    const DPR = 2
    const canvas = document.createElement('canvas')
    canvas.width  = W * DPR
    canvas.height = H * DPR
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0A0A0A'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const img  = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W * DPR, H * DPR)
      URL.revokeObjectURL(url)
      canvas.toBlob((pngBlob) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(pngBlob)
        a.download = `fem-${meshData?.problem_type ?? 'stress'}.png`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1500)
      }, 'image/png')
    }
    img.src = url
  }

  // ── PDF report export ────────────────────────────────────────────
  const handleExportReport = async () => {
    if (!meshData || !svgRef.current) return

    // Capture SVG as PNG data URL (same technique as handleExport)
    const svgEl = svgRef.current
    const serializer = new XMLSerializer()
    let svgStr = serializer.serializeToString(svgEl)
    svgStr = svgStr.replace(/var\(--bg\)/g, '#0A0A0A')
    const W = svgEl.clientWidth  || 800
    const H = svgEl.clientHeight || 500
    const DPR = 2
    const offCanvas = document.createElement('canvas')
    offCanvas.width  = W * DPR
    offCanvas.height = H * DPR
    const ctx = offCanvas.getContext('2d')
    ctx.fillStyle = '#0A0A0A'
    ctx.fillRect(0, 0, offCanvas.width, offCanvas.height)

    const imgData = await new Promise((resolve) => {
      const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
      const url  = URL.createObjectURL(blob)
      const img  = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, W * DPR, H * DPR)
        URL.revokeObjectURL(url)
        resolve(offCanvas.toDataURL('image/png'))
      }
      img.src = url
    })

    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

    const PAGE_W    = 210
    const PAGE_H    = 297
    const MARGIN    = 16
    const CONTENT_W = PAGE_W - MARGIN * 2

    const drawTable = (headers, rows, x, startY, colWidths, rowH = 7) => {
      let ty      = startY
      const totalW = colWidths.reduce((a, b) => a + b, 0)

      doc.setFillColor(22, 22, 22)
      doc.rect(x, ty, totalW, rowH, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(8)
      doc.setTextColor(255, 255, 255)
      let tx = x
      headers.forEach((h, i) => {
        doc.text(h, tx + 2.5, ty + rowH - 2)
        tx += colWidths[i]
      })
      ty += rowH

      rows.forEach((row, ri) => {
        const shade = ri % 2 === 0 ? 248 : 255
        doc.setFillColor(shade, shade, shade)
        doc.rect(x, ty, totalW, rowH, 'F')
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8)
        doc.setTextColor(25, 25, 25)
        tx = x
        row.forEach((cell, i) => {
          doc.text(String(cell), tx + 2.5, ty + rowH - 2)
          tx += colWidths[i]
        })
        ty += rowH
      })

      doc.setDrawColor(185, 185, 185)
      doc.setLineWidth(0.2)
      doc.rect(x, startY, totalW, ty - startY)
      tx = x
      colWidths.slice(0, -1).forEach((w) => {
        tx += w
        doc.line(tx, startY, tx, ty)
      })
      for (let i = 1; i <= rows.length; i++) {
        doc.line(x, startY + i * rowH, x + totalW, startY + i * rowH)
      }

      return ty
    }

    let y = MARGIN

    // ── Title + date ──
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.setTextColor(0, 0, 0)
    doc.text('FEM Visualizer', MARGIN, y)

    const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(130, 130, 130)
    doc.text(dateStr, PAGE_W - MARGIN, y, { align: 'right' })

    y += 5
    doc.setDrawColor(210, 210, 210)
    doc.setLineWidth(0.4)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 7

    // ── Stress map image ──
    const imgAspect = H / W
    const imgW = CONTENT_W
    const imgH = Math.min(imgW * imgAspect, 95)
    doc.addImage(imgData, 'PNG', MARGIN, y, imgW, imgH)
    y += imgH + 9

    doc.setDrawColor(210, 210, 210)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y, PAGE_W - MARGIN, y)
    y += 7

    // ── Detect material ──
    const materialLabel = (() => {
      const E = params.E
      if (Math.abs(E - 200e9) < 1e9)  return 'Steel'
      if (Math.abs(E - 70e9)  < 1e9)  return 'Aluminum'
      if (Math.abs(E - 30e9)  < 1e9)  return 'Concrete'
      if (Math.abs(E - 116e9) < 1e9)  return 'Titanium'
      return 'Custom'
    })()

    const probLabel    = PROBLEMS[meshData.problem_type]?.label ?? 'Custom Shape'
    const isCustomShape = meshData.problem_type === 'custom'
    const ltLabel      = (loadType ?? 'point').charAt(0).toUpperCase() + (loadType ?? 'point').slice(1)

    // ── Input parameters ──
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(0, 0, 0)
    doc.text('Input Parameters', MARGIN, y)
    y += 5

    const paramRows = [
      ['Problem Type',          probLabel],
      ['Material',              materialLabel],
      ["Young's Modulus (E)",   `${(params.E / 1e9).toFixed(1)} GPa`],
      ['Poisson\'s Ratio (ν)',  params.nu.toFixed(2)],
      ...(isCustomShape ? [
        ['Mesh', `${meshData.nodes.length} nodes · ${meshData.elements.length} elements`],
      ] : [
        ['Width',  `${params.width.toFixed(2)} m`],
        ['Height', `${params.height.toFixed(2)} m`],
        ['Mesh',   `${meshData.nx}×${meshData.ny} Q4 elements`],
      ]),
      ['Load Magnitude', `${params.load.toLocaleString()} N`],
      ['Load Type',      ltLabel],
    ]
    y = drawTable(['Parameter', 'Value'], paramRows, MARGIN, y, [72, 106])
    y += 10

    // ── Analysis results ──
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(0, 0, 0)
    doc.text('Analysis Results', MARGIN, y)
    y += 5

    const resultRows = [
      ['Max Displacement',      `${(meshData.max_displacement * 1000).toPrecision(4)} mm`],
      ['Max Von Mises Stress',  `${(meshData.max_von_mises / 1e6).toPrecision(4)} MPa`],
      ['Nodes',                 meshData.nodes.length.toLocaleString()],
      ['Elements',              meshData.elements.length.toLocaleString()],
      ['Degrees of Freedom',    (meshData.nodes.length * 2).toLocaleString()],
    ]
    y = drawTable(['Metric', 'Value'], resultRows, MARGIN, y, [72, 106])
    y += 10

    // ── Factor of safety (optional) ──
    const yPa = yieldStrength && parseFloat(yieldStrength) > 0
      ? parseFloat(yieldStrength) * 1e6 : null
    if (yPa) {
      const minFoS       = yPa / meshData.max_von_mises
      const failingCount = meshData.von_mises.filter((vm) => vm > yPa).length
      const status       = minFoS >= 1.5 ? 'OK' : minFoS >= 1.0 ? 'MARGINAL' : 'FAIL'

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.setTextColor(0, 0, 0)
      doc.text('Factor of Safety', MARGIN, y)
      y += 5

      const fosRows = [
        ['Yield Strength',        `${parseFloat(yieldStrength).toFixed(0)} MPa`],
        ['Min Factor of Safety',  minFoS.toFixed(3)],
        ['Status',                status],
        ['Failing Elements',      failingCount.toString()],
      ]
      y = drawTable(['Parameter', 'Value'], fosRows, MARGIN, y, [72, 106])
    }

    // ── Footer ──
    doc.setDrawColor(210, 210, 210)
    doc.setLineWidth(0.2)
    doc.line(MARGIN, PAGE_H - 14, PAGE_W - MARGIN, PAGE_H - 14)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(160, 160, 160)
    doc.text('Generated by FEM Visualizer', PAGE_W / 2, PAGE_H - 9, { align: 'center' })

    doc.save(`fem-report-${new Date().toISOString().slice(0, 10)}.pdf`)
  }

  // ── Main draw effect ─────────────────────────────────────────────
  useEffect(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current)
      animFrameRef.current = null
    }
    if (!svgRef.current || !meshData) return

    const isNewSolve = newSolvePendingRef.current
    newSolvePendingRef.current = false

    const M  = compact ? M_COMPACT : M_FULL
    const el = containerRef.current
    const W  = el.clientWidth  || 800
    const H  = el.clientHeight || 500

    const drawW = W - M.left - M.right
    const drawH = H - M.top  - M.bottom

    const {
      nx, ny, nodes, elements, displacements,
      von_mises, node_vm, strain_mag, stresses,
      max_von_mises, max_displacement,
      max_disp_node_idx, max_vm_node_idx,
      problem_type, hole, load_type, fixed_nodes, load_nodes,
    } = meshData

    const isCustom = problem_type === 'custom'

    let originX = 0, originY = 0, geomW = params.width, geomH = params.height
    if (isCustom) {
      const xs = nodes.map((n) => n[0])
      const ys = nodes.map((n) => n[1])
      originX = Math.min(...xs)
      originY = Math.min(...ys)
      geomW = Math.max(...xs) - originX || 1
      geomH = Math.max(...ys) - originY || 1
    }

    const scX = drawW / geomW
    const scY = drawH / geomH
    const sc  = Math.min(scX, scY)
    const bW  = geomW * sc
    const bH  = geomH * sc
    const ox  = (drawW - bW) / 2
    const oy  = (drawH - bH) / 2

    const toX = (x) => ox + (x - originX) * sc
    const toY = (y) => oy + bH - (y - originY) * sc
    const polyPath = (pts) => `M${pts.map((p) => p.join(',')).join('L')}Z`

    const maxVM   = max_von_mises || 1
    const yieldPa = (yieldStrength && parseFloat(yieldStrength) > 0)
      ? parseFloat(yieldStrength) * 1e6 : null
    // When a yield strength is set, anchor the color scale to it instead of
    // re-normalizing to the current solve's own max — otherwise a uniform
    // scaling of stress (load magnitude, etc.) always repaints the exact
    // same colors since everything gets rescaled to fill 0..max again.
    const colorDomainMax = yieldPa ? yieldPa * 1.15 : maxVM

    const useUndeformed = viewMode === 'undeformed' || viewMode === 'safety' || (viewMode === 'deformed' && showOriginal)
    const colorScale    = d3.scaleSequential(stressInterp).domain([0, colorDomainMax]).clamp(true)
    const fosColorScale = d3.scaleSequential(fosInterp).domain([0, 4]).clamp(true)

    // Use smooth contours only for uniform rectangular meshes
    const useContour = viewMode === 'stress' &&
      ['cantilever', 'simply_supported', 'fixed_fixed'].includes(problem_type)

    // ── Draw function (called each animation frame) ────────────────
    // waveT: 0..1 progress of the post-solve stress reveal sweep; 1 means
    // fully revealed (the normal, non-animated state).
    const drawFrame = (animDispScale, waveT = 1) => {
      const pos = nodes.map((n, i) => {
        if (useUndeformed) return [toX(n[0]), toY(n[1])]
        const [ux, uy] = displacements[i]
        return [toX(n[0] + ux * animDispScale), toY(n[1] + uy * animDispScale)]
      })

      const svg = d3.select(svgRef.current)
      svg.selectAll('*').remove()
      svg.attr('viewBox', `0 0 ${W} ${H}`)

      const defs = svg.append('defs')

      // Colorbar gradient
      const grad = defs.append('linearGradient')
        .attr('id', 'cb-grad')
        .attr('x1', '0%').attr('x2', '0%')
        .attr('y1', '100%').attr('y2', '0%')
      d3.range(STRESS_COLORS.length).forEach((i) => {
        const t = i / (STRESS_COLORS.length - 1)
        grad.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', stressInterp(t))
      })

      // Arrow markers
      const mkr = (id, color) => defs.append('marker')
        .attr('id', id).attr('viewBox', '0 -4 8 8')
        .attr('refX', 6).attr('refY', 0)
        .attr('markerWidth', 4).attr('markerHeight', 4)
        .attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L8,0L0,4Z').attr('fill', color)
      mkr('arr-load', '#FFFFFF')
      mkr('arr-react', '#A0A0A0')

      // Small arrowhead for principal stress vectors
      defs.append('marker')
        .attr('id', `arr-vec-${instanceId}`)
        .attr('viewBox', '0 -3 6 6').attr('refX', 5).attr('refY', 0)
        .attr('markerWidth', 3.5).attr('markerHeight', 3.5).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-3L6,0L0,3Z').attr('fill', 'rgba(255,255,255,0.9)')

      // FoS gradient (only built when safety view is active)
      if (viewMode === 'safety' && yieldPa) {
        const fGrad = defs.append('linearGradient')
          .attr('id', `fos-grad-${instanceId}`)
          .attr('x1', '0%').attr('x2', '0%').attr('y1', '100%').attr('y2', '0%')
        FOS_COLORS.forEach((c, i) => {
          fGrad.append('stop')
            .attr('offset', `${(i / (FOS_COLORS.length - 1)) * 100}%`)
            .attr('stop-color', c)
        })
      }

      const zoomLayer = svg.append('g').attr('class', 'zoom-layer').attr('transform', zoomRef.current)
      const g = zoomLayer.append('g').attr('transform', `translate(${M.left},${M.top})`)

      // Fixed overlay (colorbar, title, caption) — sibling of zoomLayer so it
      // never receives the zoom/pan transform and stays pinned to the panel.
      const gFixed = svg.append('g').attr('class', 'fixed-layer').attr('transform', `translate(${M.left},${M.top})`)

      /* ── Element hover tooltip (shared by contour & per-element rendering) ── */
      const tip = d3.select(tipRef.current)
      const tooltipHtml = (idx) => {
        const vm     = von_mises[idx]
        const strain = strain_mag ? strain_mag[idx] : null
        const fos    = yieldPa ? yieldPa / vm : null
        const fosColor = fos ? (fos < 1 ? '#f87171' : fos < 1.5 ? '#fbbf24' : '#34d399') : null
        return `<b>Element #${idx}</b>` +
          `<br/><b>σ<sub>vm</sub></b> = ${(vm / 1e6).toFixed(3)} MPa` +
          (strain != null ? `<br/><b>ε</b> = ${strain.toExponential(3)}` : '') +
          (fos ? `<br/>FoS = <b style="color:${fosColor}">${fos.toFixed(2)}</b>` : '')
      }
      const bindElementTooltip = (sel) => {
        sel
          .on('mouseover', (event, elem) => {
            const idx = elements.indexOf(elem)
            tip.style('opacity', 1).html(tooltipHtml(idx))
          })
          .on('mousemove', (event) => {
            const rect = containerRef.current.getBoundingClientRect()
            tip
              .style('left', `${event.clientX - rect.left + 14}px`)
              .style('top',  `${event.clientY - rect.top  - 34}px`)
          })
          .on('mouseout', () => tip.style('opacity', 0))
      }

      /* ── Post-solve stress reveal wave ── */
      // Builds a soft-edged gradient mask that sweeps from the least-displaced
      // ("fixed") end of the structure toward the most-displaced ("loaded")
      // end, so stress colors fade in along the load path rather than
      // appearing all at once. Only built while actively animating (waveT<1);
      // the settled (waveT===1) render skips this entirely so the final
      // state is pixel-identical to the pre-animation rendering.
      let waveMaskId = null
      if (viewMode === 'stress' && waveT < 1) {
        const dispMag = displacements.map(([ux, uy]) => Math.hypot(ux, uy))
        let minIdx = 0, maxIdx = 0
        for (let i = 1; i < dispMag.length; i++) {
          if (dispMag[i] < dispMag[minIdx]) minIdx = i
          if (dispMag[i] > dispMag[maxIdx]) maxIdx = i
        }
        let [gx1, gy1] = pos[minIdx]
        let [gx2, gy2] = pos[maxIdx]
        if (Math.hypot(gx2 - gx1, gy2 - gy1) < 1) {
          // Degenerate (near-uniform displacement) — fall back to a plain
          // left-to-right sweep so the animation still reads as a wave.
          gx1 = ox; gy1 = oy + bH / 2
          gx2 = ox + bW; gy2 = oy + bH / 2
        }

        const gradId = `wave-grad-${instanceId}`
        waveMaskId = `wave-mask-${instanceId}`
        const waveGrad = defs.append('linearGradient')
          .attr('id', gradId)
          .attr('gradientUnits', 'userSpaceOnUse')
          .attr('x1', gx1).attr('y1', gy1).attr('x2', gx2).attr('y2', gy2)

        const band = 0.18
        const clamp01 = (v) => Math.max(0, Math.min(1, v))
        const stops = [
          [0,                              1],
          [clamp01(waveT - band),          1],
          [clamp01(waveT),                 0.45],
          [clamp01(waveT + band * 0.4),    0],
          [1,                              0],
        ]
        stops.forEach(([offset, opacity]) => {
          waveGrad.append('stop')
            .attr('offset', `${offset * 100}%`)
            .attr('stop-color', '#fff')
            .attr('stop-opacity', opacity)
        })

        defs.append('mask').attr('id', waveMaskId).attr('maskUnits', 'userSpaceOnUse')
          .append('rect')
          .attr('x', ox - 60).attr('y', oy - 60)
          .attr('width', bW + 120).attr('height', bH + 120)
          .attr('fill', `url(#${gradId})`)
      }

      /* ── Safety (FoS) rendering ── */
      if (viewMode === 'safety') {
        const safeG = g.append('g').attr('class', 'elements-safety')

        if (!yieldPa) {
          // No yield strength — draw gray mesh with prompt
          safeG.selectAll('path').data(elements).join('path')
            .attr('d', (elem) => polyPath(elem.map((n) => pos[n])))
            .attr('fill', 'rgba(55,55,55,0.9)')
            .attr('stroke', 'rgba(255,255,255,0.12)').attr('stroke-width', 0.5)
          g.append('text')
            .attr('x', ox + bW / 2).attr('y', oy + bH / 2 - 8)
            .attr('text-anchor', 'middle').attr('fill', '#606060')
            .attr('font-size', 13).attr('font-weight', 500)
            .text('Enter a yield strength in the Factor of Safety panel')
          g.append('text')
            .attr('x', ox + bW / 2).attr('y', oy + bH / 2 + 11)
            .attr('text-anchor', 'middle').attr('fill', '#606060')
            .attr('font-size', 13)
            .text('to view the safety map')
        } else {
          safeG.selectAll('path').data(elements).join('path')
            .attr('d', (elem) => polyPath(elem.map((n) => pos[n])))
            .attr('fill', (_, i) => fosColorScale((von_mises[i] > 0 ? yieldPa / von_mises[i] : 4)))
            .attr('stroke', 'rgba(0,0,0,0.12)').attr('stroke-width', 0.3)
        }

      /* ── Stress rendering ── */
      } else if (useContour) {
        const gridW = nx + 1
        const gridH = ny + 1
        const grid  = new Float64Array(gridW * gridH)
        for (let j = 0; j <= ny; j++)
          for (let i = 0; i <= nx; i++)
            grid[i + (ny - j) * gridW] = node_vm[j * gridW + i] ?? 0

        const thresholds = d3.range(33).map((k) => (k / 32) * colorDomainMax)
        const contourGen = d3.contours().size([gridW, gridH]).thresholds(thresholds).smooth(true)
        const contours   = contourGen(grid)

        const transform = d3.geoTransform({
          point(gx, gy) { this.stream.point(ox + (gx / nx) * bW, oy + (gy / ny) * bH) },
        })
        const pathFn = d3.geoPath().projection(transform)

        defs.append('clipPath').attr('id', 'beam-clip')
          .append('rect').attr('x', ox).attr('y', oy).attr('width', bW).attr('height', bH)

        const cg = g.append('g').attr('clip-path', 'url(#beam-clip)')
        if (waveMaskId) cg.attr('mask', `url(#${waveMaskId})`)
        contours.forEach((c) => {
          cg.append('path').attr('d', pathFn(c))
            .attr('fill', colorScale(c.value)).attr('stroke', 'none')
        })

        g.append('g').selectAll('path').data(elements).join('path')
          .attr('d', (elem) => polyPath(elem.map((n) => [toX(nodes[n][0]), toY(nodes[n][1])])))
          .attr('fill', 'none')
          .attr('stroke', 'rgba(255,255,255,0.07)')
          .attr('stroke-width', 0.5)

        if (yieldPa) {
          const fosG = g.append('g').attr('class', 'fos-overlay')
          elements.forEach((elem, i) => {
            if (von_mises[i] <= yieldPa) return
            const pts = elem.map((n) => [toX(nodes[n][0]), toY(nodes[n][1])])
            fosG.append('path')
              .attr('d', polyPath(pts))
              .attr('class', 'fos-fail-elem')
              .attr('fill', 'rgba(220,38,38,0.55)')
              .attr('stroke', '#ef4444')
              .attr('stroke-width', 0.8)
          })
        }

        // Invisible hit-test layer on top — the contour fill below it is its
        // own set of paths (one per threshold band, not per element), so
        // element-level hover needs a dedicated transparent overlay.
        const hitSel = g.append('g').attr('class', 'hit-layer')
          .selectAll('path').data(elements).join('path')
          .attr('d', (elem) => polyPath(elem.map((n) => [toX(nodes[n][0]), toY(nodes[n][1])])))
          .attr('fill', 'transparent')
          .attr('stroke', 'none')
        bindElementTooltip(hitSel)

      } else {
        // Per-element coloring (used for shaped/masked geometries and mesh/deformed views)
        const showStress = viewMode === 'deformed' || viewMode === 'stress'

        if (viewMode === 'deformed' && !showOriginal) {
          g.append('g').selectAll('path').data(elements).join('path')
            .attr('d', (elem) => polyPath(elem.map((n) => [toX(nodes[n][0]), toY(nodes[n][1])])))
            .attr('fill', 'none')
            .attr('stroke', 'rgba(255,255,255,0.25)')
            .attr('stroke-width', 0.8)
            .attr('stroke-dasharray', '3 2')
        }

        const elemGroup = g.append('g').attr('class', 'elements')
        if (waveMaskId) elemGroup.attr('mask', `url(#${waveMaskId})`)
        const elemSel = elemGroup.selectAll('path').data(elements).join('path')
          .attr('d', (elem) => polyPath(elem.map((n) => pos[n])))
          .attr('fill', (elem, i) => {
            if (!showStress) return 'rgba(26,26,26,0.9)'
            const avg = elem.reduce((s, n) => s + (node_vm[n] ?? 0), 0) / elem.length
            return colorScale(avg)
          })
          .attr('stroke', showStress ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.3)')
          .attr('stroke-width', showStress ? 0.3 : 0.7)
          .attr('opacity', useUndeformed && viewMode !== 'deformed' ? 0.85 : 1)

        if (yieldPa && (showStress || viewMode === 'undeformed')) {
          const fosG = g.append('g').attr('class', 'fos-overlay')
          elements.forEach((elem, i) => {
            if (von_mises[i] <= yieldPa) return
            const pts = elem.map((n) => pos[n])
            fosG.append('path')
              .attr('d', polyPath(pts))
              .attr('class', 'fos-fail-elem')
              .attr('fill', 'rgba(220,38,38,0.58)')
              .attr('stroke', '#ef4444')
              .attr('stroke-width', 0.8)
          })
        }

        if (showStress) bindElementTooltip(elemSel)
      } // end else (per-element)

      /* ── Failed element overlay (crack propagation) ── */
      if (crackFailedElems?.size > 0) {
        const failG = g.append('g').attr('class', 'failed-elements')
        elements.forEach((elem, i) => {
          if (!crackFailedElems.has(i)) return
          failG.append('path')
            .attr('d', polyPath(elem.map((n) => [toX(nodes[n][0]), toY(nodes[n][1])])))
            .attr('fill', '#160000')
            .attr('stroke', '#3d0000')
            .attr('stroke-width', 0.8)
        })
      }

      /* ── Crack notch symbol ── */
      if (crackElemIdx !== null && crackElemIdx !== undefined && crackElemIdx >= 0 && crackElemIdx < elements.length) {
        const cElem = elements[crackElemIdx]
        const cx = cElem.reduce((s, n) => s + toX(nodes[n][0]), 0) / cElem.length
        const cy = cElem.reduce((s, n) => s + toY(nodes[n][1]), 0) / cElem.length
        const ns = Math.max(8, Math.sqrt((bW * bH) / Math.max(elements.length, 1)) * 0.55)
        const notchPath = `M${cx - ns / 2},${cy - ns / 2}L${cx},${cy + ns / 2}L${cx + ns / 2},${cy - ns / 2}`
        const notchG = g.append('g').attr('class', 'crack-notch')
        notchG.append('path')
          .attr('d', notchPath)
          .attr('fill', 'none').attr('stroke', 'rgba(255,60,60,0.35)').attr('stroke-width', 7)
          .attr('stroke-linejoin', 'miter')
        notchG.append('path')
          .attr('d', notchPath)
          .attr('fill', 'none').attr('stroke', '#FFFFFF').attr('stroke-width', 2.2)
          .attr('stroke-linejoin', 'miter').attr('stroke-linecap', 'round')
      }

      /* ── Hole outline ── */
      if ((problem_type === 'plate_hole' || problem_type === 'beam_hole') && hole) {
        g.append('circle')
          .attr('cx', toX(hole.cx)).attr('cy', toY(hole.cy)).attr('r', hole.r * sc)
          .attr('fill', 'var(--bg)')
          .attr('stroke', 'rgba(255,255,255,0.25)').attr('stroke-width', 1.5)
      }

      /* ── Boundary conditions ── */
      const bcG = g.append('g').attr('class', 'bc')

      const drawClamped = (nodeList, side) => {
        const dir = side === 'left' ? -1 : 1
        nodeList.forEach((ni) => {
          const [sx, sy_] = [toX(nodes[ni][0]), toY(nodes[ni][1])]
          bcG.append('polygon')
            .attr('points', `${sx},${sy_} ${sx + dir * 13},${sy_ - 6} ${sx + dir * 13},${sy_ + 6}`)
            .attr('fill', '#FFFFFF').attr('stroke', '#A0A0A0').attr('stroke-width', 0.8)
        })
        const lineX = side === 'left' ? ox - 13 : ox + bW + 13
        bcG.append('line')
          .attr('x1', lineX).attr('y1', oy - 4)
          .attr('x2', lineX).attr('y2', oy + bH + 4)
          .attr('stroke', '#A0A0A0').attr('stroke-width', 2)
        for (let k = 0; k <= 5; k++) {
          const yy = oy + (k / 5) * bH
          bcG.append('line')
            .attr('x1', lineX).attr('y1', yy)
            .attr('x2', lineX + dir * (-10)).attr('y2', yy + 8)
            .attr('stroke', '#A0A0A0').attr('stroke-width', 1)
        }
      }

      // Horizontal clamped wall along the top edge of a partial span
      const drawClampedTop = (xFrom, xTo) => {
        const lineY = oy - 13
        const fixedNodes = nodes.map((_, i) => i).filter(
          (i) => Math.abs(nodes[i][1] - params.height) < 1e-9 && nodes[i][0] <= xTo + 1e-9
        )
        fixedNodes.forEach((ni) => {
          const sx = toX(nodes[ni][0])
          // Triangle pointing upward (away from material — above the top edge)
          bcG.append('polygon')
            .attr('points', `${sx},${oy} ${sx - 6},${lineY} ${sx + 6},${lineY}`)
            .attr('fill', '#FFFFFF').attr('stroke', '#A0A0A0').attr('stroke-width', 0.8)
        })
        bcG.append('line')
          .attr('x1', toX(xFrom)).attr('y1', lineY)
          .attr('x2', toX(xTo)).attr('y2', lineY)
          .attr('stroke', '#A0A0A0').attr('stroke-width', 2)
        const nHatch = Math.max(3, Math.round((xTo - xFrom) * sc / 12))
        for (let k = 0; k <= nHatch; k++) {
          const xx = toX(xFrom + k * (xTo - xFrom) / nHatch)
          bcG.append('line')
            .attr('x1', xx).attr('y1', lineY)
            .attr('x2', xx - 8).attr('y2', lineY - 8)
            .attr('stroke', '#A0A0A0').attr('stroke-width', 1)
        }
      }

      const drawPin = (nx_, ny_) => {
        const sx = toX(nx_), sy_ = toY(ny_)
        bcG.append('polygon')
          .attr('points', `${sx},${sy_} ${sx - 9},${sy_ + 14} ${sx + 9},${sy_ + 14}`)
          .attr('fill', '#FFFFFF').attr('stroke', '#A0A0A0').attr('stroke-width', 0.8)
        bcG.append('line')
          .attr('x1', sx - 12).attr('y1', sy_ + 15)
          .attr('x2', sx + 12).attr('y2', sy_ + 15)
          .attr('stroke', '#A0A0A0').attr('stroke-width', 2)
      }

      const drawRoller = (nx_, ny_) => {
        const sx = toX(nx_), sy_ = toY(ny_)
        bcG.append('polygon')
          .attr('points', `${sx},${sy_} ${sx - 9},${sy_ + 12} ${sx + 9},${sy_ + 12}`)
          .attr('fill', 'none').attr('stroke', '#FFFFFF').attr('stroke-width', 1.5)
        bcG.append('circle').attr('cx', sx - 5).attr('cy', sy_ + 16).attr('r', 3).attr('fill', '#FFFFFF')
        bcG.append('circle').attr('cx', sx + 5).attr('cy', sy_ + 16).attr('r', 3).attr('fill', '#FFFFFF')
      }

      if (problem_type === 'cantilever' || problem_type === 'beam_hole') {
        drawClamped(nodes.map((_, i) => i).filter((i) => nodes[i][0] < 1e-10), 'left')
      } else if (problem_type === 'simply_supported') {
        drawPin(0, 0); drawRoller(params.width, 0)
      } else if (problem_type === 'fixed_fixed') {
        drawClamped(nodes.map((_, i) => i).filter((i) => nodes[i][0] < 1e-10), 'left')
        drawClamped(nodes.map((_, i) => i).filter((i) => Math.abs(nodes[i][0] - params.width) < 1e-10), 'right')
      } else if (problem_type === 'plate_hole') {
        drawClamped(nodes.map((_, i) => i).filter((i) => nodes[i][0] < 1e-10), 'left')
      } else if (problem_type === 'l_bracket') {
        const legW = params.width * L_BRACKET_LEG_FRAC
        drawClampedTop(0, legW)
      } else if (problem_type === 't_beam') {
        const webX1 = params.width * (0.5 - T_BEAM_WEB_FRAC / 2)
        const webX2 = params.width * (0.5 + T_BEAM_WEB_FRAC / 2)
        drawPin(webX1, 0)
        drawRoller(webX2, 0)
      } else if (isCustom) {
        (fixed_nodes || []).forEach((ni) => {
          const [sx, sy_] = [toX(nodes[ni][0]), toY(nodes[ni][1])]
          bcG.append('rect')
            .attr('x', sx - 5).attr('y', sy_ - 5).attr('width', 10).attr('height', 10)
            .attr('fill', '#FFFFFF').attr('stroke', '#A0A0A0').attr('stroke-width', 1)
            .attr('transform', `rotate(45,${sx},${sy_})`)
        })
      }

      /* ── Load arrows ── */
      const loadG = g.append('g')

      const drawArrow = (x1, y1, x2, y2, label) => {
        loadG.append('line')
          .attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
          .attr('stroke', '#FFFFFF').attr('stroke-width', 2.5)
          .attr('marker-end', 'url(#arr-load)')
        if (label) {
          loadG.append('text')
            .attr('x', x1).attr('y', y1 - 6)
            .attr('fill', '#FFFFFF').attr('font-size', 11).attr('font-weight', 600)
            .attr('text-anchor', 'middle')
            .text(label)
        }
      }

      const arrowLen = 34
      const isRectDistributed = load_type === 'distributed' &&
        ['cantilever', 'simply_supported', 'fixed_fixed'].includes(problem_type)

      // Force vector (fx, fy) is in FEM coordinates (y-up); screen space is
      // y-down, so the y component is flipped when projecting the direction.
      const drawCustomLoadArrow = (nodeIdx, fx, fy) => {
        const mag = Math.hypot(fx, fy)
        if (mag < 1e-9 || nodeIdx < 0 || nodeIdx >= nodes.length) return
        const [px, py] = useUndeformed ? [toX(nodes[nodeIdx][0]), toY(nodes[nodeIdx][1])] : pos[nodeIdx]
        const dirX = fx / mag, dirY = -fy / mag
        drawArrow(
          px - dirX * arrowLen, py - dirY * arrowLen,
          px - dirX * 3,        py - dirY * 3,
          `${(mag / 1000).toFixed(2)} kN`,
        )
      }

      const drawUDL = (leftFemX, rightFemX, topFemY, labelText) => {
        const topY  = toY(topFemY)
        const barY  = topY - arrowLen
        const leftX = toX(leftFemX)
        const riteX = toX(rightFemX)
        loadG.append('line')
          .attr('x1', leftX).attr('y1', barY)
          .attr('x2', riteX).attr('y2', barY)
          .attr('stroke', '#FFFFFF').attr('stroke-width', 1.8)
        const nArrows = Math.min(10, Math.max(4, Math.round((riteX - leftX) / 60)))
        for (let k = 0; k <= nArrows; k++) {
          const ax = leftX + (k / nArrows) * (riteX - leftX)
          loadG.append('line')
            .attr('x1', ax).attr('y1', barY).attr('x2', ax).attr('y2', topY - 3)
            .attr('stroke', '#FFFFFF').attr('stroke-width', 1.8)
            .attr('marker-end', 'url(#arr-load)')
        }
        loadG.append('text')
          .attr('x', (leftX + riteX) / 2).attr('y', barY - 7)
          .attr('fill', '#FFFFFF').attr('font-size', 11).attr('font-weight', 600)
          .attr('text-anchor', 'middle')
          .text(labelText)
      }

      if (loadType === 'custom') {
        (customLoads || []).forEach((l) => drawCustomLoadArrow(l.node, l.fx, l.fy))

      } else if (isRectDistributed) {
        drawUDL(0, params.width, params.height,
          `w = ${(params.load / params.width / 1000).toFixed(2)} kN/m`)

      } else if (problem_type === 't_beam') {
        drawUDL(0, params.width, params.height,
          `w = ${(params.load / params.width / 1000).toFixed(2)} kN/m`)

      } else if (problem_type === 'cantilever' || problem_type === 'beam_hole') {
        const right = nodes.map((n, i) => [i, n]).filter(([, n]) => Math.abs(n[0] - params.width) < 1e-10)
        const mid   = right.reduce((b, c) => Math.abs(c[1][1] - params.height / 2) < Math.abs(b[1][1] - params.height / 2) ? c : b)
        const [ax, ay] = useUndeformed ? [toX(mid[1][0]), toY(mid[1][1])] : pos[mid[0]]
        const dy = params.load < 0 ? arrowLen : -arrowLen
        drawArrow(ax, ay - dy, ax, ay - (params.load < 0 ? 3 : -3), `${(params.load / 1000).toFixed(1)} kN`)

      } else if (problem_type === 'simply_supported') {
        const top = nodes.map((n, i) => [i, n]).filter(([, n]) => Math.abs(n[1] - params.height) < 1e-10)
        const mid = top.reduce((b, c) => Math.abs(c[1][0] - params.width / 2) < Math.abs(b[1][0] - params.width / 2) ? c : b)
        const [ax, ay] = useUndeformed ? [toX(mid[1][0]), toY(mid[1][1])] : pos[mid[0]]
        const dy = params.load < 0 ? arrowLen : -arrowLen
        drawArrow(ax, ay - dy, ax, ay - (params.load < 0 ? 3 : -3), `${(params.load / 1000).toFixed(1)} kN`)

      } else if (problem_type === 'fixed_fixed') {
        const midX = params.width / 2, midY = params.height / 2
        const mid  = nodes.map((n, i) => [i, n]).reduce((b, c) =>
          Math.hypot(c[1][0] - midX, c[1][1] - midY) < Math.hypot(b[1][0] - midX, b[1][1] - midY) ? c : b)
        const [ax, ay] = useUndeformed ? [toX(mid[1][0]), toY(mid[1][1])] : pos[mid[0]]
        const dy = params.load < 0 ? arrowLen : -arrowLen
        drawArrow(ax, ay - dy, ax, ay - (params.load < 0 ? 3 : -3), `${(params.load / 1000).toFixed(1)} kN`)

      } else if (problem_type === 'plate_hole') {
        const right = nodes.map((n, i) => [i, n]).filter(([, n]) => Math.abs(n[0] - params.width) < 1e-10)
        const ystep = Math.max(1, Math.floor(right.length / 4))
        right.filter((_, i) => i % ystep === 0).slice(0, 5).forEach(([ni, n]) => {
          const ax = useUndeformed ? toX(n[0]) : pos[ni][0]
          const ay = useUndeformed ? toY(n[1]) : pos[ni][1]
          loadG.append('line')
            .attr('x1', ax).attr('y1', ay).attr('x2', ax + arrowLen).attr('y2', ay)
            .attr('stroke', '#FFFFFF').attr('stroke-width', 2.5)
            .attr('marker-end', 'url(#arr-load)')
        })
        loadG.append('text')
          .attr('x', toX(params.width) + arrowLen + 8).attr('y', toY(params.height / 2))
          .attr('fill', '#FFFFFF').attr('font-size', 11).attr('font-weight', 600)
          .text(`${(params.load / 1000).toFixed(0)} kN`)

      } else if (problem_type === 'l_bracket') {
        const legH = params.height * L_BRACKET_LEG_FRAC
        const ax   = toX(params.width)
        const ay   = toY(legH / 2)
        const dy   = params.load < 0 ? arrowLen : -arrowLen
        drawArrow(ax, ay - dy, ax, ay - (params.load < 0 ? 3 : -3), `${(params.load / 1000).toFixed(1)} kN`)

      } else if (isCustom) {
        const loadNodes = load_nodes || []
        const dy = params.load < 0 ? arrowLen : -arrowLen
        loadNodes.forEach((ni) => {
          const [ax, ay] = useUndeformed ? [toX(nodes[ni][0]), toY(nodes[ni][1])] : pos[ni]
          loadG.append('line')
            .attr('x1', ax).attr('y1', ay - dy).attr('x2', ax).attr('y2', ay - (params.load < 0 ? 3 : -3))
            .attr('stroke', '#FFFFFF').attr('stroke-width', 2)
            .attr('marker-end', 'url(#arr-load)')
        })
        if (loadNodes.length) {
          const mid = loadNodes[Math.floor(loadNodes.length / 2)]
          const [ax, ay] = useUndeformed ? [toX(nodes[mid][0]), toY(nodes[mid][1])] : pos[mid]
          loadG.append('text')
            .attr('x', ax).attr('y', ay - dy - 6)
            .attr('fill', '#FFFFFF').attr('font-size', 11).attr('font-weight', 600)
            .attr('text-anchor', 'middle')
            .text(`${(params.load / 1000).toFixed(1)} kN total`)
        }
      }

      /* ── Custom load placement — click any node to add/edit a load ── */
      if (loadType === 'custom' && typeof setCustomLoads === 'function') {
        const loadedSet = new Set((customLoads || []).map((l) => l.node))
        const hitG = g.append('g').attr('class', 'node-load-hit-layer')
        hitG.selectAll('circle').data(nodes.map((_, i) => i)).join('circle')
          .attr('cx', (i) => pos[i][0])
          .attr('cy', (i) => pos[i][1])
          .attr('r', (i) => loadedSet.has(i) ? 5.5 : 3.5)
          .attr('class', (i) => `node-load-hit${loadedSet.has(i) ? ' loaded' : ''}`)
          .on('click', (event, i) => {
            event.stopPropagation()
            const rect = containerRef.current.getBoundingClientRect()
            const screenX = event.clientX - rect.left
            const screenY = event.clientY - rect.top
            if (!(customLoads || []).some((l) => l.node === i)) {
              setCustomLoads([...(customLoads || []), { node: i, fx: 0, fy: -1000 }])
            }
            setEditingLoad({ node: i, x: screenX, y: screenY })
          })
      }

      /* ── Crack placement hit overlay ── */
      if (crackPlacementActive && typeof onCrackPlace === 'function') {
        const crackHitG = g.append('g').attr('class', 'crack-hit-layer')
        crackHitG.selectAll('path').data(elements.map((_, i) => i)).join('path')
          .attr('d', (i) => polyPath(elements[i].map((n) => [toX(nodes[n][0]), toY(nodes[n][1])])))
          .attr('fill', 'transparent')
          .attr('stroke', 'rgba(255,90,90,0.22)')
          .attr('stroke-width', 0.8)
          .attr('cursor', 'crosshair')
          .on('click', (event, i) => {
            event.stopPropagation()
            const elem = elements[i]
            const centX = elem.reduce((s, n) => s + nodes[n][0], 0) / elem.length
            const centY = elem.reduce((s, n) => s + nodes[n][1], 0) / elem.length
            onCrackPlace(i, centX, centY)
          })
      }

      /* ── Annotation callouts ── */
      if (!compact && viewMode !== 'undeformed' && !showOriginal) {
        const annotG = g.append('g').attr('class', 'annotations')

        const drawCallout = (nodeIdx, label, value, opts = {}) => {
          if (nodeIdx < 0 || nodeIdx >= nodes.length) return
          const [px, py] = pos[nodeIdx]
          const { color = '#FFFFFF', offsetX = 30, offsetY = -85 } = opts
          const pad = 5
          const textLines = [label, value]
          const boxW = Math.max(...textLines.map((t) => t.length)) * 6.5 + pad * 2 + 2
          const boxH = textLines.length * 14 + pad * 2
          const bx   = px + offsetX
          const by   = py + offsetY

          let adjX = offsetX
          if (offsetX >= 0 && bx + boxW > drawW - 8) adjX = -boxW - Math.abs(offsetX)
          if (px + adjX < 4) adjX = 4 - px

          const tbx     = px + adjX
          const leaderX = adjX < 0 ? tbx + boxW : tbx

          annotG.append('line')
            .attr('x1', px).attr('y1', py)
            .attr('x2', leaderX).attr('y2', by + boxH / 2)
            .attr('stroke', color).attr('stroke-width', 1)
            .attr('stroke-dasharray', '4 2').attr('opacity', 0.8)

          annotG.append('rect')
            .attr('x', tbx).attr('y', by).attr('width', boxW).attr('height', boxH)
            .attr('rx', 4).attr('fill', 'rgba(17,17,17,0.85)')
            .attr('stroke', color).attr('stroke-width', 1.2)

          textLines.forEach((line, k) => {
            annotG.append('text')
              .attr('x', tbx + pad + 1).attr('y', by + pad + 11 + k * 14)
              .attr('fill', k === 0 ? color : '#E5E5E5')
              .attr('font-size', k === 0 ? 10 : 10.5)
              .attr('font-weight', k === 0 ? 700 : 400)
              .attr('font-family', 'monospace')
              .text(line)
          })

          annotG.append('circle').attr('cx', px).attr('cy', py).attr('r', 4.5)
            .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.8)
          annotG.append('circle').attr('cx', px).attr('cy', py).attr('r', 1.5).attr('fill', color)
        }

        drawCallout(max_disp_node_idx, 'max |U|',
          `${(max_displacement * 1000).toExponential(3)} mm`,
          { color: '#FFFFFF', offsetX: 60, offsetY: -85 })

        drawCallout(max_vm_node_idx, 'max σ_vm',
          `${(max_von_mises / 1e6).toFixed(3)} MPa`,
          { color: '#CCCCCC', offsetX: -60, offsetY: -85 })
      }

      /* ── Colorbar ── */
      if (viewMode !== 'undeformed') {
        const cbX = drawW + (compact ? 22 : 36)
        const cbH = bH
        const cbW = compact ? 12 : 16
        const cardPad   = compact ? 8 : 12
        const cardRight = compact ? 58 : 86

        gFixed.append('rect')
          .attr('x', cbX - cardPad).attr('y', oy - cardPad)
          .attr('width', cbW + cardPad + cardRight).attr('height', cbH + cardPad * 2)
          .attr('rx', 14)
          .attr('fill', 'rgba(17,17,17,0.55)')
          .attr('stroke', 'rgba(255,255,255,0.18)').attr('stroke-width', 1)
          .style('filter', 'drop-shadow(0 0 14px rgba(255,255,255,0.10))')

        if (viewMode === 'safety' && yieldPa) {
          // ── FoS colorbar ──
          gFixed.append('rect')
            .attr('x', cbX).attr('y', oy).attr('width', cbW).attr('height', cbH)
            .attr('fill', `url(#fos-grad-${instanceId})`).attr('rx', 4)
            .attr('stroke', 'rgba(255,255,255,0.12)').attr('stroke-width', 0.5)

          const fosBarScale = d3.scaleLinear().domain([0, 4]).range([oy + cbH, oy])
          const fosTicks    = [0, 1, 2, 3, 4]
          fosTicks.forEach((v) => {
            const ty = fosBarScale(v)
            gFixed.append('line')
              .attr('x1', cbX + cbW).attr('y1', ty)
              .attr('x2', cbX + cbW + 4).attr('y2', ty)
              .attr('stroke', 'rgba(255,255,255,0.4)').attr('stroke-width', 0.8)
            gFixed.append('text')
              .attr('x', cbX + cbW + 7).attr('y', ty + 4)
              .attr('fill', '#A0A0A0').attr('font-size', compact ? 8 : 9.5)
              .text(v === 4 ? '4+' : String(v))
          })
          // Yield line at FoS = 1
          const tyYield = fosBarScale(1)
          gFixed.append('line')
            .attr('x1', cbX - 4).attr('y1', tyYield)
            .attr('x2', cbX + cbW + 4).attr('y2', tyYield)
            .attr('stroke', '#ef4444').attr('stroke-width', 1.5)
            .attr('stroke-dasharray', '3 2')
          if (!compact) {
            gFixed.append('text')
              .attr('transform', `translate(${cbX + cbW + 52},${oy + cbH / 2}) rotate(-90)`)
              .attr('text-anchor', 'middle').attr('fill', '#A0A0A0').attr('font-size', 10)
              .text('Factor of Safety')
          }
        } else {
          // ── Von Mises stress colorbar ──
          gFixed.append('rect')
            .attr('x', cbX).attr('y', oy).attr('width', cbW).attr('height', cbH)
            .attr('fill', 'url(#cb-grad)').attr('rx', 4)
            .attr('stroke', 'rgba(255,255,255,0.12)').attr('stroke-width', 0.5)

          const cbScale = d3.scaleLinear().domain([0, colorDomainMax]).range([oy + cbH, oy])
          d3.range(6).map((i) => (i / 5) * colorDomainMax).forEach((v) => {
            const ty = cbScale(v)
            gFixed.append('line')
              .attr('x1', cbX + cbW).attr('y1', ty)
              .attr('x2', cbX + cbW + 4).attr('y2', ty)
              .attr('stroke', 'rgba(255,255,255,0.4)').attr('stroke-width', 0.8)
            gFixed.append('text')
              .attr('x', cbX + cbW + 7).attr('y', ty + 4)
              .attr('fill', '#A0A0A0').attr('font-size', compact ? 8 : 9.5)
              .text(`${(v / 1e6).toFixed(compact ? 1 : 2)}`)
          })

          if (yieldPa && yieldPa <= colorDomainMax) {
            const ty = cbScale(yieldPa)
            gFixed.append('line')
              .attr('x1', cbX - 4).attr('y1', ty)
              .attr('x2', cbX + cbW + 4).attr('y2', ty)
              .attr('stroke', '#ef4444').attr('stroke-width', 1.5)
              .attr('stroke-dasharray', '3 2')
            gFixed.append('text')
              .attr('x', cbX - 6).attr('y', ty + 4)
              .attr('fill', '#ef4444').attr('font-size', 9).attr('text-anchor', 'end')
              .text('yield')
          }

          if (!compact) {
            gFixed.append('text')
              .attr('transform', `translate(${cbX + cbW + 52},${oy + cbH / 2}) rotate(-90)`)
              .attr('text-anchor', 'middle').attr('fill', '#A0A0A0').attr('font-size', 10)
              .text('von Mises [MPa]')
          }
        }
      }

      /* ── Principal stress vectors ── */
      if (showVectors && stresses?.length > 0) {
        const vecG     = g.append('g').attr('class', 'stress-vectors')
        const maxVM    = max_von_mises || 1
        const density  = vectorDensity ?? 2
        // Arrow length scaled to roughly 70% of average element dimension
        const avgElemSize = Math.sqrt((bW * bH) / Math.max(elements.length, 1))
        const maxArrowLen = avgElemSize * 0.7

        elements.forEach((elem, i) => {
          if (i % density !== 0) return
          const s = stresses[i]
          if (!s) return
          const [sx, sy, txy] = s

          // Max principal stress magnitude and direction
          const R      = Math.sqrt(((sx - sy) / 2) ** 2 + txy ** 2)
          const sigma1 = (sx + sy) / 2 + R
          const len    = (Math.abs(sigma1) / maxVM) * maxArrowLen
          if (len < 1.5) return

          const theta = 0.5 * Math.atan2(2 * txy, sx - sy)  // angle from x-axis

          // Centroid in screen space
          const cx = elem.reduce((sum, n) => sum + pos[n][0], 0) / elem.length
          const cy = elem.reduce((sum, n) => sum + pos[n][1], 0) / elem.length

          // SVG y is flipped relative to FEM y
          const dx = Math.cos(theta) * len
          const dy = -Math.sin(theta) * len

          vecG.append('line')
            .attr('x1', cx).attr('y1', cy)
            .attr('x2', cx + dx).attr('y2', cy + dy)
            .attr('stroke', sigma1 > 0 ? 'rgba(255,255,255,0.82)' : 'rgba(160,200,255,0.82)')
            .attr('stroke-width', 1.1)
            .attr('marker-end', `url(#arr-vec-${instanceId})`)
        })
      }

      /* ── Caption / title ── */
      gFixed.append('text')
        .attr('x', ox + bW / 2).attr('y', drawH + (compact ? 26 : 36))
        .attr('text-anchor', 'middle').attr('fill', '#707070').attr('font-size', compact ? 9 : 11)
        .text(isCustom
          ? `${nodes.length} nodes  ·  ${elements.length} CST triangles`
          : `${params.width} m × ${params.height} m  ·  ${meshData.nx}×${meshData.ny} Q4`)

      const titleMap = {
        undeformed: 'Undeformed Mesh',
        deformed:   showOriginal ? 'Original (Undeformed)' : `Deformed  (×${Math.round(animDispScale)})`,
        stress:     `von Mises Stress  (×${Math.round(animDispScale)})`,
        safety:     yieldPa ? 'Factor of Safety Map' : 'Safety Map',
      }
      gFixed.append('text')
        .attr('x', ox + bW / 2).attr('y', compact ? -6 : -12)
        .attr('text-anchor', 'middle').attr('fill', '#FFFFFF')
        .attr('font-size', compact ? 10 : 12).attr('font-weight', 600)
        .text(titleMap[viewMode] ?? viewMode)
    } // end drawFrame

    // ── Animation ────────────────────────────────────────────────
    // Re-created on every redraw so it always closes over the current
    // dispScale/drawFrame; exposed via a ref so the Replay button (which
    // lives outside this effect) can re-trigger it on demand.
    const runWaveAnimation = () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      const start    = performance.now()
      const duration = 1500
      const loop = (now) => {
        const t    = Math.min(1, (now - start) / duration)
        const ease = 1 - Math.pow(1 - t, 3)
        drawFrame(dispScale, ease)
        if (t < 1) animFrameRef.current = requestAnimationFrame(loop)
        else animFrameRef.current = null
      }
      animFrameRef.current = requestAnimationFrame(loop)
    }
    replayWaveRef.current = viewMode === 'stress' ? runWaveAnimation : null

    if (isNewSolve && viewMode === 'deformed' && !showOriginal) {
      const start    = performance.now()
      const duration = 650
      const loop = (now) => {
        const t    = Math.min(1, (now - start) / duration)
        const ease = 1 - Math.pow(1 - t, 3)
        drawFrame(dispScale * ease)
        if (t < 1) animFrameRef.current = requestAnimationFrame(loop)
        else animFrameRef.current = null
      }
      animFrameRef.current = requestAnimationFrame(loop)
    } else if (isNewSolve && viewMode === 'stress') {
      runWaveAnimation()
    } else {
      drawFrame(dispScale, 1)
    }

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
    }
  }, [meshData, viewMode, dispScale, params, showOriginal, yieldStrength, compact, loadType, customLoads, showVectors, vectorDensity, crackPlacementActive, crackElemIdx, crackFailedElems, onCrackPlace])

  const editingEntry = editingLoad && (customLoads || []).find((l) => l.node === editingLoad.node)

  const patchLoad = (patch) => {
    setCustomLoads(customLoads.map((l) => (l.node === editingLoad.node ? { ...l, ...patch } : l)))
  }
  const removeLoad = () => {
    setCustomLoads(customLoads.filter((l) => l.node !== editingLoad.node))
    setEditingLoad(null)
  }

  useImperativeHandle(ref, () => ({
    exportPng: handleExport,
    exportReport: handleExportReport,
    resetView: handleResetView,
  }), [meshData])

  return (
    <div ref={containerRef} className="mesh-viewer">
      <svg ref={svgRef} />
      <div ref={tipRef} className="fem-tooltip" />
      {meshData && !compact && (
        <span className="zoom-hint">scroll to zoom · drag to pan</span>
      )}
      {meshData && !compact && viewMode === 'stress' && (
        <button
          className="export-btn replay-wave-btn"
          onClick={() => replayWaveRef.current?.()}
          title="Replay the stress sweep animation"
        >
          ⟳ Replay
        </button>
      )}
      {loadType === 'custom' && editingEntry && (
        <div className="load-edit-panel" style={{ left: editingLoad.x + 16, top: editingLoad.y - 20 }}>
          <div className="load-edit-header">Load @ Node #{editingLoad.node}</div>
          <label className="load-edit-field">
            <span>Fx (N)</span>
            <input
              type="number" step="100" value={editingEntry.fx}
              onChange={(e) => patchLoad({ fx: parseFloat(e.target.value) || 0 })}
            />
          </label>
          <label className="load-edit-field">
            <span>Fy (N)</span>
            <input
              type="number" step="100" value={editingEntry.fy}
              onChange={(e) => patchLoad({ fy: parseFloat(e.target.value) || 0 })}
            />
          </label>
          <div className="load-edit-mag">
            |F| = {(Math.hypot(editingEntry.fx, editingEntry.fy) / 1000).toFixed(2)} kN
          </div>
          <div className="load-edit-actions">
            <button className="load-edit-remove" onClick={removeLoad}>Remove</button>
            <button className="load-edit-done" onClick={() => setEditingLoad(null)}>Done</button>
          </div>
        </div>
      )}
    </div>
  )
})

export default MeshViewer
