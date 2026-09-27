# FEM Visualizer

A browser-based 2D finite element analysis tool for real-time structural simulation, crack propagation, and stress visualization.

---

## Screenshot

> _Screenshots coming soon_

| Canvas & Mesh | Stress Heatmap | Crack Propagation |
|:---:|:---:|:---:|
| ![canvas placeholder](https://placehold.co/280x180?text=Canvas+%26+Mesh) | ![stress placeholder](https://placehold.co/280x180?text=Stress+Heatmap) | ![crack placeholder](https://placehold.co/280x180?text=Crack+Propagation) |

---

## Features

- **Draw custom shapes** — freehand polygon drawing with automatic CST mesh generation
- **Real-time stress analysis** — von Mises stress heatmap with smooth D3 contour rendering
- **Crack propagation** — place a notch, watch progressive element failure animate step-by-step
- **Material presets** — common engineering materials with preset yield strengths
- **Export PDF report** — one-click report with mesh, stress plot, and analysis summary via jsPDF
- **Save / load projects** — persist your geometry and results as a portable JSON file

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite |
| Visualization | D3.js |
| Backend | Python, FastAPI, Uvicorn |
| Solver | NumPy, SciPy (Q4 bilinear elements, 2×2 Gauss quadrature) |
| PDF export | jsPDF |

---

## Running Locally

### Prerequisites

- Python 3.10+
- Node.js 18+

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --port 8000
```

The API will be available at `http://localhost:8000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The app will open at `http://localhost:3000`.

---

## Future Features

- [ ] 3D FEM support (hexahedral elements)
- [ ] Dynamic / time-domain loading
- [ ] Thermal stress coupling
- [ ] Mesh refinement controls (h-adaptivity)
- [ ] Multi-material regions within a single model
- [ ] Cloud save with shareable project links
- [ ] Animated load stepping for all preset problem types

---

## License

MIT
