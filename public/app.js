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
const searchInput = document.getElementById('searchInput');
const mobileSearchInput = document.getElementById('mobileSearchInput');
const searchFrom = document.getElementById('searchFrom');
const searchTo = document.getElementById('searchTo');
const mobileSearchFrom = document.getElementById('mobileSearchFrom');
const mobileSearchTo = document.getElementById('mobileSearchTo');
const metadataPanel = document.getElementById('metadataPanel');
const metadataStatus = document.getElementById('metadataStatus');
const metadataDuration = document.getElementById('metadataDuration');
const metadataResolution = document.getElementById('metadataResolution');
const metadataCodec = document.getElementById('metadataCodec');
const metadataDate = document.getElementById('metadataDate');
const metadataDateEvidence = document.getElementById('metadataDateEvidence');
const visualMetadata = document.getElementById('visualMetadata');
const visualTitle = document.getElementById('visualTitle');
const visualSummary = document.getElementById('visualSummary');
const visualUncertainty = document.getElementById('visualUncertainty');
const visualPeople = document.getElementById('visualPeople');
const visualEvents = document.getElementById('visualEvents');
const visualPlaces = document.getElementById('visualPlaces');
const visualDateClues = document.getElementById('visualDateClues');
const identityHelp = document.getElementById('identityHelp');
const peopleDirectoryBtn = document.getElementById('peopleDirectoryBtn');
const mobilePeopleDirectoryBtn = document.getElementById('mobilePeopleDirectoryBtn');
const peopleDialog = document.getElementById('peopleDialog');
const peopleDirectory = document.getElementById('peopleDirectory');
const closePeopleDialog = document.getElementById('closePeopleDialog');
const progressUpdated = document.getElementById('progressUpdated');
const technicalProgressLabel = document.getElementById('technicalProgressLabel');
const technicalProgressDetail = document.getElementById('technicalProgressDetail');
const technicalProgressBar = document.getElementById('technicalProgressBar');
const visualProgressLabel = document.getElementById('visualProgressLabel');
const visualProgressDetail = document.getElementById('visualProgressDetail');
const visualProgressBar = document.getElementById('visualProgressBar');
const scanProgressStatus = document.getElementById('scanProgressStatus');
let selectedVideoPath = null;
let editToken = null;
let knownPeople = [];
let searchTimer;
let searchRequestId = 0;
const SEARCH_PAGE_SIZE = 50;

// API Base URL
const API_BASE = '';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadTree('');
  setupEventListeners();
  setupVideoEvents();
  loadProcessProgress();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') loadProcessProgress();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadProcessProgress();
  });
});

let progressRequestInFlight = false;

