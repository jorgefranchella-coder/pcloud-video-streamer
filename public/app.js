// State
let currentPath = '';
let searchFolderPath = '';
let pathHistory = [''];
let historyIndex = 0;

// DOM Elements
const folderTree = document.getElementById('folderTree');
const mobileFolderTree = document.getElementById('mobileFolderTree');
const videoPlayer = document.getElementById('videoPlayer');
const videoTitle = document.getElementById('videoTitle');
const videoInfo = document.getElementById('videoInfo');
const emptyState = document.getElementById('emptyState');
const emptyStateMessage = document.getElementById('emptyStateMessage');
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
const searchWithinFolder = document.getElementById('searchWithinFolder');
const mobileSearchFrom = document.getElementById('mobileSearchFrom');
const mobileSearchTo = document.getElementById('mobileSearchTo');
const mobileSearchWithinFolder = document.getElementById('mobileSearchWithinFolder');
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
const effectiveConfiguration = document.getElementById('effectiveConfiguration');
let selectedVideoPath = null;
let playbackRequestId = 0;
let selectedPersonId = null;
let editToken = null;
let knownPeople = [];
let knownPersonMerges = [];
let canEditPeopleDirectory = false;
let searchTimer;
let searchRequestId = 0;
const SEARCH_PAGE_SIZE = 50;

// API Base URL
const API_BASE = '';

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  if (!await establishAccessSession()) {
    if (!folderTree.textContent) {
      folderTree.textContent = 'Acceso requerido para consultar la biblioteca.';
      mobileFolderTree.textContent = 'Acceso requerido para consultar la biblioteca.';
    }
    progressUpdated.textContent = 'Sesión no iniciada';
    return;
  }
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

