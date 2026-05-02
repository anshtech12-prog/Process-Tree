/**
 * Process Tree Visualizer - Graph View (Canvas)
 * ================================================
 * Interactive force-directed / radial graph visualization
 * drawn on an HTML5 Canvas element.
 */

/* ============================================================
 * Graph State
 * ============================================================ */
let graphCanvas, graphCtx;
let graphNodes = [];
let graphEdges = [];
let graphAnimFrame = null;
let graphZoom = 1;
let graphOffsetX = 0, graphOffsetY = 0;
let graphDragging = false;
let graphDragStart = { x: 0, y: 0 };
let graphHoveredNode = null;
let graphSelectedNode = null;
let graphInitialized = false;

/* Physics constants */
const REPULSION = 3000;
const ATTRACTION = 0.005;
const DAMPING = 0.85;
const MIN_DIST = 60;
const CENTER_GRAVITY = 0.01;

/* ============================================================
 * Initialize Graph
 * ============================================================ */
function initGraph() {
    graphCanvas = document.getElementById('graph-canvas');
    if (!graphCanvas) return;
    graphCtx = graphCanvas.getContext('2d');
    resizeGraphCanvas();
    window.addEventListener('resize', resizeGraphCanvas);

    /* Mouse events */
    graphCanvas.addEventListener('wheel', onGraphWheel, { passive: false });
    graphCanvas.addEventListener('mousedown', onGraphMouseDown);
    graphCanvas.addEventListener('mousemove', onGraphMouseMove);
    graphCanvas.addEventListener('mouseup', onGraphMouseUp);
    graphCanvas.addEventListener('mouseleave', onGraphMouseUp);
    graphCanvas.addEventListener('click', onGraphClick);
    graphCanvas.addEventListener('dblclick', onGraphDblClick);

    graphInitialized = true;
}

function resizeGraphCanvas() {
    if (!graphCanvas) return;
    const container = graphCanvas.parentElement;
    graphCanvas.width = container.clientWidth;
    graphCanvas.height = container.clientHeight;
}

/* ============================================================
 * Build Graph Data from Process Tree
 * ============================================================ */
function buildGraphData() {
    graphNodes = [];
    graphEdges = [];
    if (!processData || !processData.roots) return;

    const nodeMap = new Map();
    let idx = 0;

    /* Flatten tree into nodes array */
    function walkTree(node, depth) {
        const gNode = {
            id: node.pid,
            label: node.name || 'Unknown',
            pid: node.pid,
            ppid: node.ppid,
            status: (node.status || 'unknown').toLowerCase(),
            memoryKB: node.memoryKB || 0,
            cpuTimeMs: node.cpuTimeMs || 0,
            priority: node.priority || 'Unknown',
            threads: node.threads || 0,
            childCount: node.children ? node.children.length : 0,
            depth: depth,
            /* Physics */
            x: graphCanvas.width / 2 + (Math.random() - 0.5) * 400,
            y: graphCanvas.height / 2 + (Math.random() - 0.5) * 400,
            vx: 0, vy: 0,
            /* Display */
            radius: Math.max(6, Math.min(22, Math.sqrt((node.memoryKB || 1) / 100))),
            index: idx++
        };
        graphNodes.push(gNode);
        nodeMap.set(node.pid, gNode);

        if (node.children) {
            node.children.forEach(child => {
                walkTree(child, depth + 1);
            });
        }
    }

    processData.roots.forEach(root => walkTree(root, 0));

    /* Build edges */
    graphNodes.forEach(gn => {
        const parent = nodeMap.get(gn.ppid);
        if (parent && parent.id !== gn.id) {
            graphEdges.push({ source: parent, target: gn });
        }
    });

    /* If nodes had prior positions, try to preserve them */
    arrangeInitialLayout();
}

/* ============================================================
 * Initial Layout: Radial placement based on depth
 * ============================================================ */
function arrangeInitialLayout() {
    const cx = graphCanvas.width / 2;
    const cy = graphCanvas.height / 2;
    const depthMap = new Map();

    graphNodes.forEach(n => {
        if (!depthMap.has(n.depth)) depthMap.set(n.depth, []);
        depthMap.get(n.depth).push(n);
    });

    depthMap.forEach((nodes, depth) => {
        const ringRadius = depth * 120 + 40;
        nodes.forEach((n, i) => {
            const angle = (2 * Math.PI * i / nodes.length) + (depth * 0.5);
            n.x = cx + Math.cos(angle) * ringRadius;
            n.y = cy + Math.sin(angle) * ringRadius;
        });
    });
}

/* ============================================================
 * Physics Simulation
 * ============================================================ */