async function loadProcessProgress() {
  if (progressRequestInFlight) return;
  progressRequestInFlight = true;
  try {
    const response = await fetch(`${API_BASE}/api/index/status`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderProcessProgress(await response.json());
  } catch (error) {
    progressUpdated.textContent = 'Estado no disponible';
    technicalProgressDetail.textContent = `No se pudo cargar el estado (${error.message})`;
    visualProgressDetail.textContent = 'Se volverá a intentar automáticamente.';
  } finally {
    progressRequestInFlight = false;
  }
}

function renderProcessProgress(status) {
  const technical = status.counts || {};
  const visual = status.visual_ready_counts || status.visual_counts || {};
  const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const format = value => count(value).toLocaleString('es-AR');
  const totalTechnical = Object.entries(technical)
    .filter(([key]) => key !== 'missing')
    .reduce((sum, [, value]) => sum + count(value), 0);
  const totalVisual = Object.values(visual).reduce((sum, value) => sum + count(value), 0);
  const technicalDone = count(technical.done);
  const visualDone = count(visual.done);
  const setProgress = (bar, label, done, total) => {
    const percent = total ? Math.round((done / total) * 1000) / 10 : 0;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.firstElementChild.style.width = `${percent}%`;
    label.textContent = `${format(done)} / ${format(total)} · ${percent.toLocaleString('es-AR')}%`;
  };

  setProgress(technicalProgressBar, technicalProgressLabel, technicalDone, totalTechnical);
  setProgress(visualProgressBar, visualProgressLabel, visualDone, totalVisual);
  technicalProgressDetail.textContent = [
    `${format(technical.pending)} pendientes`,
    `${format(technical.failed)} con error`,
    count(technical.missing) ? `${format(technical.missing)} fuera del último inventario` : ''
  ].filter(Boolean).join(' · ');
  visualProgressDetail.textContent = [
    `${format(visual.pending)} en cola`,
    `${format(visual.running)} en proceso`,
    `${format(visual.failed)} con error`,
    count(technical.pending) ? `${format(technical.pending)} esperando inventario técnico` : ''
  ].filter(Boolean).join(' · ');

  const scan = status.last_scan;
  scanProgressStatus.classList.add('hidden');
  scanProgressStatus.classList.remove('text-gray-400');
  scanProgressStatus.classList.add('text-amber-300');
  scanProgressStatus.textContent = '';
  if (scan) {
    const timestamp = scan.completed_at || scan.started_at;
    const date = timestamp ? new Date(`${timestamp.replace(' ', 'T')}Z`) : null;
    const formattedDate = date && !Number.isNaN(date.getTime())
      ? date.toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
      : '';
    if (scan.status === 'running') {
      scanProgressStatus.textContent = `Inventario en curso: ${format(scan.seen_count)} videos recorridos${formattedDate ? ` · iniciado ${formattedDate}` : ''}`;
      scanProgressStatus.classList.remove('hidden');
    } else if (scan.status === 'failed' || scan.status === 'interrupted') {
      let reason = '';
      if (scan.error) {
        reason = scan.error.includes('slow ffprobe')
          ? ' · Se detuvo porque ffprobe tardó demasiado en leer un video.'
          : ' · Revisá el registro del indexador para ver el detalle.';
      }
      scanProgressStatus.textContent = `Último inventario ${scan.status === 'interrupted' ? 'interrumpido' : 'con error'}${formattedDate ? ` · ${formattedDate}` : ''}${reason}`;
      scanProgressStatus.classList.remove('hidden');
    } else if (scan.status === 'done') {
      scanProgressStatus.textContent = `Último inventario completado${formattedDate ? ` · ${formattedDate}` : ''} · ${format(scan.seen_count)} videos recorridos`;
      scanProgressStatus.classList.remove('hidden', 'text-amber-300');
      scanProgressStatus.classList.add('text-gray-400');
    }
  }
  const refreshed = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  progressUpdated.textContent = `Actualizado ${refreshed}`;
}

function setupEventListeners() {
  // Refresh button
  refreshBtn.addEventListener('click', updateSearch);
  peopleDirectoryBtn.addEventListener('click', openPeopleDirectory);
  mobilePeopleDirectoryBtn.addEventListener('click', openPeopleDirectory);
  closePeopleDialog.addEventListener('click', () => peopleDialog.close());
  for (const input of [searchInput, mobileSearchInput]) {
    input.addEventListener('input', () => {
      const other = input === searchInput ? mobileSearchInput : searchInput;
      other.value = input.value;
      clearTimeout(searchTimer);
      const requestId = ++searchRequestId;
      const value = input.value.trim();
      if (!value && !searchFrom.value && !searchTo.value) {
        loadTree(currentPath);
      } else {
        searchTimer = setTimeout(() => searchVideos(value, 0, requestId), 250);
      }
    });
  }
  for (const [input, other] of [[searchFrom, mobileSearchFrom], [searchTo, mobileSearchTo], [mobileSearchFrom, searchFrom], [mobileSearchTo, searchTo]]) {
    input.addEventListener('change', () => { other.value = input.value; updateSearch(); });
  }
  peopleDialog.addEventListener('click', event => {
    if (event.target === peopleDialog) peopleDialog.close();
  });
  
  // Mobile sidebar
  mobileMenuBtn.addEventListener('click', openMobileSidebar);
  closeSidebar.addEventListener('click', closeMobileSidebar);
  sidebarOverlay.addEventListener('click', closeMobileSidebar);
  
  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMobileSidebar();
  });
}

function updateSearch() {
  clearTimeout(searchTimer);
  const requestId = ++searchRequestId;
  const query = searchInput.value.trim();
  if (!query && !searchFrom.value && !searchTo.value) loadTree(currentPath);
  else searchVideos(query, 0, requestId);
}