async function establishAccessSession() {
  try {
    const statusResponse = await fetch(`${API_BASE}/api/access/status`, { credentials: 'same-origin' });
    if (!statusResponse.ok) throw new Error(`HTTP ${statusResponse.status}`);
    const status = await statusResponse.json();
    if (!status.required || status.authenticated) return true;

    const token = window.prompt('Token de acceso a la biblioteca:');
    if (!token) return false;
    const response = await fetch(`${API_BASE}/api/access/session`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (!response.ok) {
      window.alert(response.status === 401 ? 'El token no es válido.' : `No se pudo iniciar sesión (HTTP ${response.status}).`);
      return false;
    }
    return true;
  } catch (error) {
    const detail = error.message === 'HTTP 404'
      ? 'El servidor no reconoce /api/access/status. Reiniciá pcloud-video-streamer.service y recargá la página.'
      : `No se pudo verificar el acceso (${error.message}).`;
    folderTree.textContent = detail;
    mobileFolderTree.textContent = detail;
    return false;
  }
}

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
  const retryWait = status.visual_retry_wait || {};
  const dailyBudget = status.visual_daily_budget || {};
  const retryEnabled = status.worker_configuration?.visual?.retry_failed;
  const retryAt = retryWait.next_at ? new Date(`${retryWait.next_at.replace(' ', 'T')}Z`) : null;
  const retryTime = retryAt && !Number.isNaN(retryAt.getTime())
    ? retryAt.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
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
    count(retryWait.ready_count) && retryEnabled ? `${format(retryWait.ready_count)} listos para reintento` : '',
    count(retryWait.ready_count) && !retryEnabled ? `${format(retryWait.ready_count)} reintentos vencidos · activá RETRY_VISUAL_FAILED` : '',
    count(retryWait.count) > count(retryWait.ready_count) ? `${format(count(retryWait.count) - count(retryWait.ready_count))} esperando reintento${retryTime ? ` · próximo ${retryTime}` : ''}` : '',
    count(dailyBudget.limit) ? `Solicitudes del proveedor hoy: ${format(dailyBudget.requests)} / ${format(dailyBudget.limit)} UTC${count(dailyBudget.remaining) === 0 ? ' · límite alcanzado, se renueva a las 00:00 UTC' : ''}` : '',
    count(technical.pending) ? `${format(technical.pending)} esperando inventario técnico` : ''
  ].filter(Boolean).join(' · ');

  const configured = status.worker_configuration || {};
  const activity = status.worker_activity || {};
  const visualWorker = activity['visual-analyzer'];
  const providerControl = status.visual_provider_control || {};
  if (visualWorker?.active) {
    const current = visualWorker.current_path ? ` · ${visualWorker.current_path}` : '';
    const phase = visualWorker.phase ? ` (${visualWorker.phase})` : '';
    visualProgressDetail.textContent += ` · Procesando${current}${phase}`;
  } else if (visualWorker?.stale) {
    visualProgressDetail.textContent += ' · El último proceso visual se interrumpió; se recuperará al reiniciar el analizador.';
  } else if (count(visual.running)) {
    visualProgressDetail.textContent += ' · Hay fichas running, pero no se confirma un proceso visual activo.';
  }
  if (providerControl.paused) {
    const until = providerControl.paused_until ? new Date(`${providerControl.paused_until.replace(' ', 'T')}Z`) : null;
    const waitText = until && !Number.isNaN(until.getTime())
      ? `hasta ${until.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })} UTC`
      : 'cambiar clave, modelo o endpoint para reactivar';
    visualProgressDetail.textContent += ` · Proveedor pausado: ${providerControl.reason} · ${waitText}`;
  }
  const visualTimer = status.visual_timer || {};
  if (visualTimer.load_state === 'not-found') {
    visualProgressDetail.textContent += ' · Continuación automática desactivada: timer visual no instalado';
  } else if (visualTimer.active) {
    const next = visualTimer.next_run ? ` · próximo lote ${visualTimer.next_run}` : '';
    visualProgressDetail.textContent += ` · Timer visual activo${next}`;
  } else if (visualTimer.available) {
    visualProgressDetail.textContent += visualTimer.enabled
      ? ' · Timer visual habilitado, esperando próximo disparo'
      : ' · Timer visual instalado pero deshabilitado';
  }
  const history = status.worker_history || {};
  const describeLastRun = run => {
    if (!run) return '';
    const timestamp = run.finished_at || run.started_at;
    const date = timestamp ? new Date(`${timestamp.replace(' ', 'T')}Z`) : null;
    const time = date && !Number.isNaN(date.getTime())
      ? date.toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const state = run.status === 'done' ? 'completado' : run.status === 'failed' ? 'falló' : 'interrumpido';
    const detail = (run.last_error || run.last_result || '').slice(0, 140);
    return `Último lote ${state}${time ? ` · ${time}` : ''}${detail ? ` · ${detail}` : ''}`;
  };
  if (!activity.indexer?.active && history.indexer?.[0]) {
    technicalProgressDetail.textContent += ` · ${describeLastRun(history.indexer[0])}`;
  }
  if (!visualWorker?.active && history['visual-analyzer']?.[0]) {
    visualProgressDetail.textContent += ` · ${describeLastRun(history['visual-analyzer'][0])}`;
  }
  const settings = [];
  if (configured.technical) {
    const effective = configured.technical;
    const batch = effective.max_probes === 0 ? 'sin límite' : `lote ${format(effective.max_probes)}`;
    settings.push(effective.inventory_only
      ? 'Técnico: solo inventario'
      : `Técnico: ${batch}, timeout ${format(effective.probe_timeout_ms / 1000)} s, reintentos ${effective.retry_failed ? 'activos' : 'desactivados'}`);
  }
  if (configured.visual) {
    const effective = configured.visual;
    const target = effective.video_id ? ` · video puntual ${effective.video_id}` : '';
    const requestLimit = effective.max_visual_requests_per_day
      ? `, ${format(effective.max_visual_requests_per_day)} solicitudes/día UTC`
      : ', solicitudes/día sin límite';
    settings.push(`Visual: ${effective.model}, lote ${format(effective.max_visual)}, máximo ${format(effective.max_visual_attempts)} intentos${requestLimit}, reintentos ${effective.retry_failed ? 'activos' : 'desactivados'}${target}`);
  }
  effectiveConfiguration.textContent = settings.length
    ? `Configuración efectiva de la última ejecución: ${settings.join(' · ')}`
    : 'Configuración efectiva: se mostrará después de la primera ejecución de cada proceso.';

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
      const indexerWorker = activity.indexer;
      if (indexerWorker?.stale) {
        scanProgressStatus.textContent = `Inventario interrumpido: el proceso dejó de responder tras recorrer ${format(scan.seen_count)} videos. El próximo inicio lo reconciliará.`;
      } else if (!indexerWorker?.active) {
        scanProgressStatus.textContent = `El último inventario figura en curso tras ${format(scan.seen_count)} videos, pero no se confirma un indexador activo.`;
      } else {
        const current = indexerWorker?.current_path ? ` · ${indexerWorker.current_path}` : '';
        const phase = indexerWorker?.phase ? ` (${indexerWorker.phase})` : '';
        scanProgressStatus.textContent = `Inventario en curso: ${format(scan.seen_count)} videos recorridos${current}${phase}${formattedDate ? ` · iniciado ${formattedDate}` : ''}`;
      }
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
      selectedPersonId = null;
      const other = input === searchInput ? mobileSearchInput : searchInput;
      other.value = input.value;
      clearTimeout(searchTimer);
      const requestId = ++searchRequestId;
      const value = input.value.trim();
      if (!value && !searchFrom.value && !searchTo.value && !isScopedFolderSearch()) {
        loadTree(currentPath);
      } else {
        searchTimer = setTimeout(() => searchVideos(value, 0, requestId), 250);
      }
    });
  }
  for (const [checkbox, other] of [[searchWithinFolder, mobileSearchWithinFolder], [mobileSearchWithinFolder, searchWithinFolder]]) {
    checkbox.addEventListener('change', () => {
      other.checked = checkbox.checked;
      updateSearch();
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
  if (!query && !searchFrom.value && !searchTo.value && !selectedPersonId && !isScopedFolderSearch()) loadTree(currentPath);
  else searchVideos(query, 0, requestId);
}

function isScopedFolderSearch() {
  return Boolean(searchFolderPath && (searchWithinFolder.checked || mobileSearchWithinFolder.checked));
}

function setSearchFolderPath(path) {
  searchFolderPath = path;
  const canSearchFolder = Boolean(path);
  searchWithinFolder.disabled = !canSearchFolder;
  mobileSearchWithinFolder.disabled = !canSearchFolder;
  if (!canSearchFolder) {
    searchWithinFolder.checked = false;
    mobileSearchWithinFolder.checked = false;
  }
}

async function searchVideos(query, offset, requestId, folder = isScopedFolderSearch() ? searchFolderPath : null) {
  try {
    const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(SEARCH_PAGE_SIZE) });
    if (searchFrom.value) params.set('from', searchFrom.value);
    if (searchTo.value) params.set('to', searchTo.value);
    if (selectedPersonId) params.set('person_id', String(selectedPersonId));
    if (folder) params.set('folder', folder);
    const response = await fetch(`${API_BASE}/api/search?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (requestId !== searchRequestId) return;
    renderSearchResults(data.items, folderTree, query, offset, requestId, folder);
    renderSearchResults(data.items, mobileFolderTree, query, offset, requestId, folder);
    breadcrumbs.classList.add('hidden');
  } catch (error) {
    if (requestId === searchRequestId) {
      folderTree.textContent = `Error al buscar: ${error.message}`;
      mobileFolderTree.textContent = `Error al buscar: ${error.message}`;
    }
  }
}

function renderSearchResults(items, container, query, offset, requestId, folder) {
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
    const matchTime = Number.isFinite(item.match_at_seconds)
      ? ` · Momento: ${Math.floor(item.match_at_seconds / 60)}:${String(Math.floor(item.match_at_seconds % 60)).padStart(2, '0')}` : '';
    detail.textContent = `${item.recorded_at || 'Sin fecha'} · ${item.relative_path}${matchTime}${item.snippet ? ` · Coincidencia: ${item.snippet}` : item.visual_summary ? ` · ${item.visual_summary}` : ''}`;
    button.append(name, detail);
    button.addEventListener('click', () => playVideo(item.relative_path, name.textContent, item.match_at_seconds));
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
      searchVideos(query, offset + items.length, requestId, folder);
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
    if (videoPlayer.error?.code === 1) return;
    loadingState.classList.add('hidden');
    emptyState.classList.remove('hidden');
    videoTitle.textContent = 'Error al cargar el vídeo';
    videoInfo.textContent = '';
    videoInfo.classList.add('hidden');
    const messages = {
      2: 'No se pudo leer el video. Revisá la conexión con pCloud y que el archivo siga disponible.',
      3: 'El navegador no pudo decodificar este video. Puede estar dañado o usar un códec no compatible.',
      4: 'El navegador no admite este formato o sus códecs. El servidor no convierte los videos.'
    };
    emptyStateMessage.textContent = messages[videoPlayer.error?.code] || 'No se pudo reproducir este video. Revisá el archivo, la conexión y los códecs admitidos por el navegador.';
    console.error('Video error:', e, videoPlayer.error?.code);
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
  setSearchFolderPath(path);
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
    li.appendChild(createTreeButton(item, li));
    ul.appendChild(li);
  });
  
  container.innerHTML = '';
  container.appendChild(ul);
}

function createTreeButton(item, parentLi) {
  const folder = item.type === 'folder';
  const button = document.createElement('button');
  button.className = `${folder ? 'folder-btn' : 'video-btn'} w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg hover:bg-gray-700 transition-colors text-sm`;
  button.dataset.path = item.path;
  if (folder) {
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<svg class="w-5 h-5 text-yellow-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg><span class="truncate font-medium"></span><svg class="w-4 h-4 text-gray-500 ml-auto folder-chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
    button.querySelector('span').textContent = item.name;
    button.addEventListener('click', () => {
      setSearchFolderPath(item.path);
      const expanded = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', String(!expanded));
      button.querySelector('.folder-chevron').style.transform = expanded ? 'rotate(0deg)' : 'rotate(90deg)';
      if (expanded) parentLi.querySelector('ul.subfolder')?.remove();
      else loadSubfolder(item.path, parentLi);
    });
  } else {
    button.innerHTML = '<svg class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span class="truncate"></span>';
    button.querySelector('span').textContent = item.name;
    button.addEventListener('click', () => playVideo(item.path, item.name));
  }
  return button;
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
        li.appendChild(createTreeButton(item, li));
        subUl.appendChild(li);
      });
      
      parentLi.appendChild(subUl);
    }
  } catch (err) {
    console.error('Failed to load subfolder:', err);
  }
}

function renderBreadcrumbs(path) {
  breadcrumbList.replaceChildren();

  const rootLi = document.createElement('li');
  const rootButton = document.createElement('button');
  rootButton.className = 'breadcrumb-btn hover:text-white transition-colors';
  rootButton.textContent = '/';
  rootButton.addEventListener('click', () => loadTree(''));
  rootLi.appendChild(rootButton);
  breadcrumbList.appendChild(rootLi);
  if (path === '') return;

  const parts = path.split('/');
  let accumulated = '';
  parts.forEach(part => {
    accumulated += (accumulated ? '/' : '') + part;

    const separator = document.createElement('li');
    const slash = document.createElement('span');
    slash.className = 'text-gray-500 mx-1';
    slash.textContent = '/';
    separator.appendChild(slash);
    breadcrumbList.appendChild(separator);

    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'breadcrumb-btn hover:text-white transition-colors';
    button.dataset.path = accumulated;
    button.textContent = part;
    button.addEventListener('click', () => loadTree(accumulated));
    li.appendChild(button);
    breadcrumbList.appendChild(li);
  });
}

function playVideo(relativePath, name, seekToSeconds = null) {
  const requestId = ++playbackRequestId;
  selectedVideoPath = relativePath;
  // Update UI
  videoTitle.textContent = name;
  videoInfo.textContent = relativePath;
  videoInfo.classList.remove('hidden');
  emptyState.classList.add('hidden');
  loadingState.classList.remove('hidden');
  
  // Set video source
  const streamUrl = `${API_BASE}/api/stream?path=${encodeURIComponent(relativePath)}`;
  if (Number.isFinite(seekToSeconds) && seekToSeconds >= 0) {
    videoPlayer.addEventListener('loadedmetadata', () => {
      if (requestId === playbackRequestId && selectedVideoPath === relativePath) videoPlayer.currentTime = seekToSeconds;
    }, { once: true });
  }
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
  if (!pathToEdit) return false;
  const token = tokenForEditing();
  if (!token) return false;
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
    return true;
  } catch (error) {
    window.alert(`No se pudo guardar la identificación: ${error.message}`);
    return false;
  }
}

async function openPeopleDirectory() {
  try {
    const response = await fetch(`${API_BASE}/api/people`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    knownPeople = data.items || [];
    knownPersonMerges = data.merges || [];
    canEditPeopleDirectory = Boolean(data.can_edit_people);
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
  }
  for (const person of knownPeople) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-gray-700';
    const button = document.createElement('button');
    button.className = 'flex min-w-0 flex-1 items-center justify-between gap-3 py-1 text-left';
    const name = document.createElement('span');
    name.className = 'font-medium';
    name.textContent = person.name;
    const count = document.createElement('span');
    count.className = 'text-xs text-gray-400';
    count.textContent = `${person.videos} ${person.videos === 1 ? 'video' : 'videos'}`;
    button.append(name, count);
    button.addEventListener('click', () => {
      selectedPersonId = person.id;
      searchInput.value = person.name;
      mobileSearchInput.value = person.name;
      searchFrom.value = '';
      searchTo.value = '';
      mobileSearchFrom.value = '';
      mobileSearchTo.value = '';
      peopleDialog.close();
      updateSearch();
    });
    row.appendChild(button);
    if (canEditPeopleDirectory) {
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'shrink-0 rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:bg-gray-600 hover:text-white';
      rename.textContent = 'Renombrar';
      rename.setAttribute('aria-label', `Renombrar a ${person.name}`);
      rename.addEventListener('click', () => renameDirectoryPerson(person));
      row.appendChild(rename);
      if (knownPeople.length > 1) {
        const merge = document.createElement('button');
        merge.type = 'button';
        merge.className = 'shrink-0 rounded border border-amber-800 px-2 py-1 text-xs text-amber-200 hover:bg-amber-900';
        merge.textContent = 'Combinar';
        merge.setAttribute('aria-label', `Combinar ${person.name} con otra persona`);
        merge.addEventListener('click', () => mergeDirectoryPerson(person));
        row.appendChild(merge);
      }
    }
    peopleDirectory.appendChild(row);
  }
  renderPersonMergeHistory();
}

async function renameDirectoryPerson(person) {
  const name = window.prompt(`Nuevo nombre para ${person.name}:`, person.name);
  if (name == null || name.trim() === person.name) return;
  const token = tokenForEditing();
  if (!token) return;
  try {
    const response = await fetch(`${API_BASE}/api/people/${person.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: name.trim() })
    });
    if (response.status === 401) editToken = null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    knownPeople = result.items || knownPeople;
    knownPersonMerges = result.merges || knownPersonMerges;
    if (selectedPersonId === person.id) {
      const canonicalName = knownPeople.find(item => item.id === person.id)?.name || name.trim();
      searchInput.value = canonicalName;
      mobileSearchInput.value = canonicalName;
      updateSearch();
    }
    renderPeopleDirectory();
  } catch (error) {
    window.alert(`No se pudo renombrar la persona: ${error.message}`);
  }
}

