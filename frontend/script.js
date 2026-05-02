/**
 * ============================================================
 * Process Tree Visualizer — Core Frontend Logic
 * ============================================================
 *
 * Purpose
 * -------
 * Drives all UI interactions for the Process Tree Visualizer:
 *  • Fetches process data from the Node.js bridge server
 *  • Renders the collapsible tree view with status indicators
 *  • Handles search, filter, sort, expand/collapse
 *  • Manages the details sidebar, breadcrumb ancestry
 *  • Controls theme switching (dark / light)
 *  • Provides process kill functionality with confirmation
 *  • Renders system metrics (CPU, RAM, uptime) and sparkline
 *
 * Key Globals
 * -----------
 *  processData   — Raw JSON from /api/processes (tree structure)
 *  flatMap       — Map<PID, ProcessNode> for O(1) lookups
 *  expanded      — Set<PID> tracking which tree nodes are open
 *  selectedPid   — Currently selected process PID (or null)
 *
 * Sections
 * --------
 *  1. Application State
 *  2. Initialization & Event Setup
 *  3. Data Fetching (API calls)
 *  4. Statistics & Metrics
 *  5. Search
 *  6. Sorting
 *  7. Tree Rendering
 *  8. Node Interactions (select, toggle, lineage)
 *  9. Breadcrumb Navigation
 * 10. Details Panel
 * 11. Tooltip
 * 12. Filter & Sort Controls
 * 13. Expand / Collapse
 * 14. Refresh & Auto-Refresh
 * 15. Export
 * 16. Modals (Shortcuts)
 * 17. Utilities
 * 18. Theme Toggle
 * 19. View Switching (Tree / Graph)
 * 20. System Info
 * 21. Process Kill
 * 22. History Sparkline
 *
 * Dependencies: graph.js (must be loaded before this file)
 * ============================================================
 */

/* ============================================================
 * 1. Application State
 * ============================================================ */
let processData = null;
let flatMap = new Map();
let selectedPid = null;
let currentFilter = 'all';
let currentSort = 'default';
let searchQuery = '';
let autoRefreshTimer = null;
let isRefreshing = false;
let expanded = new Set();
let detailsOpen = false;

const API = '/api/processes';

/* ============================================================
 * 2. Initialization & Event Setup
 * ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    loadThemePreference();
    fetchProcessData();
    fetchSystemInfo();
    setupSearch();
    setupKeyboard();
});

function setupSearch() {
    const inp = document.getElementById('search-input');
    let t;
    inp.addEventListener('input', e => {
        clearTimeout(t);
        t = setTimeout(() => {
            searchQuery = e.target.value.trim().toLowerCase();
            document.getElementById('search-clear').classList.toggle('hidden', !searchQuery);
            renderTree();
            updateSearchCount();
        }, 180);
    });
}

function setupKeyboard() {
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
            if (e.key === 'Escape') { clearSearch(); e.target.blur(); }
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            document.getElementById('search-input').focus();
            return;
        }
        switch(e.key) {
            case 'r': case 'R': refreshData(); break;
            case 'e': case 'E': expandAll(); break;
            case 'c': case 'C': collapseAll(); break;
            case 'f': toggleFilterPanel(); break;
            case 'd': toggleDetails(); break;
            case '?': showShortcuts(); break;
            case 'Escape': closeDetails(); document.getElementById('shortcuts-modal').classList.add('hidden'); break;
        }
    });
}

/* ============================================================
 * 3. Data Fetching
 * ============================================================ */
async function fetchProcessData() {
    showLoading(true); hideError();
    try {
        const r = await fetch(API);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        processData = await r.json();
        if (processData.error) throw new Error(processData.error);
        buildFlatMap(processData.roots);
        updateStats();
        renderTree();
        showApp();
    } catch (err) {
        console.error(err);
        showError(err.message);
    } finally {
        showLoading(false);
    }
}