async function searchVideos(query, offset, requestId) {
  try {
    const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(SEARCH_PAGE_SIZE) });
    if (searchFrom.value) params.set('from', searchFrom.value);
    if (searchTo.value) params.set('to', searchTo.value);
    const response = await fetch(`${API_BASE}/api/search?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (requestId !== searchRequestId) return;
    renderSearchResults(data.items, folderTree, query, offset, requestId);
    renderSearchResults(data.items, mobileFolderTree, query, offset, requestId);
    breadcrumbs.classList.add('hidden');
  } catch (error) {
    if (requestId === searchRequestId) {
      folderTree.textContent = `Error al buscar: ${error.message}`;
      mobileFolderTree.textContent = `Error al buscar: ${error.message}`;
    }
  }
}

function renderSearchResults(items, container, query, offset, requestId) {
  if (offset === 0) container.replaceChildren();
  container.querySelector('.search-more')?.remove();
  if (!items.length && offset === 0) {
    container.textContent = 'No se encontraron videos';
    return;
  }
  let list = container.querySelector('ul.search-results');
  if (!list) {
    list = document.createElement('ul');
    list.className = 'search-results space-y-1';
    container.appendChild(list);
  }
  for (const item of items) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'w-full px-3 py-2 text-left rounded-lg hover:bg-gray-700 text-sm';
    const name = document.createElement('span');
    name.className = 'block truncate';
    name.textContent = item.visual_title || item.relative_path.split('/').pop();
    const detail = document.createElement('span');
    detail.className = 'block truncate text-xs text-gray-400';
    detail.textContent = `${item.recorded_at || 'Sin fecha'} · ${item.relative_path}${item.visual_summary ? ` · ${item.visual_summary}` : ''}`;
    button.append(name, detail);
    button.addEventListener('click', () => playVideo(item.relative_path, name.textContent));
    li.appendChild(button);
    list.appendChild(li);
  }
  if (items.length === SEARCH_PAGE_SIZE) {
    const more = document.createElement('li');
    more.className = 'search-more';
    const button = document.createElement('button');
    button.className = 'w-full px-3 py-2 text-left text-sm text-blue-300 hover:text-white';
    button.textContent = 'Ver más resultados';
    button.addEventListener('click', () => {
      document.querySelectorAll('.search-more').forEach(element => element.remove());
      searchVideos(query, offset + items.length, requestId);
    });
    more.appendChild(button);
    list.appendChild(more);
  }
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
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

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
    folderTree.textContent = `Error: ${err.message}`;
    mobileFolderTree.textContent = `Error: ${err.message}`;
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
          data-path="${escapeHtml(item.path)}"
          aria-expanded="false"
        >
          <svg class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
          </svg>
          <span class="truncate font-medium">${escapeHtml(item.name)}</span>
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
          data-path="${escapeHtml(item.path)}"
        >
          <svg class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <span class="truncate">${escapeHtml(item.name)}</span>
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
              data-path="${escapeHtml(item.path)}"
              aria-expanded="false"
            >
              <svg class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
              </svg>
              <span class="truncate font-medium">${escapeHtml(item.name)}</span>
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
              data-path="${escapeHtml(item.path)}"
            >
              <svg class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="truncate">${escapeHtml(item.name)}</span>
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
      <button class="breadcrumb-btn hover:text-white transition-colors" data-path="${escapeHtml(accumulated)}">${escapeHtml(part)}</button>
    `;
    li.querySelector('.breadcrumb-btn').addEventListener('click', () => loadTree(accumulated));
    breadcrumbList.appendChild(li);
  });
}