async function mergeDirectoryPerson(source) {
  const targets = knownPeople.filter(person => person.id !== source.id);
  const choices = targets.map(person => `${person.id}: ${person.name}`).join('\n');
  const rawTargetId = window.prompt(`Combiná “${source.name}” dentro de esta persona. Escribí el ID destino:\n${choices}`);
  if (rawTargetId == null) return;
  const targetId = Number(rawTargetId.trim());
  const target = targets.find(person => person.id === targetId);
  if (!target) {
    window.alert('Ese ID no corresponde a otra persona del catálogo.');
    return;
  }
  if (!window.confirm(`Mover las asignaciones de “${source.name}” a “${target.name}”. Se guardará la fusión y se podrá deshacer desde este directorio. ¿Continuar?`)) return;
  const token = tokenForEditing();
  if (!token) return;
  try {
    const response = await fetch(`${API_BASE}/api/people/${source.id}/merge`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_person_id: target.id })
    });
    if (response.status === 401) editToken = null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    knownPeople = result.items || knownPeople;
    knownPersonMerges = result.merges || knownPersonMerges;
    if (selectedPersonId === source.id) {
      selectedPersonId = target.id;
      searchInput.value = target.name;
      mobileSearchInput.value = target.name;
      updateSearch();
    }
    renderPeopleDirectory();
  } catch (error) {
    window.alert(`No se pudo combinar las personas: ${error.message}`);
  }
}