function buildFlatMap(roots) {
    flatMap.clear();
    (function walk(n) { flatMap.set(n.pid, n); if (n.children) n.children.forEach(walk); });
    if (roots) roots.forEach(function walk(n) { flatMap.set(n.pid, n); if (n.children) n.children.forEach(walk); });
}

/* ---- UI Helpers ---- */
function showLoading(s) { document.getElementById('loading-overlay').classList.toggle('hidden', !s); }
function showApp() { document.getElementById('app').classList.remove('hidden'); }
function showError(m) { document.getElementById('error-message').textContent = m; document.getElementById('error-modal').classList.remove('hidden'); }
function hideError() { document.getElementById('error-modal').classList.add('hidden'); }
function retryFetch() { hideError(); fetchProcessData(); }

/* ============================================================
 * 4. Statistics & Metrics
 * ============================================================ */
function updateStats() {
    if (!processData) return;
    let run = 0, sleep = 0, zom = 0;
    flatMap.forEach(p => {
        const s = (p.status || '').toLowerCase();
        if (s === 'running') run++;
        else if (s === 'sleeping') sleep++;
        else if (s === 'zombie') zom++;
    });
    const total = processData.totalProcesses || flatMap.size;
    document.getElementById('sv-total').textContent = total;
    document.getElementById('sv-running').textContent = run;
    document.getElementById('sv-sleeping').textContent = sleep;
    document.getElementById('sv-zombie').textContent = zom;
    document.getElementById('sv-time').textContent = new Date().toLocaleTimeString();

    // Stat bars
    const setBar = (id, pct) => { const el = document.getElementById(id); if(el) el.style.width = pct + '%'; };
    setBar('bar-running', total ? (run/total*100) : 0);
    setBar('bar-sleeping', total ? (sleep/total*100) : 0);
    setBar('bar-zombie', total ? (zom/total*100) : 0);
}

/* ============================================================
 * 5. Search
 * ============================================================ */
function updateSearchCount() {
    const el = document.getElementById('search-results-count');
    if (!searchQuery) { el.classList.add('hidden'); return; }
    let count = 0;
    flatMap.forEach((p, pid) => {
        if ((p.name||'').toLowerCase().includes(searchQuery) || String(pid).includes(searchQuery)) count++;
    });
    el.textContent = count + ' found';
    el.classList.remove('hidden');
}

/* ============================================================
 * 6. Sorting
 * ============================================================ */
function sortNodes(nodes) {
    if (currentSort === 'default' || !nodes) return nodes;
    const sorted = [...nodes];
    switch(currentSort) {
        case 'name': sorted.sort((a,b) => (a.name||'').localeCompare(b.name||'')); break;
        case 'pid': sorted.sort((a,b) => a.pid - b.pid); break;
        case 'memory': sorted.sort((a,b) => (b.memoryKB||0) - (a.memoryKB||0)); break;
        case 'children': sorted.sort((a,b) => (b.children?.length||0) - (a.children?.length||0)); break;
    }
    return sorted;
}

/* ============================================================
 * 7. Tree Rendering
 * ============================================================ */
function renderTree() {
    const container = document.getElementById('process-tree');
    if (!processData || !processData.roots) {
        container.innerHTML = '<p style="color:var(--text-3);text-align:center;padding:60px 0;">No process data available.</p>';
        return;
    }
    const matches = new Set();
    if (searchQuery) {
        flatMap.forEach((p, pid) => {
            if ((p.name||'').toLowerCase().includes(searchQuery) || String(pid).includes(searchQuery)) {
                matches.add(pid);
                expandParents(p.ppid);
            }
        });
    }
    const roots = sortNodes(processData.roots);
    const html = roots.filter(r => passes(r, matches)).map(r => renderNode(r, 0, matches)).join('');
    container.innerHTML = html || '<p style="color:var(--text-3);text-align:center;padding:60px 0;">No processes match current filters.</p>';
    updateBreadcrumb();
}

function expandParents(ppid) {
    let cur = flatMap.get(ppid);
    while (cur) {
        expanded.add(cur.pid);
        if (cur.ppid === cur.pid) break;
        cur = flatMap.get(cur.ppid);
    }
}

