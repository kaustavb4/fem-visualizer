import { useState, useEffect } from 'react'

const STORAGE_KEY = 'fem_visualizer_welcomed'

export default function WelcomeModal() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true)
    }
  }, [])

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div className="welcome-overlay" onClick={dismiss}>
      <div className="welcome-modal" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-brand">
          <svg width="32" height="32" viewBox="0 0 20 20" fill="none">
            <polygon points="10,2 18,7 18,13 10,18 2,13 2,7" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <circle cx="10" cy="10" r="2.5" fill="currentColor"/>
          </svg>
          <h2>FEM Visualizer</h2>
        </div>
        <p className="welcome-tagline">Interactive 2D Finite Element Analysis in your browser</p>
        <ul className="welcome-features">
          <li>Draw custom shapes and define geometry visually</li>
          <li>Real-time stress analysis with von Mises visualization</li>
          <li>Export results as PNG images or PDF reports</li>
        </ul>
        <button className="welcome-btn" onClick={dismiss}>Get Started</button>
      </div>
    </div>
  )
}
