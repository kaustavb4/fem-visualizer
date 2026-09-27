from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from fem import solve_fem, solve_custom_shape, solve_fem_crack_step

app = FastAPI(title='FEM Visualizer API')
app.add_middleware(
    CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'],
)


class CustomLoad(BaseModel):
    node: int
    fx: float = 0.0
    fy: float = 0.0


class FEMParams(BaseModel):
    nx: int = Field(16, ge=1, le=80)
    ny: int = Field(8, ge=1, le=40)
    width: float = Field(2.0, gt=0)
    height: float = Field(0.5, gt=0)
    E: float = Field(200e9, gt=0)
    nu: float = Field(0.3, gt=0, lt=0.5)
    load: float = -10_000.0
    problem_type: str = 'cantilever'
    load_type: str = 'point'
    custom_loads: list[CustomLoad] = []


@app.post('/solve')
def solve(params: FEMParams):
    try:
        return solve_fem(**params.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class CustomShapeParams(BaseModel):
    points: list[list[float]]
    E: float = Field(200e9, gt=0)
    nu: float = Field(0.3, gt=0, lt=0.5)
    load: float = -10_000.0
    mesh_density: int = Field(16, ge=4, le=40)
    custom_loads: list[CustomLoad] = []


@app.post('/solve_custom')
def solve_custom(params: CustomShapeParams):
    try:
        return solve_custom_shape(**params.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class CrackStepParams(BaseModel):
    nx: int = Field(16, ge=1, le=80)
    ny: int = Field(8, ge=1, le=40)
    width: float = Field(2.0, gt=0)
    height: float = Field(0.5, gt=0)
    E: float = Field(200e9, gt=0)
    nu: float = Field(0.3, gt=0, lt=0.5)
    load: float = -10_000.0
    problem_type: str = 'cantilever'
    load_type: str = 'point'
    load_factor: float = Field(1.0, ge=0.0, le=2.0)
    excluded_elements: list[int] = []


@app.post('/solve_crack_step')
def solve_crack_step(params: CrackStepParams):
    try:
        return solve_fem_crack_step(
            nx=params.nx, ny=params.ny,
            width=params.width, height=params.height,
            E=params.E, nu=params.nu,
            load=params.load * params.load_factor,
            problem_type=params.problem_type,
            load_type=params.load_type,
            excluded_elements=params.excluded_elements,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get('/health')
def health():
    return {'status': 'ok'}
