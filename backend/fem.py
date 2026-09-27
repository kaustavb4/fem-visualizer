import numpy as np
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import spsolve
from scipy.spatial import Delaunay
from scipy.spatial import QhullError


def create_mesh(nx: int, ny: int, width: float, height: float):
    xs = np.linspace(0, width, nx + 1)
    ys = np.linspace(0, height, ny + 1)
    nodes = np.array([[xs[i], ys[j]] for j in range(ny + 1) for i in range(nx + 1)], dtype=float)
    elements = []
    for j in range(ny):
        for i in range(nx):
            n1 = j * (nx + 1) + i
            n2 = j * (nx + 1) + i + 1
            n3 = (j + 1) * (nx + 1) + i + 1
            n4 = (j + 1) * (nx + 1) + i
            elements.append([n1, n2, n3, n4])
    return nodes, np.array(elements, dtype=int)


def _B_detJ(nodes_e: np.ndarray, xi: float, eta: float):
    dN_dxi = np.array([
        [-(1 - eta) / 4,  (1 - eta) / 4,  (1 + eta) / 4, -(1 + eta) / 4],
        [-(1 - xi)  / 4, -(1 + xi)  / 4,  (1 + xi)  / 4,  (1 - xi)  / 4],
    ])
    J = dN_dxi @ nodes_e
    detJ = float(np.linalg.det(J))
    dN_dxy = np.linalg.solve(J, dN_dxi)
    B = np.zeros((3, 8))
    for k in range(4):
        B[0, 2 * k]     = dN_dxy[0, k]
        B[1, 2 * k + 1] = dN_dxy[1, k]
        B[2, 2 * k]     = dN_dxy[1, k]
        B[2 , 2 * k + 1] = dN_dxy[0, k]
    return B, detJ


def _D(E: float, nu: float) -> np.ndarray:
    return E / (1 - nu ** 2) * np.array([
        [1,  nu,           0],
        [nu, 1,            0],
        [0,  0, (1 - nu) / 2],
    ])


def _ke(nodes_e: np.ndarray, D: np.ndarray, t: float = 1.0) -> np.ndarray:
    gp = [-1 / np.sqrt(3), 1 / np.sqrt(3)]
    ke = np.zeros((8, 8))
    for xi in gp:
        for eta in gp:
            B, detJ = _B_detJ(nodes_e, xi, eta)
            ke += B.T @ D @ B * detJ * t
    return ke


def _active_elements(problem_type: str, elements: np.ndarray,
                     nodes: np.ndarray, width: float, height: float) -> np.ndarray:
    if problem_type == 'plate_hole':
        cx, cy = width / 2, height / 2
        r = min(width, height) * 0.22
        mask = []
        for elem in elements:
            c = nodes[elem].mean(axis=0)
            mask.append((c[0] - cx) ** 2 + (c[1] - cy) ** 2 > r ** 2)
        return np.array(mask)

    if problem_type == 'beam_hole':
        cx, cy = width / 2, height / 2
        r = height * 0.28
        mask = []
        for elem in elements:
            c = nodes[elem].mean(axis=0)
            mask.append((c[0] - cx) ** 2 + (c[1] - cy) ** 2 > r ** 2)
        return np.array(mask)

    if problem_type == 'l_bracket':
        leg_w = width  * 0.35
        leg_h = height * 0.35
        mask = []
        for elem in elements:
            c = nodes[elem].mean(axis=0)
            mask.append(bool(c[0] <= leg_w or c[1] <= leg_h))
        return np.array(mask)

    if problem_type == 't_beam':
        web_x1   = width  * 0.375
        web_x2   = width  * 0.625
        flange_y = height * 0.70
        mask = []
        for elem in elements:
            c = nodes[elem].mean(axis=0)
            mask.append(bool((web_x1 <= c[0] <= web_x2) or (c[1] >= flange_y)))
        return np.array(mask)

    return np.ones(len(elements), dtype=bool)