function passes(node, matches) {
    if (currentFilter !== 'all') {
        const nm = (node.status||'').toLowerCase() === currentFilter.toLowerCase();
        const cm = node.children && node.children.some(c => passes(c, matches));
        if (!nm && !cm) return false;
    }
    if (searchQuery && matches.size > 0) {
        const nm = matches.has(node.pid);
        const cm = node.children && node.children.some(c => passes(c, matches));
        if (!nm && !cm) return false;
    }
    return true;
}

const CHEVRON_SVG = '<svg width="10" height="10" viewBox="0 0 10 10"><polyline points="3,1 7,5 3,9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderNode(node, depth, matches) {
    const hasKids = node.children && node.children.length > 0;
    const isExp = expanded.has(node.pid);
    const isSel = selectedPid === node.pid;
    const isMatch = matches.has(node.pid);
    const isLin = isInLineage(node.pid);
    const sc = (node.status || 'unknown').toLowerCase();
    const kids = hasKids ? sortNodes(node.children.filter(c => passes(c, matches))) : [];
    const memKB = node.memoryKB || 0;
    const memStr = memKB > 1024 ? (memKB/1024).toFixed(1)+'MB' : memKB+'KB';

    const hdrCls = ['node-header', isSel?'selected':'', isMatch?'search-match':'', isLin?'lineage':''].filter(Boolean).join(' ');
    const togCls = hasKids ? `node-toggle${isExp?' expanded':''}` : 'node-toggle leaf';

    return `<div class="tree-node" data-pid="${node.pid}">
        <div class="${hdrCls}" onclick="selectNode(${node.pid},event)" onmouseenter="showTooltip(event,${node.pid})" onmouseleave="hideTooltip()">
            <span class="${togCls}" onclick="toggleNode(${node.pid},event)">${CHEVRON_SVG}</span>
            <span class="node-dot ${sc}"></span>
            <span class="node-name">${esc(node.name||'Unknown')}</span>
            <span class="node-pid">${node.pid}</span>
            <span class="node-badge ${sc}">${node.status||'?'}</span>
            ${memKB>0?`<span class="node-meta">${memStr}</span>`:''}
            ${kids.length>0?`<span class="node-meta">${kids.length}⤵</span>`:''}
        </div>
        ${kids.length>0?`<div class="node-children${isExp?'':' collapsed'}">${kids.map(c=>renderNode(c,depth+1,matches)).join('')}</div>`:''}
    </div>`;
}

/* ============================================================
 * 8. Node Interactions
 * ============================================================ */
function toggleNode(pid, e) { e.stopPropagation(); expanded.has(pid)?expanded.delete(pid):expanded.add(pid); renderTree(); }
function selectNode(pid, e) {
    if (e.target.closest('.node-toggle')) return;
    selectedPid = selectedPid===pid ? null : pid;
    renderTree();
    if (selectedPid) showDetails(selectedPid); else if (detailsOpen) updateDetailsContent();
}

function isInLineage(pid) {
    if (!selectedPid || pid === selectedPid) return false;
    let cur = flatMap.get(selectedPid);
    while (cur) { if (cur.ppid === pid) return true; if (cur.ppid === cur.pid) break; cur = flatMap.get(cur.ppid); }
    return isDesc(selectedPid, pid);
}
function isDesc(parent, child) {
    const p = flatMap.get(parent);
    if (!p?.children) return false;
    for (const c of p.children) { if (c.pid === child || isDesc(c.pid, child)) return true; }
    return false;
}

/* ============================================================
 * 9. Breadcrumb Navigation
 * ============================================================ */
