> **Documento histórico de planificación.** Puede describir funciones propuestas o detalles ya modificados. Para el estado implementado y la operación actual, consultar el [README](../../README.md) y la [documentación de arquitectura](../arquitectura.md).

# pCloud Video Streamer Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a lightweight self-hosted web application to browse and stream videos from a pCloud-mounted directory on a Linux server.

**Architecture:** Node.js/Express backend serving directory listings and video streams with HTTP Range Request support. Vanilla JS + Tailwind CSS frontend for file browser and HTML5 video player.

**Tech Stack:** Node.js, Express, Tailwind CSS (CDN), Docker

---

### Task 1: Create Project Structure and package.json

**Objective:** Initialize the Node.js project with dependencies and folder structure.

**Files:**
- Create: `package.json`
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `server.js`
- Create: `Dockerfile`

**Step 1: Create package.json**
```json
{
  "name": "pcloud-video-streamer",
  "version": "1.0.0",
  "description": "Lightweight web video streamer for pCloud mounted directories",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "mime-types": "^2.1.35"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Step 2: Run npm install**
```bash
cd /home/jorge/orca/workspaces/Video-Home/Versión-inicial
npm install
```
Expected: Dependencies installed in node_modules/

**Step 3: Commit**
```bash
git add package.json package-lock.json
git commit -m "chore: init project with express, cors, mime-types"
```

---

### Task 2: Implement Backend server.js with Express + Range Requests

**Objective:** Build the Express server that serves directory listings and video streams with Range Request support.

**Files:**
- Create: `server.js`

**Step 1: Write failing test**
```bash
# Test that server starts and serves /api/list endpoint
curl -s http://localhost:3000/api/list | jq .
```
Expected: FAIL — server not running

**Step 2: Implement server.js**
```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 3000;
const VIDEO_ROOT = process.env.VIDEO_ROOT || '/mnt/pcloud/My Videos';

app.use(cors());
app.use(express.static('public'));

// Helper: safely resolve path within VIDEO_ROOT
function safeResolve(requestedPath) {
  const resolved = path.resolve(VIDEO_ROOT, requestedPath);
  const rootResolved = path.resolve(VIDEO_ROOT);
  if (!resolved.startsWith(rootResolved)) {
    return null;
  }
  return resolved;
}