def _setup_bc_load(problem_type: str, nodes: np.ndarray, elements: np.ndarray,
                   n_dof: int, width: float, height: float, load: float,
                   load_type: str = 'point', custom_loads: list | None = None):
    F = np.zeros(n_dof)
    constrained = set()
    # Custom loads replace the problem type's default load entirely (but the
    # default boundary fixities below are still applied) — the branches below
    # skip their default F[] assignment whenever custom_loads is supplied.
    use_default_load = not custom_loads

    def fix(idx, dofs=(0, 1)):
        for n in np.atleast_1d(idx):
            for d in dofs:
                constrained.add(2 * int(n) + d)

    def apply_top_udl(total):
        """Distribute total vertical force equally across all top-edge nodes."""
        top = np.where(np.isclose(nodes[:, 1], height))[0]
        per = total / len(top)
        for n in top:
            F[2 * n + 1] = per

    if problem_type == 'cantilever':
        fix(np.where(np.isclose(nodes[:, 0], 0))[0])
        if use_default_load:
            if load_type == 'distributed':
                apply_top_udl(load)
            else:
                right = np.where(np.isclose(nodes[:, 0], width))[0]
                mid = right[np.argmin(np.abs(nodes[right, 1] - height / 2))]
                F[2 * mid + 1] = load

    elif problem_type == 'simply_supported':
        bl = int(np.argmin(np.hypot(nodes[:, 0], nodes[:, 1])))
        br = int(np.argmin(np.hypot(nodes[:, 0] - width, nodes[:, 1])))
        fix(bl)
        fix(br, (1,))
        if use_default_load:
            if load_type == 'distributed':
                apply_top_udl(load)
            else:
                top = np.where(np.isclose(nodes[:, 1], height))[0]
                mid = top[np.argmin(np.abs(nodes[top, 0] - width / 2))]
                F[2 * mid + 1] = load

    elif problem_type == 'fixed_fixed':
        fix(np.where(np.isclose(nodes[:, 0], 0))[0])
        fix(np.where(np.isclose(nodes[:, 0], width))[0])
        if use_default_load:
            if load_type == 'distributed':
                apply_top_udl(load)
            else:
                dx = width / (2 * (len(np.unique(nodes[:, 0])) - 1))
                mid_col = np.where(np.abs(nodes[:, 0] - width / 2) < dx + 1e-9)[0]
                mid = mid_col[np.argmin(np.abs(nodes[mid_col, 1] - height / 2))]
                F[2 * mid + 1] = load

    elif problem_type == 'plate_hole':
        fix(np.where(np.isclose(nodes[:, 0], 0))[0])
        if use_default_load:
            right = np.where(np.isclose(nodes[:, 0], width))[0]
            per = abs(load) / len(right)
            for n in right:
                F[2 * n] = per

    elif problem_type == 'beam_hole':
        # Cantilever with tip load, same as cantilever
        fix(np.where(np.isclose(nodes[:, 0], 0))[0])
        if use_default_load:
            right = np.where(np.isclose(nodes[:, 0], width))[0]
            mid = right[np.argmin(np.abs(nodes[right, 1] - height / 2))]
            F[2 * mid + 1] = load

    elif problem_type == 'l_bracket':
        leg_w = width  * 0.35
        leg_h = height * 0.35
        # Fixed: top of vertical leg (y = height, x ≤ leg_w)
        top_vert = np.where(
            np.isclose(nodes[:, 1], height) & (nodes[:, 0] <= leg_w + 1e-9)
        )[0]
        fix(top_vert)
        if use_default_load:
            # Downward load at right end of horizontal leg (x = width, y ≤ leg_h)
            right_horiz = np.where(
                np.isclose(nodes[:, 0], width) & (nodes[:, 1] <= leg_h + 1e-9)
            )[0]
            if len(right_horiz) > 0:
                per = load / len(right_horiz)
                for n in right_horiz:
                    F[2 * n + 1] = per

    elif problem_type == 't_beam':
        web_x1 = width * 0.375
        web_x2 = width * 0.625
        # Pin-roller at bottom of web
        all_bottom = np.where(np.isclose(nodes[:, 1], 0))[0]
        in_web = (nodes[all_bottom, 0] >= web_x1 - 1e-9) & (nodes[all_bottom, 0] <= web_x2 + 1e-9)
        web_bottom = all_bottom[in_web]
        if len(web_bottom) == 0:
            web_bottom = all_bottom   # fallback
        pin    = web_bottom[np.argmin(nodes[web_bottom, 0])]
        roller = web_bottom[np.argmax(nodes[web_bottom, 0])]
        fix(pin)            # pin: both dofs
        fix(roller, (1,))   # roller: y dof only
        if use_default_load:
            # Distributed load on top flange (y = height, full width)
            top = np.where(np.isclose(nodes[:, 1], height))[0]
            per = load / len(top)
            for n in top:
                F[2 * n + 1] = per

    # Custom point loads — applied at arbitrary user-chosen nodes, on top of
    # whichever boundary fixities the problem type set up above.
    if custom_loads:
        for cl in custom_loads:
            n = int(cl['node'])
            F[2 * n]     += float(cl.get('fx', 0.0))
            F[2 * n + 1] += float(cl.get('fy', 0.0))

    # Constrain isolated nodes (not in any active element)
    active_set = set(elements.flatten())
    for n in range(len(nodes)):
        if n not in active_set:
            constrained.update([2 * n, 2 * n + 1])

    return sorted(constrained), F