function updateBreadcrumb() {
    const bar = document.getElementById('breadcrumb-bar');
    const trail = document.getElementById('breadcrumb-trail');
    if (!selectedPid) { bar.classList.add('hidden'); return; }
    const ancestry = [];
    let cur = flatMap.get(selectedPid);
    while (cur) {
        ancestry.unshift(cur);
        if (cur.ppid === cur.pid || !flatMap.has(cur.ppid)) break;
        cur = flatMap.get(cur.ppid);
    }
    trail.innerHTML = ancestry.map((p,i) =>
        `${i>0?'<span class="breadcrumb-sep">›</span>':''}` +
        `<span class="breadcrumb-item${p.pid===selectedPid?' active':''}" onclick="jumpTo(${p.pid})">${esc(p.name)} (${p.pid})</span>`
    ).join('');
    bar.classList.remove('hidden');
}

function jumpTo(pid) { selectedPid = pid; expanded.add(pid); renderTree(); showDetails(pid); }

/* ============================================================
 * 10. Details Panel
 * ============================================================ */
function showDetails(pid) {
    const p = flatMap.get(pid);
    if (!p) return;
    detailsOpen = true;
    document.getElementById('details-panel').classList.remove('hidden');
    updateDetailsContent();
}

function updateDetailsContent() {
    const body = document.getElementById('details-body');
    if (!selectedPid || !flatMap.has(selectedPid)) {
        body.innerHTML = '<p class="details-empty">Click a process to view details</p>';
        return;
    }
    const p = flatMap.get(selectedPid);
    const sc = (p.status||'unknown').toLowerCase();
    const memKB = p.memoryKB || 0;
    const memStr = memKB > 1024 ? (memKB/1024).toFixed(1)+' MB' : memKB+' KB';
    const cpuMs = p.cpuTimeMs || 0;
    const cpuStr = cpuMs > 60000 ? (cpuMs/60000).toFixed(1)+' min' : cpuMs > 1000 ? (cpuMs/1000).toFixed(1)+'s' : cpuMs+'ms';
    const priority = p.priority || 'Unknown';
    const priClass = priority.toLowerCase().replace(/\s+/g, '-');
    const maxMem = Math.max(...[...flatMap.values()].map(x=>x.memoryKB||0), 1);
    const memPct = Math.min((memKB/maxMem)*100, 100);
    const kids = p.children || [];

    body.innerHTML = `
        <div class="detail-name">${esc(p.name||'Unknown')}</div>
        <div class="detail-status ${sc}"><span class="dot dot-${sc}"></span>${p.status||'Unknown'}</div>
        <div class="detail-section">
            <div class="detail-section-title">Process Info</div>
            <div class="detail-row"><span class="detail-key">PID</span><span class="detail-val">${p.pid}</span></div>
            <div class="detail-row"><span class="detail-key">Parent PID</span><span class="detail-val">${p.ppid}</span></div>
            <div class="detail-row"><span class="detail-key">Threads</span><span class="detail-val">${p.threads||'-'}</span></div>
            <div class="detail-row"><span class="detail-key">Memory</span><span class="detail-val">${memStr}</span></div>
            <div class="mem-bar-wrap"><div class="mem-bar-fill" style="width:${memPct}%"></div></div>
            <div class="detail-row"><span class="detail-key">CPU Time</span><span class="detail-val">${cpuStr}</span></div>
            <div class="detail-row"><span class="detail-key">Priority</span><span class="detail-val"><span class="priority-badge ${priClass}">${esc(priority)}</span></span></div>
        </div>
        ${kids.length > 0 ? `
        <div class="detail-section">
            <div class="detail-section-title">Children (${kids.length})</div>
            <div class="detail-children-list">
                ${kids.map(c => {
                    const cs = (c.status||'unknown').toLowerCase();
                    return `<div class="detail-child" onclick="jumpTo(${c.pid})"><span class="dot dot-${cs}"></span>${esc(c.name)} <span style="color:var(--text-3)">(${c.pid})</span></div>`;
                }).join('')}
            </div>
        </div>` : ''}
        <div class="detail-section">
            <div class="detail-section-title">Parent</div>
            ${flatMap.has(p.ppid) && p.ppid !== p.pid ?
                `<div class="detail-child" onclick="jumpTo(${p.ppid})"><span class="dot dot-${(flatMap.get(p.ppid).status||'unknown').toLowerCase()}"></span>${esc(flatMap.get(p.ppid).name)} (${p.ppid})</div>` :
                `<div style="font-size:.8rem;color:var(--text-3)">Root process (no parent)</div>`
            }
        </div>
        <button class="kill-btn" onclick="requestKill(${p.pid}, '${esc(p.name)}')"><svg width="14" height="14" viewBox="0 0 14 14"><line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Terminate Process</button>`;
}