// GET /api/list?path=relative/path - List directory contents
app.get('/api/list', async (req, res) => {
  const relativePath = req.query.path || '';
  const fullPath = safeResolve(relativePath);
  
  if (!fullPath) {
    return res.status(403).json({ error: 'Forbidden: path traversal attempt' });
  }
  
  try {
    const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    const items = entries
      .filter(entry => entry.isDirectory() || isVideoFile(entry.name))
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'video',
        path: path.join(relativePath, entry.name).replace(/\\/g, '/')
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: relativePath, items });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Directory not found' });
    }
    console.error('List error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stream?path=relative/path - Stream video with Range Requests
app.get('/api/stream', async (req, res) => {
  const relativePath = req.query.path;
  if (!relativePath) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }
  
  const fullPath = safeResolve(relativePath);
  if (!fullPath) {
    return res.status(403).json({ error: 'Forbidden: path traversal attempt' });
  }
  
  try {
    const stat = await fs.promises.stat(fullPath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'Not a file' });
    }
    
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (!range) {
      // No range header - serve whole file (or first chunk for large files)
      const contentType = mime.lookup(fullPath) || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', fileSize);
      res.setHeader('Accept-Ranges', 'bytes');
      
      const stream = fs.createReadStream(fullPath);
      stream.pipe(res);
      return;
    }
    
    // Parse Range header: bytes=start-end
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    
    // Validate range
    if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).json({ error: 'Range not satisfiable' });
    }
    
    const chunkSize = end - start + 1;
    const contentType = mime.lookup(fullPath) || 'application/octet-stream';
    
    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Accept-Ranges', 'bytes');
    
    const stream = fs.createReadStream(fullPath, { start, end });
    stream.pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function isVideoFile(filename) {
  const videoExtensions = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg'];
  const ext = path.extname(filename).toLowerCase();
  return videoExtensions.includes(ext);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Video root: ${VIDEO_ROOT}`);
});
```

**Step 3: Run server and test**
```bash
# Terminal 1: Start server
VIDEO_ROOT=/mnt/pcloud/My\ Videos node server.js

# Terminal 2: Test endpoints
curl -s http://localhost:3000/api/list | jq .
curl -I http://localhost:3000/api/stream?path=test.mp4
```
Expected: JSON directory listing, 206 Partial Content for video with Range headers

**Step 4: Commit**
```bash
git add server.js
git commit -m "feat: implement Express server with Range Request streaming"
```

---

### Task 3: Create Frontend index.html with Tailwind + Video Player

**Objective:** Build the HTML structure with Tailwind CSS for responsive file browser and video player.

**Files:**
- Create: `public/index.html`

**Step 1: Create index.html**
```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>pCloud Video Streamer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .video-container { aspect-ratio: 16/9; }
    .folder-tree { max-height: 60vh; overflow-y: auto; }
  </style>
</head>
<body class="bg-gray-900 text-gray-100 min-h-screen">
  <div class="flex h-screen overflow-hidden">
    <!-- Sidebar: Folder Browser -->
    <aside id="sidebar" class="w-72 bg-gray-800 border-r border-gray-700 flex flex-col hidden lg:flex">
      <div class="p-4 border-b border-gray-700">
        <h1 class="text-xl font-semibold flex items-center gap-2">
          <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h18M3 16h18M3 12h18"/>
          </svg>
          Mis Vídeos
        </h1>
        <p class="text-xs text-gray-500 mt-1" id="currentPathDisplay">/</p>
      </div>
      
      <nav class="flex-1 p-3 folder-tree" id="folderTree" role="tree" aria-label="Estructura de carpetas">
        <div class="text-center text-gray-500 py-8" id="loadingTree">Cargando carpetas...</div>
      </nav>
      
      <div class="p-3 border-t border-gray-700">
        <button id="refreshBtn" class="w-full text-sm text-gray-400 hover:text-white transition-colors">
          Actualizar árbol
        </button>
      </div>
    </aside>

    <!-- Mobile sidebar toggle -->
    <button id="mobileMenuBtn" class="lg:hidden fixed top-4 left-4 z-50 p-2 bg-gray-800 rounded-lg border border-gray-700 shadow-lg">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
      </svg>
    </button>

    <!-- Main Content: Video Player -->
    <main class="flex-1 flex flex-col overflow-hidden">
      <header class="p-4 border-b border-gray-700 bg-gray-800">
        <div class="flex items-center justify-between">
          <h2 id="videoTitle" class="text-lg font-medium truncate max-w-md">Selecciona un vídeo para reproducir</h2>
          <div class="flex items-center gap-2">
            <span id="videoInfo" class="text-sm text-gray-500 hidden"></span>
          </div>
        </div>
      </header>

      <div class="flex-1 flex items-center justify-center relative video-container bg-black" id="playerContainer">
        <!-- Video Player -->
        <video 
          id="videoPlayer" 
          class="max-w-full max-h-full" 
          controls 
          playsinline
          crossorigin="anonymous"
        ></video>
        
        <!-- Empty state -->
        <div id="emptyState" class="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
          <svg class="w-24 h-24 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <p class="text-lg">Navega por las carpetas y selecciona un vídeo</p>
        </div>
        
        <!-- Loading state -->
        <div id="loadingState" class="absolute inset-0 flex flex-col items-center justify-center text-blue-400 hidden">
          <svg class="animate-spin h-12 w-12" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <p class="mt-3">Buffering...</p>
        </div>
      </div>

      <!-- Breadcrumbs for current folder -->
      <nav id="breadcrumbs" class="px-4 py-2 bg-gray-800 border-t border-gray-700 text-sm hidden" aria-label="Ruta actual">
        <ol class="flex items-center gap-1 text-gray-400" id="breadcrumbList"></ol>
      </nav>
    </main>

    <!-- Mobile sidebar overlay -->
    <div id="sidebarOverlay" class="fixed inset-0 bg-black/50 z-40 lg:hidden hidden"></div>
    <aside id="mobileSidebar" class="fixed inset-y-0 left-0 w-72 bg-gray-800 border-r border-gray-700 z-50 lg:hidden transform -translate-x-full transition-transform duration-300">
      <div class="p-4 border-b border-gray-700 flex items-center justify-between">
        <h2 class="text-lg font-semibold">Mis Vídeos</h2>
        <button id="closeSidebar" class="text-gray-400 hover:text-white">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <nav class="flex-1 p-3 folder-tree overflow-y-auto" id="mobileFolderTree" role="tree" aria-label="Estructura de carpetas"></nav>
    </aside>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

**Step 2: Verify file exists and is valid**
```bash
ls -la public/index.html
head -50 public/index.html
```
Expected: File exists with proper HTML structure

**Step 3: Commit**
```bash
git add public/index.html
git commit -m "feat: add Tailwind HTML structure for file browser and video player"
```

---

### Task 4: Create Frontend app.js for Directory Navigation

**Objective:** Implement vanilla JavaScript for folder tree navigation, breadcrumbs, and video player control.

**Files:**
- Create: `public/app.js`

**Step 1: Create app.js**
```javascript
// State
let currentPath = '';
let pathHistory = [''];
let historyIndex = 0;

// DOM Elements
const folderTree = document.getElementById('folderTree');
const mobileFolderTree = document.getElementById('mobileFolderTree');
const videoPlayer = document.getElementById('videoPlayer');
const videoTitle = document.getElementById('videoTitle');
const videoInfo = document.getElementById('videoInfo');
const emptyState = document.getElementById('emptyState');
const loadingState = document.getElementById('loadingState');
const currentPathDisplay = document.getElementById('currentPathDisplay');
const breadcrumbList = document.getElementById('breadcrumbList');
const breadcrumbs = document.getElementById('breadcrumbs');
const refreshBtn = document.getElementById('refreshBtn');
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const mobileSidebar = document.getElementById('mobileSidebar');
const closeSidebar = document.getElementById('closeSidebar');
const playerContainer = document.getElementById('playerContainer');
const sidebar = document.getElementById('sidebar');

// API Base URL
const API_BASE = '';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadTree('');
  setupEventListeners();
  setupVideoEvents();
});