def solve_fem(nx: int = 16, ny: int = 8, width: float = 2.0, height: float = 0.5,
              E: float = 200e9, nu: float = 0.3, load: float = -10_000.0,
              problem_type: str = 'cantilever', load_type: str = 'point',
              custom_loads: list | None = None) -> dict:

    nodes, all_elems = create_mesh(nx, ny, width, height)
    n_nodes = len(nodes)
    n_dof = 2 * n_nodes
    D = _D(E, nu)

    mask = _active_elements(problem_type, all_elems, nodes, width, height)
    elements = all_elems[mask]

    K = lil_matrix((n_dof, n_dof))
    for elem in elements:
        ke = _ke(nodes[elem], D)
        dofs = [2 * n + d for n in elem for d in range(2)]
        for i, di in enumerate(dofs):
            for j, dj in enumerate(dofs):
                K[di, dj] += ke[i, j]
    K = K.tocsr()

    constrained, F = _setup_bc_load(problem_type, nodes, elements, n_dof, width, height, load,
                                     load_type, custom_loads)
    free = [i for i in range(n_dof) if i not in set(constrained)]

    U = np.zeros(n_dof)
    if free:
        U[free] = spsolve(K[np.ix_(free, free)], F[free])

    elem_vm, elem_stress, elem_strain_mag = [], [], []
    for elem in elements:
        u_e = np.array([U[2 * n + d] for n in elem for d in range(2)])
        B, _ = _B_detJ(nodes[elem], 0.0, 0.0)
        eps = B @ u_e
        ex, ey, gxy = float(eps[0]), float(eps[1]), float(eps[2])
        elem_strain_mag.append(float(np.sqrt(ex ** 2 + ey ** 2 + gxy ** 2)))
        s = D @ eps
        sx, sy, txy = float(s[0]), float(s[1]), float(s[2])
        elem_stress.append([sx, sy, txy])
        elem_vm.append(float(np.sqrt(sx ** 2 - sx * sy + sy ** 2 + 3 * txy ** 2)))

    # Node-averaged von Mises (smoother than centroid)
    node_vm_acc = np.zeros(n_nodes)
    node_cnt    = np.zeros(n_nodes)
    for i, elem in enumerate(elements):
        for n in elem:
            node_vm_acc[n] += elem_vm[i]
            node_cnt[n] += 1
    safe_cnt = np.where(node_cnt > 0, node_cnt, 1.0)
    node_vm = np.where(node_cnt > 0, node_vm_acc / safe_cnt, 0.0)

    displacements = [[float(U[2 * i]), float(U[2 * i + 1])] for i in range(n_nodes)]

    # Locate max-displacement and max-stress nodes for annotations
    U_mag = np.hypot(U[0::2], U[1::2])
    max_disp = float(np.max(U_mag))
    if max_disp > 0:
        max_disp_node_idx = int(np.argmax(U_mag))
        max_vm_node_idx   = int(np.argmax(node_vm))
    else:
        max_disp_node_idx = -1
        max_vm_node_idx   = -1

    result = {
        'nx': nx,
        'ny': ny,
        'nodes': nodes.tolist(),
        'elements': elements.tolist(),
        'displacements': displacements,
        'von_mises': elem_vm,
        'node_vm': node_vm.tolist(),
        'stresses': elem_stress,
        'strain_mag': elem_strain_mag,
        'max_displacement': max_disp,
        'max_von_mises': float(max(elem_vm)) if elem_vm else 0.0,
        'max_disp_node_idx': max_disp_node_idx,
        'max_vm_node_idx':   max_vm_node_idx,
        'problem_type': problem_type,
        'load_type': load_type,
    }
    if problem_type == 'plate_hole':
        result['hole'] = {'cx': width / 2, 'cy': height / 2, 'r': min(width, height) * 0.22}
    if problem_type == 'beam_hole':
        result['hole'] = {'cx': width / 2, 'cy': height / 2, 'r': height * 0.28}
    return result