function simulatePhysics() {
    const cx = graphCanvas.width / 2;
    const cy = graphCanvas.height / 2;

    /* Repulsion between all node pairs (Barnes-Hut would be better for large N) */
    for (let i = 0; i < graphNodes.length; i++) {
        for (let j = i + 1; j < graphNodes.length; j++) {
            const a = graphNodes[i], b = graphNodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            if (dist < MIN_DIST) dist = MIN_DIST;
            const force = REPULSION / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
        }
    }

    /* Attraction along edges */
    graphEdges.forEach(e => {
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * ATTRACTION;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        e.source.vx += fx; e.source.vy += fy;
        e.target.vx -= fx; e.target.vy -= fy;
    });

    /* Center gravity */
    graphNodes.forEach(n => {
        n.vx += (cx - n.x) * CENTER_GRAVITY;
        n.vy += (cy - n.y) * CENTER_GRAVITY;
    });

    /* Apply velocities with damping */
    let totalMovement = 0;
    graphNodes.forEach(n => {
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.x += n.vx;
        n.y += n.vy;
        totalMovement += Math.abs(n.vx) + Math.abs(n.vy);
    });

    return totalMovement;
}

/* ============================================================
 * Render Graph
 * ============================================================ */
function renderGraph() {
    if (!graphCtx || !graphCanvas) return;
    const ctx = graphCtx;
    const w = graphCanvas.width;
    const h = graphCanvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(graphOffsetX + w / 2, graphOffsetY + h / 2);
    ctx.scale(graphZoom, graphZoom);
    ctx.translate(-w / 2, -h / 2);

    /* Draw edges */
    ctx.lineWidth = 1;
    graphEdges.forEach(e => {
        const isHighlight = graphSelectedNode &&
            (e.source.id === graphSelectedNode.id || e.target.id === graphSelectedNode.id);
        ctx.strokeStyle = isHighlight ? 'rgba(99,102,241,0.7)' : 'rgba(71,85,105,0.2)';
        ctx.lineWidth = isHighlight ? 2 : 0.8;
        ctx.beginPath();

        /* Curved edges */
        const mx = (e.source.x + e.target.x) / 2;
        const my = (e.source.y + e.target.y) / 2;
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const cx2 = mx - dy * 0.1;
        const cy2 = my + dx * 0.1;

        ctx.moveTo(e.source.x, e.source.y);
        ctx.quadraticCurveTo(cx2, cy2, e.target.x, e.target.y);
        ctx.stroke();
    });

    /* Draw nodes */
    graphNodes.forEach(n => {
        const isSelected = graphSelectedNode && graphSelectedNode.id === n.id;
        const isHovered = graphHoveredNode && graphHoveredNode.id === n.id;
        const r = n.radius * (isHovered ? 1.3 : 1);

        /* Node glow */
        if (isSelected || isHovered) {
            const gradient = ctx.createRadialGradient(n.x, n.y, r, n.x, n.y, r * 3);
            gradient.addColorStop(0, getStatusColor(n.status, 0.3));
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r * 3, 0, Math.PI * 2);
            ctx.fill();
        }

        /* Node circle */
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = getStatusColor(n.status, isSelected ? 1 : 0.8);
        ctx.fill();

        if (isSelected) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        /* Label (only if zoom > 0.6 or node is important) */
        if (graphZoom > 0.5 || isSelected || isHovered || n.childCount > 5) {
            ctx.font = `${isSelected ? 'bold ' : ''}${Math.max(9, 11 / graphZoom)}px Inter, sans-serif`;
            ctx.fillStyle = isSelected ? '#e2e8f0' : 'rgba(226,232,240,0.7)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(truncLabel(n.label, 16), n.x, n.y + r + 4);
        }
    });

    /* Hovered node tooltip */
    if (graphHoveredNode) {
        drawGraphTooltip(ctx, graphHoveredNode);
    }

    ctx.restore();
}

function getStatusColor(status, alpha) {
    switch (status) {
        case 'running':  return `rgba(52,211,153,${alpha})`;
        case 'sleeping': return `rgba(251,191,36,${alpha})`;
        case 'zombie':   return `rgba(248,113,113,${alpha})`;
        default:         return `rgba(100,116,139,${alpha})`;
    }
}

function truncLabel(str, max) {
    return str.length > max ? str.substring(0, max - 2) + '…' : str;
}