function closeDetails() { detailsOpen = false; document.getElementById('details-panel').classList.add('hidden'); }
function toggleDetails() { detailsOpen ? closeDetails() : (selectedPid && showDetails(selectedPid)); }

/* ============================================================
 * 11. Tooltip
 * ============================================================ */
function showTooltip(e, pid) {
    const p = flatMap.get(pid); if (!p) return;
    const tip = document.getElementById('tooltip');
    const sc = (p.status||'unknown').toLowerCase();
    const memKB = p.memoryKB||0;
    document.getElementById('tooltip-name').textContent = p.name||'Unknown';
    const st = document.getElementById('tooltip-status');
    st.textContent = p.status||'?'; st.className = `tooltip-status node-badge ${sc}`;
    document.getElementById('tooltip-pid').textContent = p.pid;
    document.getElementById('tooltip-ppid').textContent = p.ppid;
    document.getElementById('tooltip-threads').textContent = p.threads||'-';
    document.getElementById('tooltip-memory').textContent = memKB>1024?(memKB/1024).toFixed(1)+' MB':memKB+' KB';
    document.getElementById('tooltip-children').textContent = p.children?p.children.length:0;
    tip.classList.remove('hidden');
    positionTip(e);
}
function positionTip(e) {
    const t = document.getElementById('tooltip');
    const r = t.getBoundingClientRect();
    let x = e.clientX+14, y = e.clientY+14;
    if (x+r.width>window.innerWidth-10) x=e.clientX-r.width-14;
    if (y+r.height>window.innerHeight-10) y=e.clientY-r.height-14;
    t.style.left=x+'px'; t.style.top=y+'px';
}
function hideTooltip() { document.getElementById('tooltip').classList.add('hidden'); }

/* ---- Search Clear ---- */
function clearSearch() {
    const inp = document.getElementById('search-input');
    inp.value=''; searchQuery='';
    document.getElementById('search-clear').classList.add('hidden');
    document.getElementById('search-results-count').classList.add('hidden');
    renderTree();
}

/* ============================================================
 * 12. Filter & Sort Controls
 * ============================================================ */