def solve_fem_crack_step(
    nx: int = 16, ny: int = 8, width: float = 2.0, height: float = 0.5,
    E: float = 200e9, nu: float = 0.3, load: float = -10_000.0,
    problem_type: str = 'cantilever', load_type: str = 'point',
    excluded_elements: list | None = None,
) -> dict:
    """Like solve_fem but removes specified element indices from the stiffness matrix.

    The returned elements array is in the same order as a normal solve — excluded
    elements have zero stress so index consistency with the original mesh is preserved.
    """
    nodes, all_elems = create_mesh(nx, ny, width, height)
    n_nodes = len(nodes)
    n_dof   = 2 * n_nodes
    D = _D(E, nu)

    mask     = _active_elements(problem_type, all_elems, nodes, width, height)
    elements = all_elems[mask]
    dead     = set(excluded_elements or [])

    K = lil_matrix((n_dof, n_dof))
    for i, elem in enumerate(elements):
        if i in dead:
            continue
        ke   = _ke(nodes[elem], D)
        dofs = [2 * n + d for n in elem for d in range(2)]
        for r, dr in enumerate(dofs):
            for c, dc in enumerate(dofs):
                K[dr, dc] += ke[r, c]
    K = K.tocsr()

    constrained, F = _setup_bc_load(
        problem_type, nodes, elements, n_dof, width, height, load, load_type
    )
    free = [i for i in range(n_dof) if i not in set(constrained)]

    U = np.zeros(n_dof)
    if free:
        try:
            U[free] = spsolve(K[np.ix_(free, free)], F[free])
        except Exception:
            pass  # singular (structure collapsed) — keep zero displacements

    n_elem          = len(elements)
    elem_vm         = [0.0] * n_elem
    elem_stress     = [[0.0, 0.0, 0.0] for _ in range(n_elem)]
    elem_strain_mag = [0.0] * n_elem

    for i, elem in enumerate(elements):
        if i in dead:
            continue
        u_e = np.array([U[2 * n + d] for n in elem for d in range(2)])
        B, _ = _B_detJ(nodes[elem], 0.0, 0.0)
        eps  = B @ u_e
        ex, ey, gxy = float(eps[0]), float(eps[1]), float(eps[2])
        elem_strain_mag[i] = float(np.sqrt(ex ** 2 + ey ** 2 + gxy ** 2))
        s = D @ eps
        sx, sy, txy = float(s[0]), float(s[1]), float(s[2])
        elem_stress[i] = [sx, sy, txy]
        elem_vm[i]     = float(np.sqrt(sx ** 2 - sx * sy + sy ** 2 + 3 * txy ** 2))

    node_vm_acc = np.zeros(n_nodes)
    node_cnt    = np.zeros(n_nodes)
    for i, elem in enumerate(elements):
        if i in dead:
            continue
        for n in elem:
            node_vm_acc[n] += elem_vm[i]
            node_cnt[n]    += 1
    safe_cnt = np.where(node_cnt > 0, node_cnt, 1.0)
    node_vm  = np.where(node_cnt > 0, node_vm_acc / safe_cnt, 0.0)

    displacements = [[float(U[2 * i]), float(U[2 * i + 1])] for i in range(n_nodes)]

    U_mag = np.hypot(U[0::2], U[1::2])
    max_disp = float(np.max(U_mag))
    max_disp_node_idx = int(np.argmax(U_mag)) if max_disp > 0 else -1
    max_vm_node_idx   = int(np.argmax(node_vm)) if max_disp > 0 else -1

    live_vm = [v for i, v in enumerate(elem_vm) if i not in dead]

    result = {
        'nx': nx, 'ny': ny,
        'nodes': nodes.tolist(),
        'elements': elements.tolist(),
        'displacements': displacements,
        'von_mises': elem_vm,
        'node_vm': node_vm.tolist(),
        'stresses': elem_stress,
        'strain_mag': elem_strain_mag,
        'max_displacement': max_disp,
        'max_von_mises': float(max(live_vm)) if live_vm else 0.0,
        'max_disp_node_idx': max_disp_node_idx,
        'max_vm_node_idx':   max_vm_node_idx,
        'problem_type': problem_type,
        'load_type': load_type,
    }
    if problem_type == 'plate_hole':
        result['hole'] = {'cx': width / 2, 'cy': height / 2, 'r': min(width, height) * 0.22}
    if problem_type == 'beam_hole':
        result['hole'] = {'cx': width / 2, 'cy': height / 2, 'r': height * 0.28}
    return result