function playVideo(relativePath, name) {
  selectedVideoPath = relativePath;
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
  loadMetadata(relativePath);
  
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

async function loadMetadata(relativePath) {
  metadataPanel.classList.remove('hidden');
  metadataStatus.textContent = 'Cargando ficha...';
  metadataDuration.textContent = '';
  metadataResolution.textContent = '';
  metadataCodec.textContent = '';
  metadataDate.textContent = '';
  metadataDateEvidence.textContent = '';
  visualPeople.replaceChildren();
  identityHelp.textContent = '';
  visualMetadata.classList.add('hidden');
  try {
    const [response, peopleResponse] = await Promise.all([
      fetch(`${API_BASE}/api/metadata?path=${encodeURIComponent(relativePath)}`),
      fetch(`${API_BASE}/api/people`)
    ]);
    if (selectedVideoPath !== relativePath) return;
    if (response.status === 404) {
      metadataStatus.textContent = 'Pendiente de inventario';
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const item = await response.json();
    if (peopleResponse.ok) knownPeople = (await peopleResponse.json()).items || [];
    if (selectedVideoPath !== relativePath) return;
    metadataStatus.textContent = {
      pending: 'Pendiente de análisis técnico',
      failed: 'Error al leer el archivo',
      missing: 'Archivo no encontrado en el último inventario',
      done: 'Datos técnicos'
    }[item.status] || item.status;
    metadataDuration.textContent = item.duration_ms == null ? 'Desconocida' : `${Math.floor(item.duration_ms / 60000)}:${String(Math.floor(item.duration_ms / 1000) % 60).padStart(2, '0')}`;
    metadataResolution.textContent = item.width && item.height ? `${item.width} × ${item.height}` : 'Desconocida';
    metadataCodec.textContent = item.codec || 'Desconocido';
    metadataDate.textContent = item.recorded_at || 'Sin determinar';
    const sources = (item.date_candidates || []).map(candidate => `${candidate.date} (${candidate.source})`);
    metadataDateEvidence.textContent = sources.length ? `Fechas encontradas: ${sources.join(' · ')}` : 'No se encontraron fechas en el archivo o su nombre.';
    renderVisualMetadata(item);
  } catch (error) {
    if (selectedVideoPath === relativePath) metadataStatus.textContent = `Error al cargar la ficha: ${error.message}`;
  }
}

function tokenForEditing() {
  if (!editToken) {
    editToken = window.prompt('Token de edición del servidor:');
    if (!editToken) return null;
  }
  return editToken;
}

async function saveObservationIdentity(observationIndex, assignment) {
  const pathToEdit = selectedVideoPath;
  if (!pathToEdit) return;
  const token = tokenForEditing();
  if (!token) return;
  try {
    const response = await fetch(`${API_BASE}/api/metadata/person`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: pathToEdit, observation_index: observationIndex, ...assignment })
    });
    if (response.status === 401) editToken = null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    knownPeople = result.people || knownPeople;
    if (selectedVideoPath === pathToEdit) await loadMetadata(pathToEdit);
  } catch (error) {
    window.alert(`No se pudo guardar la identificación: ${error.message}`);
  }
}