function toggleFilterPanel() { document.getElementById('filter-panel').classList.toggle('hidden'); }
function setFilter(f, btn) {
    currentFilter=f;
    document.querySelectorAll('.filter-chips .chip').forEach(c=>c.classList.remove('chip-active'));
    btn.classList.add('chip-active');
    renderTree();
}
function toggleSortMenu() { document.getElementById('sort-menu').classList.toggle('hidden'); }
function setSort(s, btn) {
    currentSort=s;
    document.querySelectorAll('.dropdown-item').forEach(i=>i.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('sort-menu').classList.add('hidden');
    renderTree();
}

/* ============================================================
 * 13. Expand / Collapse
 * ============================================================ */
function expandAll() { flatMap.forEach((_,pid)=>expanded.add(pid)); renderTree(); }
function collapseAll() { expanded.clear(); renderTree(); }

/* ============================================================
 * 14. Refresh & Auto-Refresh
 * ============================================================ */
async function refreshData() {
    if (isRefreshing) return;
    isRefreshing = true;
    const icon = document.getElementById('refresh-icon');
    icon.classList.add('spinning');
    try {
        const r = await fetch(API);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        processData = await r.json();
        if (processData.error) throw new Error(processData.error);
        buildFlatMap(processData.roots);
        updateStats(); renderTree();
        if (detailsOpen && selectedPid) updateDetailsContent();
        refreshGraphView();
        fetchHistory();
        fetchSystemInfo();
    } catch(e) { console.error('Refresh error:',e); }
    finally { isRefreshing=false; icon.classList.remove('spinning'); }
}

/* ---- Auto-Refresh ---- */
function toggleAutoRefresh() {
    const cb=document.getElementById('auto-refresh-checkbox'), lbl=document.getElementById('auto-refresh-label');
    if(cb.checked){
        const iv=parseInt(document.getElementById('refresh-interval').value,10);
        autoRefreshTimer=setInterval(refreshData,iv);
        lbl.textContent='On'; lbl.style.color='var(--green)';
    } else {
        clearInterval(autoRefreshTimer); autoRefreshTimer=null;
        lbl.textContent='Off'; lbl.style.color='';
    }
}
function updateRefreshInterval() {
    if(document.getElementById('auto-refresh-checkbox').checked){
        clearInterval(autoRefreshTimer);
        autoRefreshTimer=setInterval(refreshData,parseInt(document.getElementById('refresh-interval').value,10));
    }
}

/* ============================================================
 * 15. Export
 * ============================================================ */
function exportJSON() {
    if(!processData) return;
    const b=new Blob([JSON.stringify(processData,null,2)],{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(b); a.download=`process_tree_${Date.now()}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

/* ============================================================
 * 16. Modals (Shortcuts)
 * ============================================================ */
function showShortcuts() { document.getElementById('shortcuts-modal').classList.remove('hidden'); }
function closeShortcuts(e) { if(e.target===e.currentTarget) e.target.classList.add('hidden'); }

/* Close sort menu on outside click */
document.addEventListener('click', e => {
    const sm=document.getElementById('sort-menu');
    if(!sm.classList.contains('hidden') && !e.target.closest('[onclick*="toggleSortMenu"]')) sm.classList.add('hidden');
});

/* ============================================================
 * 17. Utilities
 * ============================================================ */
function esc(s) { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

/* ============================================================
 * 18. Theme Toggle
 * ============================================================ */
function toggleTheme() {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('ptv-theme', isLight ? 'light' : 'dark');
    updateThemeIcons(isLight);
}

function loadThemePreference() {
    const saved = localStorage.getItem('ptv-theme');
    if (saved === 'light') {
        document.documentElement.classList.add('light');
        updateThemeIcons(true);
    }
}

function updateThemeIcons(isLight) {
    const dark = document.getElementById('theme-icon-dark');
    const light = document.getElementById('theme-icon-light');
    if (isLight) {
        dark.classList.remove('theme-icon-visible');
        dark.classList.add('theme-icon-hidden');
        light.classList.remove('theme-icon-hidden');
        light.classList.add('theme-icon-visible');
    } else {
        dark.classList.remove('theme-icon-hidden');
        dark.classList.add('theme-icon-visible');
        light.classList.remove('theme-icon-visible');
        light.classList.add('theme-icon-hidden');
    }
}

/* ============================================================
 * 19. View Switching (Tree / Graph)
 * ============================================================ */
let currentView = 'tree';

function switchView(view) {
    currentView = view;
    const treeContainer = document.getElementById('tree-container');
    const graphView = document.getElementById('graph-view');
    const tabTree = document.getElementById('tab-tree');
    const tabGraph = document.getElementById('tab-graph');

    if (view === 'tree') {
        treeContainer.classList.remove('hidden');
        graphView.classList.add('hidden');
        tabTree.classList.add('active');
        tabGraph.classList.remove('active');
        hideGraphView();
    } else {
        treeContainer.classList.add('hidden');
        graphView.classList.remove('hidden');
        tabTree.classList.remove('active');
        tabGraph.classList.add('active');
        showGraphView();
    }
}

/* ============================================================
 * 20. System Info
 * ============================================================ */
async function fetchSystemInfo() {
    try {
        const r = await fetch('/api/system');
        if (!r.ok) return;
        const data = await r.json();
        
        document.getElementById('sys-cpu-cores').textContent = data.cpuCores + ' Cores';
        document.getElementById('sys-cpu-model').textContent = truncText(data.cpuModel, 30);
        
        const usedGB = (data.usedMemoryMB / 1024).toFixed(1);
        const totalGB = (data.totalMemoryMB / 1024).toFixed(1);
        document.getElementById('sys-ram-used').textContent = usedGB + ' GB';
        document.getElementById('sys-ram-detail').textContent = `${usedGB} / ${totalGB} GB (${data.memoryUsagePct}%)`;
        
        document.getElementById('sys-uptime').textContent = formatUptime(data.uptimeSeconds);
        document.getElementById('sys-hostname').textContent = data.hostname;
        document.getElementById('sys-os-info').textContent = `${data.osType} ${data.osRelease}`;
        
        /* Animate CPU ring */
        const cpuCirc = 94.2;
        const cpuOffset = cpuCirc - (cpuCirc * data.cpuUsagePct / 100);
        document.getElementById('sys-cpu-ring').style.strokeDashoffset = cpuOffset;
        
        /* Animate RAM ring */
        const ramOffset = cpuCirc - (cpuCirc * data.memoryUsagePct / 100);
        document.getElementById('sys-ram-ring').style.strokeDashoffset = ramOffset;
    } catch (e) {
        console.error('System info error:', e);
    }
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function truncText(str, max) {
    return str && str.length > max ? str.substring(0, max - 1) + '…' : (str || '');
}

/* ============================================================
 * 21. Process Kill
 * ============================================================ */
let killTargetPid = null;
let killTargetName = '';

function requestKill(pid, name) {
    killTargetPid = pid;
    killTargetName = name;
    document.getElementById('kill-target-name').textContent = name;
    document.getElementById('kill-target-pid').textContent = pid;
    document.getElementById('kill-confirm-modal').classList.remove('hidden');
}

function cancelKill() {
    killTargetPid = null;
    document.getElementById('kill-confirm-modal').classList.add('hidden');
}

async function confirmKill() {
    if (!killTargetPid) return;
    const pid = killTargetPid;
    cancelKill();
    
    try {
        const r = await fetch(`/api/kill/${pid}`, { method: 'POST' });
        const data = await r.json();
        if (data.error) {
            alert('Failed to terminate: ' + data.error);
        } else {
            /* Success — refresh tree */
            selectedPid = null;
            closeDetails();
            await refreshData();
        }
    } catch (e) {
        alert('Error terminating process: ' + e.message);
    }
}

/* ============================================================
 * 22. History Sparkline
 * ============================================================ */
async function fetchHistory() {
    try {
        const r = await fetch('/api/history');
        if (!r.ok) return;
        const data = await r.json();
        renderSparkline(data.history);
    } catch (e) {
        console.error('History error:', e);
    }
}

function renderSparkline(history) {
    const svg = document.getElementById('history-sparkline');
    if (!svg || !history || history.length < 2) {
        if (svg) svg.innerHTML = '<text x="50" y="18" text-anchor="middle" fill="#475569" font-size="8">Collecting data...</text>';
        return;
    }
    
    const w = 100, h = 28;
    const values = history.map(h => h.total);
    const min = Math.min(...values) * 0.95;
    const max = Math.max(...values) * 1.05;
    const range = max - min || 1;
    
    const points = values.map((v, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = h - 4 - ((v - min) / range) * (h - 8);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    
    /* Area fill */
    const areaPoints = points.join(' ') + ` ${w},${h-2} 0,${h-2}`;
    
    svg.innerHTML = `
        <defs>
            <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(99,102,241,0.3)"/>
                <stop offset="100%" stop-color="rgba(99,102,241,0)"/>
            </linearGradient>
        </defs>
        <polygon points="${areaPoints}" fill="url(#sparkGrad)"/>
        <polyline points="${points.join(' ')}" fill="none" stroke="#6366f1" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${points[points.length-1].split(',')[0]}" cy="${points[points.length-1].split(',')[1]}" r="2.5" fill="#6366f1"/>
    `;
}