# ── Custom polygon shapes: Constant Strain Triangle (CST) elements ──

def _polygon_area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y) / 2.0)


def _point_in_polygon(px: float, py: float, poly: np.ndarray) -> bool:
    n = len(poly)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and \
           (px < (xj - xi) * (py - yi) / (yj - yi + 1e-300) + xi):
            inside = not inside
        j = i
    return inside


def _triangle_area(a, b, c) -> float:
    return abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2.0


def triangulate_polygon(points, target_n: int = 16):
    """Mesh the interior of a closed polygon with a Delaunay triangulation.

    Boundary nodes are placed along subdivided edges, interior nodes on a
    grid filtered to lie inside the polygon, then a Delaunay triangulation
    of the combined point set is filtered to keep only triangles whose
    centroid lies inside the polygon (drops convex-hull artifacts for
    non-convex shapes).
    """
    poly = np.array(points, dtype=float)
    if _polygon_area(poly) < 0:
        poly = poly[::-1]

    minx, miny = poly.min(axis=0)
    maxx, maxy = poly.max(axis=0)
    span_x, span_y = max(maxx - minx, 1e-9), max(maxy - miny, 1e-9)

    n_edges = len(poly)
    edge_subdiv = max(1, round(target_n / n_edges))
    boundary_pts = []
    for i in range(n_edges):
        p1, p2 = poly[i], poly[(i + 1) % n_edges]
        for t in range(edge_subdiv):
            boundary_pts.append(p1 + (t / edge_subdiv) * (p2 - p1))
    boundary_pts = np.array(boundary_pts)

    step = max(span_x, span_y) / max(target_n, 1)
    step = max(step, 1e-6)
    interior_pts = []
    x = minx + step / 2
    while x < maxx:
        y = miny + step / 2
        while y < maxy:
            if _point_in_polygon(x, y, poly):
                interior_pts.append([x, y])
            y += step
        x += step

    all_pts = np.vstack([boundary_pts, np.array(interior_pts)]) if interior_pts else boundary_pts
    all_pts = np.unique(all_pts.round(decimals=9), axis=0)

    if len(all_pts) < 3:
        raise ValueError('Not enough points to triangulate this shape')

    try:
        tri = Delaunay(all_pts)
    except QhullError:
        raise ValueError('Shape is degenerate — try a larger or less collinear outline')

    valid = []
    for simplex in tri.simplices:
        a, b, c = all_pts[simplex]
        centroid = (a + b + c) / 3.0
        if _triangle_area(a, b, c) < 1e-12:
            continue
        if _point_in_polygon(centroid[0], centroid[1], poly):
            valid.append(simplex)

    return all_pts, np.array(valid, dtype=int)


def _ke_tri(nodes_e: np.ndarray, D: np.ndarray, t: float = 1.0):
    (x1, y1), (x2, y2), (x3, y3) = nodes_e
    twoA = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)
    A = abs(twoA) / 2.0
    b1, b2, b3 = y2 - y3, y3 - y1, y1 - y2
    c1, c2, c3 = x3 - x2, x1 - x3, x2 - x1
    B = np.array([
        [b1, 0,  b2, 0,  b3, 0],
        [0,  c1, 0,  c2, 0,  c3],
        [c1, b1, c2, b2, c3, b3],
    ]) / (2 * A)
    ke = B.T @ D @ B * A * t
    return ke, B


def _setup_bc_load_custom(nodes: np.ndarray, elements: np.ndarray, n_dof: int, load: float,
                           custom_loads: list | None = None):
    F = np.zeros(n_dof)
    constrained = set()

    xs = nodes[:, 0]
    minx, maxx = xs.min(), xs.max()
    span = max(maxx - minx, 1e-9)
    tol = max(0.05 * span, 1e-6)

    left_idx = np.where(xs <= minx + tol)[0]
    right_idx = np.where(xs >= maxx - tol)[0]

    for n in left_idx:
        constrained.add(2 * int(n))
        constrained.add(2 * int(n) + 1)

    if len(left_idx) < 2:
        order = np.argsort(xs)
        left_set = set(left_idx.tolist())
        for n in order:
            if n not in left_set:
                constrained.add(2 * int(n) + 1)
                break

    # Custom loads replace the default right-edge tension entirely.
    if custom_loads:
        for cl in custom_loads:
            n = int(cl['node'])
            F[2 * n]     += float(cl.get('fx', 0.0))
            F[2 * n + 1] += float(cl.get('fy', 0.0))
    elif len(right_idx) > 0:
        per = load / len(right_idx)
        for n in right_idx:
            F[2 * int(n) + 1] = per

    active_set = set(elements.flatten().tolist())
    for n in range(len(nodes)):
        if n not in active_set:
            constrained.add(2 * n)
            constrained.add(2 * n + 1)

    return sorted(constrained), F, left_idx.tolist(), right_idx.tolist()