function renderPersonMergeHistory() {
  if (!knownPersonMerges.length) return;
  const section = document.createElement('section');
  section.className = 'mt-4 border-t border-gray-700 pt-3';
  const heading = document.createElement('h3');
  heading.className = 'mb-2 text-sm font-semibold';
  heading.textContent = 'Historial de fusiones';
  section.appendChild(heading);
  for (const merge of knownPersonMerges) {
    const row = document.createElement('div');
    row.className = 'mb-2 flex items-center justify-between gap-2 rounded bg-gray-900/60 p-2 text-xs';
    const description = document.createElement('span');
    description.textContent = `${merge.source_name} → ${merge.target_name} · ${merge.status === 'active' ? 'activa' : 'deshecha'}`;
    row.appendChild(description);
    if (canEditPeopleDirectory && merge.status === 'active') {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'shrink-0 rounded border border-gray-600 px-2 py-1 hover:bg-gray-700';
      undo.textContent = 'Deshacer';
      undo.addEventListener('click', () => undoDirectoryMerge(merge));
      row.appendChild(undo);
    }
    section.appendChild(row);
  }
  peopleDirectory.appendChild(section);
}

async function undoDirectoryMerge(merge) {
  if (!window.confirm(`Deshacer la fusión de “${merge.source_name}” en “${merge.target_name}”? Las asignaciones que se hayan cambiado después se conservarán.`)) return;
  const token = tokenForEditing();
  if (!token) return;
  try {
    const response = await fetch(`${API_BASE}/api/people/merges/${merge.id}/undo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.status === 401) editToken = null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    knownPeople = result.items || knownPeople;
    knownPersonMerges = result.merges || knownPersonMerges;
    if (selectedPersonId === merge.target_person_id) updateSearch();
    renderPeopleDirectory();
  } catch (error) {
    window.alert(`No se pudo deshacer la fusión: ${error.message}`);
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
  renderTimedList(visualEvents, 'Momentos observados', item.visual_events, item);
  renderTimedList(visualDateClues, 'Pistas de fecha visibles', item.visual_date_clues, item);
  visualPlaces.textContent = item.visual_places?.length ? `Lugares o entornos: ${item.visual_places.join(', ')}` : '';
}

function renderIdentityAssignments(item) {
  visualPeople.replaceChildren();
  const observations = item.visual_people || [];
  const stale = item.stale_identifications || [];
  if (stale.length) {
    const review = document.createElement('div');
    review.className = 'mb-3 rounded-lg border border-amber-700 bg-amber-950/30 p-3 text-sm text-amber-100';
    const heading = document.createElement('strong');
    heading.textContent = 'Asignaciones de una ficha anterior: revisalas';
    review.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'mt-2 space-y-2';
    stale.forEach(previous => {
      const entry = document.createElement('div');
      entry.className = 'rounded border border-amber-800/70 p-2';
      const description = previous.description || 'Observación sin descripción';
      const time = `${Math.floor(previous.at_seconds / 60)}:${String(Math.floor(previous.at_seconds % 60)).padStart(2, '0')}`;
      const summary = document.createElement('p');
      summary.textContent = `${previous.name}: ${description} (${time})`;
      entry.appendChild(summary);
      if (observations.length && item.can_edit_people) {
        const controls = document.createElement('div');
        controls.className = 'mt-2 flex flex-col gap-2 sm:flex-row';
        const select = document.createElement('select');
        select.className = 'min-w-0 flex-1 rounded border border-amber-800 bg-gray-900 px-2 py-2 text-sm text-white';
        select.setAttribute('aria-label', `Elegir observación actual para reasignar a ${previous.name}`);
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Elegí una observación de la ficha actual…';
        select.appendChild(placeholder);
        observations.forEach((observation, index) => {
          const option = document.createElement('option');
          option.value = String(index);
          option.textContent = `${observation.description} (${Math.floor(observation.at_seconds / 60)}:${String(Math.floor(observation.at_seconds % 60)).padStart(2, '0')})`;
          select.appendChild(option);
        });
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'rounded bg-amber-700 px-3 py-2 text-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50';
        apply.textContent = 'Reasignar';
        apply.disabled = true;
        select.addEventListener('change', () => { apply.disabled = select.value === ''; });
        apply.addEventListener('click', async () => {
          if (select.value === '') return;
          apply.disabled = true;
          const saved = await saveObservationIdentity(Number(select.value), {
            person_id: previous.person_id,
            stale_observation: {
              analysis_revision: previous.analysis_revision,
              observation_index: previous.observation_index
            }
          });
          if (!saved) apply.disabled = false;
        });
        controls.append(select, apply);
        entry.appendChild(controls);
      }
      list.appendChild(entry);
    });
    review.appendChild(list);
    visualPeople.appendChild(review);
  }
  if (!observations.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No se detectaron personas en los fotogramas analizados.';
    visualPeople.appendChild(empty);
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
    appendEvidenceThumbnail(row, item, observation.at_seconds, observation.description);

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

function appendEvidenceThumbnail(container, item, atSeconds, description) {
  if (!item.visual_evidence?.some(evidence => evidence.at_seconds === atSeconds)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'col-span-full justify-self-start rounded border border-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400';
  button.setAttribute('aria-label', `Ampliar fotograma de evidencia: ${description}`);
  const image = document.createElement('img');
  image.className = 'h-20 w-32 rounded object-contain bg-black';
  image.loading = 'lazy';
  image.alt = `Fotograma de evidencia en el segundo ${atSeconds}: ${description}`;
  const params = new URLSearchParams({ path: item.relative_path, revision: item.visual_revision, at_seconds: String(atSeconds) });
  image.src = `${API_BASE}/api/metadata/evidence?${params}`;
  button.appendChild(image);
  button.addEventListener('click', () => {
    const expanded = image.classList.toggle('max-h-80');
    image.classList.toggle('h-20', !expanded);
    image.classList.toggle('w-32', !expanded);
    image.classList.toggle('max-w-full', expanded);
    image.classList.toggle('object-contain', true);
    button.setAttribute('aria-label', `${expanded ? 'Reducir' : 'Ampliar'} fotograma de evidencia: ${description}`);
  });
  container.appendChild(button);
}

function renderTimedList(container, label, items, videoItem) {
  container.replaceChildren();
  if (!items?.length) return;
  const heading = document.createElement('strong');
  heading.textContent = `${label}: `;
  container.appendChild(heading);
  items.forEach(item => {
    const entry = document.createElement('div');
    entry.className = 'mb-2 flex flex-wrap items-center gap-x-2 gap-y-1';
    const button = document.createElement('button');
    button.className = 'text-blue-300 hover:text-white underline';
    button.textContent = `${item.description} (${Math.floor(item.at_seconds / 60)}:${String(item.at_seconds % 60).padStart(2, '0')})`;
    button.addEventListener('click', () => {
      videoPlayer.currentTime = item.at_seconds;
      videoPlayer.play().catch(() => {});
    });
    entry.appendChild(button);
    appendEvidenceThumbnail(entry, videoItem, item.at_seconds, item.description);
    container.appendChild(entry);
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