function setupEventListeners() {
  // Refresh button
  refreshBtn.addEventListener('click', () => loadTree(currentPath));
  
  // Mobile sidebar
  mobileMenuBtn.addEventListener('click', openMobileSidebar);
  closeSidebar.addEventListener('click', closeMobileSidebar);
  sidebarOverlay.addEventListener('click', closeMobileSidebar);
  
  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileSidebar();
  });
}

function setupVideoEvents() {
  videoPlayer.addEventListener('loadstart', () => {
    loadingState.classList.remove('hidden');
    emptyState.classList.add('hidden');
  });
  
  videoPlayer.addEventListener('canplay', () => {
    loadingState.classList.add('hidden');
  });
  
  videoPlayer.addEventListener('error', (e) => {
    loadingState.classList.add('hidden');
    emptyState.classList.remove('hidden');
    videoTitle.textContent = 'Error al cargar el vídeo';
    videoInfo.textContent = '';
    videoInfo.classList.add('hidden');
    console.error('Video error:', e);
  });
  
  videoPlayer.addEventListener('waiting', () => {
    loadingState.classList.remove('hidden');
  });
  
  videoPlayer.addEventListener('playing', () => {
    loadingState.classList.add('hidden');
  });
}

// Load directory tree
async function loadTree(path) {
  currentPath = path;
  currentPathDisplay.textContent = path === '' ? '/' : `/${path}`;
  
  folderTree.innerHTML = '<div class="text-center text-gray-500 py-8">Cargando...</div>';
  mobileFolderTree.innerHTML = '<div class="text-center text-gray-500 py-8">Cargando...</div>';
  
  try {
    const response = await fetch(`${API_BASE}/api/list?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    renderTree(data.items, folderTree);
    renderTree(data.items, mobileFolderTree);
    renderBreadcrumbs(path);
    breadcrumbs.classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load tree:', err);
    folderTree.innerHTML = `<div class="text-center text-red-400 py-8">Error: ${err.message}</div>`;
    mobileFolderTree.innerHTML = `<div class="text-center text-red-400 py-8">Error: ${err.message}</div>`;
  }
}

function renderTree(items, container) {
  if (items.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-500 py-8">Carpeta vacía</div>';
    return;
  }
  
  const ul = document.createElement('ul');
  ul.className = 'space-y-1';
  ul.setAttribute('role', 'group');
  
  items.forEach(item => {
    const li = document.createElement('li');
    
    if (item.type === 'folder') {
      li.innerHTML = `
        <button 
          class="folder-btn w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-gray-700 transition-colors text-sm"
          data-path="${item.path}"
          aria-expanded="false"
        >
          <svg class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
          <span class="truncate font-medium">${item.name}</span>
          <svg class="w-4 h-4 text-gray-500 ml-auto folder-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
      `;
      const btn = li.querySelector('.folder-btn');
      btn.addEventListener('click', () => {
        const isExpanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', !isExpanded);
        const chevron = btn.querySelector('.folder-chevron');
        chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
        
        // Load subfolder contents inline (lazy loading)
        if (!isExpanded) {
          loadSubfolder(item.path, li);
        } else {
          // Remove subfolder content
          const subUl = li.querySelector('ul.subfolder');
          if (subUl) subUl.remove();
        }
      });
    } else {
      li.innerHTML = `
        <button 
          class="video-btn w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-gray-700 transition-colors text-sm"
          data-path="${item.path}"
        >
          <svg class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <span class="truncate">${item.name}</span>
        </button>
      `;
      const btn = li.querySelector('.video-btn');
      btn.addEventListener('click', () => playVideo(item.path, item.name));
    }
    
    ul.appendChild(li);
  });
  
  container.innerHTML = '';
  container.appendChild(ul);
}

async function loadSubfolder(folderPath, parentLi) {
  try {
    const response = await fetch(`${API_BASE}/api/list?path=${encodeURIComponent(folderPath)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    
    if (data.items.length > 0) {
      const subUl = document.createElement('ul');
      subUl.className = 'subfolder ml-4 mt-1 space-y-1 border-l border-gray-700 pl-3';
      subUl.setAttribute('role', 'group');
      
      data.items.forEach(item => {
        const li = document.createElement('li');
        
        if (item.type === 'folder') {
          li.innerHTML = `
            <button 
              class="folder-btn w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-gray-700 transition-colors text-sm"
              data-path="${item.path}"
              aria-expanded="false"
            >
              <svg class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
              </svg>
              <span class="truncate font-medium">${item.name}</span>
              <svg class="w-4 h-4 text-gray-500 ml-auto folder-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          `;
          const btn = li.querySelector('.folder-btn');
          btn.addEventListener('click', () => {
            const isExpanded = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', !isExpanded);
            const chevron = btn.querySelector('.folder-chevron');
            chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
            
            if (!isExpanded) {
              loadSubfolder(item.path, li);
            } else {
              const sub = li.querySelector('ul.subfolder');
              if (sub) sub.remove();
            }
          });
        } else {
          li.innerHTML = `
            <button 
              class="video-btn w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-gray-700 transition-colors text-sm"
              data-path="${item.path}"
            >
              <svg class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="truncate">${item.name}</span>
            </button>
          `;
          const btn = li.querySelector('.video-btn');
          btn.addEventListener('click', () => playVideo(item.path, item.name));
        }
        
        subUl.appendChild(li);
      });
      
      parentLi.appendChild(subUl);
    }
  } catch (err) {
    console.error('Failed to load subfolder:', err);
  }
}

function renderBreadcrumbs(path) {
  breadcrumbList.innerHTML = '';
  
  // Root
  const rootLi = document.createElement('li');
  rootLi.innerHTML = `
    <button class="breadcrumb-btn hover:text-white transition-colors" data-path="">/</button>
  `;
  rootLi.querySelector('.breadcrumb-btn').addEventListener('click', () => loadTree(''));
  breadcrumbList.appendChild(rootLi);
  
  if (path === '') return;
  
  const parts = path.split('/');
  let accumulated = '';
  
  parts.forEach((part, index) => {
    accumulated += (accumulated ? '/' : '') + part;
    
    const separator = document.createElement('li');
    separator.innerHTML = '<span class="text-gray-500 mx-1">/</span>';
    breadcrumbList.appendChild(separator);
    
    const li = document.createElement('li');
    li.innerHTML = `
      <button class="breadcrumb-btn hover:text-white transition-colors" data-path="${accumulated}">${part}</button>
    `;
    li.querySelector('.breadcrumb-btn').addEventListener('click', () => loadTree(accumulated));
    breadcrumbList.appendChild(li);
  });
}

function playVideo(relativePath, name) {
  // Update UI
  videoTitle.textContent = name;
  videoInfo.textContent = relativePath;
  videoInfo.classList.remove('hidden');
  emptyState.classList.add('hidden');
  loadingState.classList.remove('hidden');
  
  // Set video source
  const streamUrl = `${API_BASE}/api/stream?path=${encodeURIComponent(relativePath)}`;
  videoPlayer.src = streamUrl;
  videoPlayer.load();
  videoPlayer.play().catch(err => {
    console.error('Play failed:', err);
    loadingState.classList.add('hidden');
  });
  
  // Highlight active video
  document.querySelectorAll('.video-btn').forEach(btn => {
    btn.classList.remove('bg-blue-900/50', 'border-l-2', 'border-blue-400');
    if (btn.dataset.path === relativePath) {
      btn.classList.add('bg-blue-900/50', 'border-l-2', 'border-blue-400');
    }
  });
  
  // Close mobile sidebar on selection
  closeMobileSidebar();
}

function openMobileSidebar() {
  mobileSidebar.classList.remove('-translate-x-full');
  sidebarOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeMobileSidebar() {
  mobileSidebar.classList.add('-translate-x-full');
  sidebarOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}
```

**Step 2: Verify file exists**
```bash
ls -la public/app.js
head -80 public/app.js
```
Expected: File exists with complete implementation

**Step 3: Commit**
```bash
git add public/app.js
git commit -m "feat: add vanilla JS for folder navigation and video playback"
```

---

### Task 5: Create Dockerfile for Containerization

**Objective:** Create a multi-stage Dockerfile for production deployment.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1: Create Dockerfile**
```dockerfile
# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:20-alpine
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=nodejs:nodejs server.js ./
COPY --chown=nodejs:nodejs public ./public
COPY --chown=nodejs:nodejs package*.json ./

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV VIDEO_ROOT=/mnt/pcloud/My Videos

CMD ["node", "server.js"]
```

**Step 2: Create .dockerignore**
```
node_modules
npm-debug.log
.git
.gitignore
README.md
docs
*.md
Dockerfile
.dockerignore
.env
.env.local
```

**Step 3: Build and test Docker image**
```bash
cd /home/jorge/orca/workspaces/Video-Home/Versión-inicial
docker build -t pcloud-video-streamer .
docker run -d -p 3000:3000 -v /mnt/pcloud/My\ Videos:/mnt/pcloud/My\ Videos --name pcloud-streamer pcloud-video-streamer
curl http://localhost:3000/api/list
```
Expected: Container runs, API responds with directory listing

**Step 4: Commit**
```bash
git add Dockerfile .dockerignore
git commit -m "feat: add Dockerfile for containerized deployment"
```

---

### Task 6: Test Complete Application

**Objective:** Verify the full stack works end-to-end.

**Files:**
- Test: All files

**Step 1: Start server with test video directory**
```bash
# Create test directory structure
mkdir -p /tmp/test-videos/subfolder
# Add a test video file (or use existing)
# cp some-video.mp4 /tmp/test-videos/test.mp4

VIDEO_ROOT=/tmp/test-videos node server.js
```

**Step 2: Test API endpoints**
```bash
# Test directory listing
curl -s http://localhost:3000/api/list | jq .

# Test video streaming with Range Request
curl -I -H "Range: bytes=0-1023" http://localhost:3000/api/stream?path=test.mp4
```
Expected: 206 Partial Content, Content-Range header present

**Step 3: Test frontend in browser**
Open http://localhost:3000 in browser
- Folder tree loads
- Can navigate folders
- Video plays with seeking/buffering

**Step 4: Commit any fixes**
```bash
git add -A
git commit -m "fix: any adjustments from integration testing"
```

---

## Verification Checklist

- [ ] `npm install` completes without errors
- [ ] `node server.js` starts on port 3000
- [ ] `GET /api/list` returns JSON with folders and videos
- [ ] `GET /api/stream?path=...` returns 206 with Range headers
- [ ] Video plays in browser with seeking working
- [ ] Folder tree navigation works (click to expand)
- [ ] Breadcrumbs show current path
- [ ] Mobile sidebar opens/closes
- [ ] Docker image builds and runs
- [ ] Volume mount works for pCloud directory