def solve_custom_shape(points, E: float = 200e9, nu: float = 0.3,
                        load: float = -10_000.0, mesh_density: int = 16,
                        custom_loads: list | None = None) -> dict:
    if len(points) < 3:
        raise ValueError('Need at least 3 points to form a shape')

    poly = np.array(points, dtype=float)
    if abs(_polygon_area(poly)) < 1e-9:
        raise ValueError('Polygon has zero area — points may be collinear')

    nodes, elements = triangulate_polygon(points, target_n=mesh_density)
    if len(elements) == 0:
        raise ValueError('Failed to generate a mesh — try a simpler or larger shape')

    n_nodes = len(nodes)
    n_dof = 2 * n_nodes
    D = _D(E, nu)

    K = lil_matrix((n_dof, n_dof))
    elem_B = []
    for elem in elements:
        ke, B = _ke_tri(nodes[elem], D)
        elem_B.append(B)
        dofs = [2 * n + d for n in elem for d in range(2)]
        for i, di in enumerate(dofs):
            for j, dj in enumerate(dofs):
                K[di, dj] += ke[i, j]
    K = K.tocsr()

    constrained, F, fixed_nodes, load_nodes = _setup_bc_load_custom(nodes, elements, n_dof, load,
                                                                      custom_loads)
    free = [i for i in range(n_dof) if i not in set(constrained)]

    U = np.zeros(n_dof)
    if free:
        U[free] = spsolve(K[np.ix_(free, free)], F[free])

    elem_vm, elem_stress, elem_strain_mag = [], [], []
    for i, elem in enumerate(elements):
        u_e = np.array([U[2 * n + d] for n in elem for d in range(2)])
        eps = elem_B[i] @ u_e
        ex, ey, gxy = float(eps[0]), float(eps[1]), float(eps[2])
        elem_strain_mag.append(float(np.sqrt(ex ** 2 + ey ** 2 + gxy ** 2)))
        s = D @ eps
        sx, sy, txy = float(s[0]), float(s[1]), float(s[2])
        elem_stress.append([sx, sy, txy])
        elem_vm.append(float(np.sqrt(sx ** 2 - sx * sy + sy ** 2 + 3 * txy ** 2)))

    node_vm_acc = np.zeros(n_nodes)
    node_cnt = np.zeros(n_nodes)
    for i, elem in enumerate(elements):
        for n in elem:
            node_vm_acc[n] += elem_vm[i]
            node_cnt[n] += 1
    safe_cnt = np.where(node_cnt > 0, node_cnt, 1.0)
    node_vm = np.where(node_cnt > 0, node_vm_acc / safe_cnt, 0.0)

    displacements = [[float(U[2 * i]), float(U[2 * i + 1])] for i in range(n_nodes)]

    U_mag = np.hypot(U[0::2], U[1::2])
    max_disp = float(np.max(U_mag))
    if max_disp > 0:
        max_disp_node_idx = int(np.argmax(U_mag))
        max_vm_node_idx = int(np.argmax(node_vm))
    else:
        max_disp_node_idx = -1
        max_vm_node_idx = -1

    return {
        'nx': 0,
        'ny': 0,
        'nodes': nodes.tolist(),
        'elements': elements.tolist(),
        'displacements': displacements,
        'von_mises': elem_vm,
        'node_vm': node_vm.tolist(),
        'stresses': elem_stress,
        'strain_mag': elem_strain_mag,
        'max_displacement': max_disp,
        'max_von_mises': float(max(elem_vm)) if elem_vm else 0.0,
        'max_disp_node_idx': max_disp_node_idx,
        'max_vm_node_idx': max_vm_node_idx,
        'problem_type': 'custom',
        'load_type': 'custom' if custom_loads else 'point',
        'fixed_nodes': fixed_nodes,
        'load_nodes': load_nodes,
    }