function drawGraphTooltip(ctx, node) {
    const memStr = node.memoryKB > 1024 ? (node.memoryKB / 1024).toFixed(1) + ' MB' : node.memoryKB + ' KB';
    const cpuStr = node.cpuTimeMs > 1000 ? (node.cpuTimeMs / 1000).toFixed(1) + 's' : node.cpuTimeMs + 'ms';
    const lines = [
        node.label,
        `PID: ${node.pid}  |  PPID: ${node.ppid}`,
        `Status: ${node.status}  |  Priority: ${node.priority}`,
        `Memory: ${memStr}  |  CPU: ${cpuStr}`,
        `Threads: ${node.threads}  |  Children: ${node.childCount}`
    ];

    const padding = 10;
    const lineH = 16;
    ctx.font = '11px Inter, sans-serif';
    const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
    const boxW = maxW + padding * 2;
    const boxH = lines.length * lineH + padding * 2;
    let tx = node.x + node.radius + 12;
    let ty = node.y - boxH / 2;

    /* Background */
    ctx.fillStyle = 'rgba(22,27,39,0.95)';
    roundRect(ctx, tx, ty, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(99,102,241,0.4)';
    ctx.lineWidth = 1;
    roundRect(ctx, tx, ty, boxW, boxH, 8);
    ctx.stroke();

    /* Text */
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
        ctx.font = i === 0 ? 'bold 12px Inter, sans-serif' : '11px Inter, sans-serif';
        ctx.fillStyle = i === 0 ? '#e2e8f0' : '#94a3b8';
        ctx.fillText(line, tx + padding, ty + padding + i * lineH);
    });
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

/* ============================================================
 * Animation Loop
 * ============================================================ */
let simIterations = 0;
const MAX_SIM_ITERATIONS = 300;

function startGraphAnimation() {
    simIterations = 0;
    cancelAnimationFrame(graphAnimFrame);
    animateGraph();
}

function animateGraph() {
    if (simIterations < MAX_SIM_ITERATIONS) {
        const movement = simulatePhysics();
        simIterations++;
        /* Stop early if settled */
        if (movement < 0.5) simIterations = MAX_SIM_ITERATIONS;
    }
    renderGraph();
    graphAnimFrame = requestAnimationFrame(animateGraph);
}

function stopGraphAnimation() {
    cancelAnimationFrame(graphAnimFrame);
    graphAnimFrame = null;
}

/* ============================================================
 * Mouse Interaction Handlers
 * ============================================================ */
function screenToGraph(sx, sy) {
    const w = graphCanvas.width;
    const h = graphCanvas.height;
    const gx = (sx - graphOffsetX - w / 2) / graphZoom + w / 2;
    const gy = (sy - graphOffsetY - h / 2) / graphZoom + h / 2;
    return { x: gx, y: gy };
}

function findNodeAt(gx, gy) {
    for (let i = graphNodes.length - 1; i >= 0; i--) {
        const n = graphNodes[i];
        const dx = gx - n.x;
        const dy = gy - n.y;
        if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
    }
    return null;
}

function onGraphWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    graphZoom = Math.max(0.1, Math.min(5, graphZoom * delta));
}

function onGraphMouseDown(e) {
    graphDragging = true;
    graphDragStart = { x: e.clientX - graphOffsetX, y: e.clientY - graphOffsetY };
    graphCanvas.style.cursor = 'grabbing';
}

function onGraphMouseMove(e) {
    if (graphDragging) {
        graphOffsetX = e.clientX - graphDragStart.x;
        graphOffsetY = e.clientY - graphDragStart.y;
        return;
    }
    const rect = graphCanvas.getBoundingClientRect();
    const { x, y } = screenToGraph(e.clientX - rect.left, e.clientY - rect.top);
    graphHoveredNode = findNodeAt(x, y);
    graphCanvas.style.cursor = graphHoveredNode ? 'pointer' : 'grab';
}

function onGraphMouseUp() {
    graphDragging = false;
    graphCanvas.style.cursor = graphHoveredNode ? 'pointer' : 'grab';
}

function onGraphClick(e) {
    const rect = graphCanvas.getBoundingClientRect();
    const { x, y } = screenToGraph(e.clientX - rect.left, e.clientY - rect.top);
    const node = findNodeAt(x, y);
    if (node) {
        graphSelectedNode = node;
        /* Sync with main app selection */
        selectedPid = node.id;
        renderTree();
        showDetails(node.id);
    } else {
        graphSelectedNode = null;
    }
}

function onGraphDblClick(e) {
    /* Reset view on double click background */
    const rect = graphCanvas.getBoundingClientRect();
    const { x, y } = screenToGraph(e.clientX - rect.left, e.clientY - rect.top);
    const node = findNodeAt(x, y);
    if (!node) {
        graphZoom = 1;
        graphOffsetX = 0;
        graphOffsetY = 0;
    }
}

/* ============================================================
 * Public API — called from main script
 * ============================================================ */
function showGraphView() {
    if (!graphInitialized) initGraph();
    resizeGraphCanvas();
    buildGraphData();
    startGraphAnimation();
}

function hideGraphView() {
    stopGraphAnimation();
}

function refreshGraphView() {
    if (document.getElementById('graph-view')?.classList.contains('hidden')) return;
    buildGraphData();
    startGraphAnimation();
}