async function openPeopleDirectory() {
  try {
    const response = await fetch(`${API_BASE}/api/people`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    knownPeople = (await response.json()).items || [];
    renderPeopleDirectory();
    peopleDialog.showModal();
  } catch (error) {
    window.alert(`No se pudo cargar la lista de personas: ${error.message}`);
  }
}

function renderPeopleDirectory() {
  peopleDirectory.replaceChildren();
  if (!knownPeople.length) {
    const empty = document.createElement('p');
    empty.className = 'p-4 text-sm text-gray-400';
    empty.textContent = 'Todavía no hay personas identificadas. Asigná un nombre a una aparición desde la ficha de un video.';
    peopleDirectory.appendChild(empty);
    return;
  }
  for (const person of knownPeople) {
    const button = document.createElement('button');
    button.className = 'flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left hover:bg-gray-700';
    const name = document.createElement('span');
    name.className = 'font-medium';
    name.textContent = person.name;
    const count = document.createElement('span');
    count.className = 'text-xs text-gray-400';
    count.textContent = `${person.videos} ${person.videos === 1 ? 'video' : 'videos'}`;
    button.append(name, count);
    button.addEventListener('click', () => {
      searchInput.value = person.name;
      mobileSearchInput.value = person.name;
      searchFrom.value = '';
      searchTo.value = '';
      mobileSearchFrom.value = '';
      mobileSearchTo.value = '';
      peopleDialog.close();
      updateSearch();
    });
    peopleDirectory.appendChild(button);
  }
}

function renderVisualMetadata(item) {
  if (item.visual_status !== 'done') {
    if (item.visual_status === 'failed') metadataStatus.textContent += ' · Análisis visual fallido';
    return;
  }
  visualMetadata.classList.remove('hidden');
  visualTitle.textContent = item.visual_title || 'Descripción visual';
  visualSummary.textContent = item.visual_summary || '';
  visualUncertainty.textContent = item.visual_uncertainty ? `Límites de la descripción: ${item.visual_uncertainty}` : 'Descripción basada en fotogramas puntuales.';
  renderIdentityAssignments(item);
  renderTimedList(visualEvents, 'Momentos observados', item.visual_events);
  renderTimedList(visualDateClues, 'Pistas de fecha visibles', item.visual_date_clues);
  visualPlaces.textContent = item.visual_places?.length ? `Lugares o entornos: ${item.visual_places.join(', ')}` : '';
}

function renderIdentityAssignments(item) {
  visualPeople.replaceChildren();
  const observations = item.visual_people || [];
  if (!observations.length) {
    visualPeople.textContent = 'No se detectaron personas en los fotogramas analizados.';
    return;
  }
  identityHelp.textContent = item.can_edit_people
    ? 'La identificación es manual: elegí una persona conocida o creá una nueva. La asociación queda guardada para este video y se puede buscar.'
    : 'Las descripciones son sugerencias visuales. La identificación requiere habilitar edición.';

  observations.forEach((observation, index) => {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-1 gap-2 rounded-lg border border-gray-700 bg-gray-900/50 p-3 sm:grid-cols-[1fr_13rem] sm:items-center';
    const seek = document.createElement('button');
    seek.className = 'text-left text-gray-200 hover:text-white';
    seek.textContent = `${observation.description} (${Math.floor(observation.at_seconds / 60)}:${String(observation.at_seconds % 60).padStart(2, '0')})`;
    seek.addEventListener('click', () => {
      videoPlayer.currentTime = observation.at_seconds;
      videoPlayer.play().catch(() => {});
    });
    row.appendChild(seek);

    const assigned = item.identified_people?.[index];
    if (!item.can_edit_people) {
      if (assigned?.name) {
        const label = document.createElement('span');
        label.className = 'text-xs text-green-300';
        label.textContent = `Identificada: ${assigned.name}`;
        row.appendChild(label);
      }
    } else {
      const select = document.createElement('select');
      select.className = 'w-full rounded border border-gray-600 bg-gray-800 px-2 py-2 text-sm';
      select.setAttribute('aria-label', 'Asignar identidad a esta persona observada');
      const unknown = document.createElement('option');
      unknown.value = '';
      unknown.textContent = 'Sin identificar';
      select.appendChild(unknown);
      for (const person of knownPeople) {
        const option = document.createElement('option');
        option.value = String(person.id);
        option.textContent = person.name;
        select.appendChild(option);
      }
      const create = document.createElement('option');
      create.value = '__new__';
      create.textContent = '+ Crear persona…';
      select.appendChild(create);
      select.value = assigned?.id ? String(assigned.id) : '';
      select.addEventListener('change', async () => {
        const selection = select.value;
        if (selection === '__new__') {
          select.value = assigned?.id ? String(assigned.id) : '';
          const name = window.prompt('Nombre de esta persona:');
          if (name?.trim()) await saveObservationIdentity(index, { person_name: name.trim() });
        } else if (selection === '') {
          await saveObservationIdentity(index, { person_id: null });
        } else {
          await saveObservationIdentity(index, { person_id: Number(selection) });
        }
      });
      row.appendChild(select);
    }
    visualPeople.appendChild(row);
  });
}

function renderTimedList(container, label, items) {
  container.replaceChildren();
  if (!items?.length) return;
  const heading = document.createElement('strong');
  heading.textContent = `${label}: `;
  container.appendChild(heading);
  items.forEach((item, index) => {
    if (index) container.appendChild(document.createTextNode(' · '));
    const button = document.createElement('button');
    button.className = 'text-blue-300 hover:text-white underline';
    button.textContent = `${item.description} (${Math.floor(item.at_seconds / 60)}:${String(item.at_seconds % 60).padStart(2, '0')})`;
    button.addEventListener('click', () => {
      videoPlayer.currentTime = item.at_seconds;
      videoPlayer.play().catch(() => {});
    });
    container.appendChild(button);
  });
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
