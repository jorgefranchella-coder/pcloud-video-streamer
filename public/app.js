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
const searchStatus = document.getElementById('searchStatus');
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
const metadataLocation = document.getElementById('metadataLocation');
const metadataMapLink = document.getElementById('metadataMapLink');
const metadataCaptureDevice = document.getElementById('metadataCaptureDevice');
const exportMetadataBtn = document.getElementById('exportMetadataBtn');
const importMetadataBtn = document.getElementById('importMetadataBtn');
const metadataExportStatus = document.getElementById('metadataExportStatus');
const visualMetadata = document.getElementById('visualMetadata');
const visualTitle = document.getElementById('visualTitle');
const visualSummary = document.getElementById('visualSummary');
const visualUncertainty = document.getElementById('visualUncertainty');
const visualPeople = document.getElementById('visualPeople');
const visualEvents = document.getElementById('visualEvents');
const visualPlaces = document.getElementById('visualPlaces');
const visualDateClues = document.getElementById('visualDateClues');
const identityHelp = document.getElementById('identityHelp');
const faceIdentityPanel = document.getElementById('faceIdentityPanel');
const faceIdentityResults = document.getElementById('faceIdentityResults');
const peopleDirectoryBtn = document.getElementById('peopleDirectoryBtn');
const mobilePeopleDirectoryBtn = document.getElementById('mobilePeopleDirectoryBtn');
const faceReviewBtn = document.getElementById('faceReviewBtn');
const mobileFaceReviewBtn = document.getElementById('mobileFaceReviewBtn');
const peopleDialog = document.getElementById('peopleDialog');
const peopleDirectory = document.getElementById('peopleDirectory');
const closePeopleDialog = document.getElementById('closePeopleDialog');
const faceReviewDialog = document.getElementById('faceReviewDialog');
const closeFaceReview = document.getElementById('closeFaceReview');
const faceInboxStatus = document.getElementById('faceInboxStatus');
const faceInboxGrid = document.getElementById('faceInboxGrid');
const faceLoadMore = document.getElementById('faceLoadMore');
const faceInboxPendingMode = document.getElementById('faceInboxPendingMode');
const faceInboxAutomaticMode = document.getElementById('faceInboxAutomaticMode');
const faceSelectedStatus = document.getElementById('faceSelectedStatus');
const faceNeighborGrid = document.getElementById('faceNeighborGrid');
const faceAssignmentControls = document.getElementById('faceAssignmentControls');
const facePersonSelect = document.getElementById('facePersonSelect');
const faceNewPersonName = document.getElementById('faceNewPersonName');
const faceAssignBtn = document.getElementById('faceAssignBtn');
const faceRejectBtn = document.getElementById('faceRejectBtn');
const faceAssignmentStatus = document.getElementById('faceAssignmentStatus');
const progressUpdated = document.getElementById('progressUpdated');
const technicalProgressLabel = document.getElementById('technicalProgressLabel');
const technicalProgressDetail = document.getElementById('technicalProgressDetail');
const technicalProgressBar = document.getElementById('technicalProgressBar');
const visualProgressLabel = document.getElementById('visualProgressLabel');
const visualProgressDetail = document.getElementById('visualProgressDetail');
const visualProgressBar = document.getElementById('visualProgressBar');
const faceProgressBar = document.getElementById('faceProgressBar');
const faceProgressLabel = document.getElementById('faceProgressLabel');
const faceProgressDetail = document.getElementById('faceProgressDetail');
const scanProgressStatus = document.getElementById('scanProgressStatus');
const effectiveConfiguration = document.getElementById('effectiveConfiguration');
const automationControlBtn = document.getElementById('automationControlBtn');
const automationControlStatus = document.getElementById('automationControlStatus');
const manualRetryHistoryDetails = document.getElementById('visualRetryHistoryDetails');
const manualRetryHistory = document.getElementById('visualRetryHistory');
let selectedVideoPath = null;
let selectedMetadataId = null;
let selectedMetadataRevision = null;
let playbackRequestId = 0;
let selectedPersonId = null;
let editToken = null;
let knownPeople = [];
let knownPersonMerges = [];
let canEditPeopleDirectory = false;
let faceInboxItems = [];
let faceInboxCursor = 0;
let faceInboxTotal = 0;
let faceInboxMode = 'pending';
let selectedFaceForReview = null;
let selectedFaceIds = new Set();
let searchTimer;
let searchRequestId = 0;
let treeRequestId = 0;
let accessRenewalPromise = null;
let accessSessionRequired = false;
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
    accessSessionRequired = Boolean(status.required);
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

async function apiFetch(url, options = {}) {
  const requestOptions = { credentials: 'same-origin', ...options };
  const response = await fetch(url, requestOptions);
  if (response.status !== 401) return response;

  const result = await response.clone().json().catch(() => ({}));
  if (result.error !== 'Authentication required') return response;
  if (!accessRenewalPromise) {
    accessRenewalPromise = establishAccessSession().finally(() => { accessRenewalPromise = null; });
  }
  if (!await accessRenewalPromise) return response;
  return fetch(url, requestOptions);
}

let progressRequestInFlight = false;

async function loadProcessProgress() {
  if (progressRequestInFlight) return;
  progressRequestInFlight = true;
  try {
    const response = await apiFetch(`${API_BASE}/api/index/status`);
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
  const monthlyBudget = status.visual_monthly_budget || {};
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
  const faceProgress = status.face_progress || { total: 0, indexed: 0, remaining: 0, failed: 0, faces: {} };
  setProgress(faceProgressBar, faceProgressLabel, faceProgress.indexed, faceProgress.total);
  const faceRetryEnabled = status.worker_configuration?.['face-embedding-indexer']?.retry_failed;
  const faceFailures = count(faceProgress.failed)
    ? ` · ${format(faceProgress.failed)} con error${faceRetryEnabled ? ' · reintentos habilitados' : ' · reintentos desactivados'}`
    : '';
  faceProgressDetail.textContent = `${format(faceProgress.remaining)} videos pendientes${faceFailures} · ${format(faceProgress.faces?.unassigned)} rostros por revisar · ${format(faceProgress.faces?.automatic)} asignados automáticamente · ${format(faceProgress.faces?.ignored)} ignorados · ${faceProgress.model || 'modelo local no configurado'}`;
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
    Number(monthlyBudget.limit_usd) > 0 ? `Costo reportado este mes: USD ${Number(monthlyBudget.spent_usd || 0).toFixed(4)} / ${Number(monthlyBudget.limit_usd).toFixed(2)} · reserva por solicitud: USD ${Number(monthlyBudget.reserve_per_request_usd || 0).toFixed(4)}${Number(monthlyBudget.remaining_usd) < Number(monthlyBudget.reserve_per_request_usd) || Number(monthlyBudget.remaining_usd) <= 0 ? ' · sin reserva disponible' : ''}` : '',
    count(technical.pending) ? `${format(technical.pending)} esperando inventario técnico` : ''
  ].filter(Boolean).join(' · ');

  const configured = status.worker_configuration || {};
  const activity = status.worker_activity || {};
  const visualWorker = activity['visual-analyzer'];
  const faceWorker = activity['face-embedding-indexer'];
  if (faceWorker?.active) {
    const current = faceWorker.current_path ? ` · ${faceWorker.current_path}` : '';
    const phase = faceWorker.phase ? ` (${faceWorker.phase})` : '';
    faceProgressDetail.textContent += ` · Procesando localmente${current}${phase}`;
  } else if (faceWorker?.stale) {
    faceProgressDetail.textContent += ' · El último proceso se interrumpió; el próximo lote retomará los videos pendientes.';
  }
  const faceTimer = status.face_timer || {};
  if (faceTimer.load_state === 'not-found') {
    faceProgressDetail.textContent += ' · Timer del indexador facial no instalado';
  } else if (faceTimer.active) {
    faceProgressDetail.textContent += faceTimer.next_run ? ` · Próximo lote ${faceTimer.next_run}` : ' · Timer activo';
  } else if (faceTimer.available) {
    faceProgressDetail.textContent += faceTimer.enabled
      ? ' · Timer habilitado, esperando próximo disparo' : ' · Timer instalado pero deshabilitado';
  }
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
  const pipelineTimer = status.pipeline_timer || {};
  if (pipelineTimer.active) {
    const next = pipelineTimer.next_run ? ` · próximo ${pipelineTimer.next_run}` : '';
    visualProgressDetail.textContent += ` · Pipeline técnico + visual automático activo${next}`;
  } else if (pipelineTimer.enabled) {
    const next = pipelineTimer.next_run ? ` · próximo ${pipelineTimer.next_run}` : '';
    visualProgressDetail.textContent += ` · Pipeline automático habilitado${next}`;
  }
  const control = status.automation_control || {};
  automationControlBtn.classList.toggle('hidden', !status.can_control_automation);
  automationControlBtn.dataset.paused = String(Boolean(control.paused));
  automationControlBtn.textContent = control.paused ? 'Reanudar procesamiento' : 'Pausar procesamiento';
  automationControlStatus.textContent = control.paused
    ? `Procesamiento pausado desde ${control.changed_at || 'la interfaz'}. El trabajo técnico en curso termina; el analizador visual no toma otro video.`
    : 'Procesamiento habilitado.';
  if (control.changed_by && control.changed_by !== 'initialization') {
    automationControlStatus.textContent += ` Último cambio: ${control.changed_by}, ${control.changed_at}.`;
  }
  const manualRetries = [
    ...(status.visual_manual_retries || []).map(retry => ({ ...retry, stage: 'Visual' })),
    ...(status.technical_manual_retries || []).map(retry => ({ ...retry, stage: 'Técnico' }))
  ].sort((a, b) => b.requested_at.localeCompare(a.requested_at)).slice(0, 20);
  manualRetryHistoryDetails.classList.toggle('hidden', !manualRetries.length);
  manualRetryHistory.replaceChildren();
  for (const retry of manualRetries) {
    const entry = document.createElement('li');
    entry.textContent = `${retry.requested_at} UTC · ${retry.stage} · ${retry.relative_path}`;
    manualRetryHistory.appendChild(entry);
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
    const sampling = `, hasta ${format(effective.max_visual_frames || 4)} fotogramas según duración`;
    const timeout = `, espera máx. ${format((effective.visual_request_timeout_ms || 300000) / 1000)} s`;
    settings.push(`Visual: ${effective.model}, lote ${format(effective.max_visual)}, máximo ${format(effective.max_visual_attempts)} intentos${requestLimit}${sampling}${timeout}, reintentos ${effective.retry_failed ? 'activos' : 'desactivados'}${target}`);
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
  automationControlBtn.addEventListener('click', changeAutomationControl);
  // Refresh button
  refreshBtn.addEventListener('click', updateSearch);
  peopleDirectoryBtn.addEventListener('click', openPeopleDirectory);
  faceReviewBtn.addEventListener('click', openFaceReview);
  mobilePeopleDirectoryBtn.addEventListener('click', openPeopleDirectory);
  mobileFaceReviewBtn.addEventListener('click', openFaceReview);
  closePeopleDialog.addEventListener('click', () => peopleDialog.close());
  closeFaceReview.addEventListener('click', () => faceReviewDialog.close());
  faceLoadMore.addEventListener('click', () => loadFaceInbox(true));
  faceInboxPendingMode.addEventListener('click', () => setFaceInboxMode('pending'));
  faceInboxAutomaticMode.addEventListener('click', () => setFaceInboxMode('automatic'));
  faceAssignBtn.addEventListener('click', assignSelectedFaces);
  faceRejectBtn.addEventListener('click', rejectSelectedFace);
  facePersonSelect.addEventListener('change', () => { if (facePersonSelect.value) faceNewPersonName.value = ''; });
  faceNewPersonName.addEventListener('input', () => { if (faceNewPersonName.value.trim()) facePersonSelect.value = ''; });
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
        treeRequestId++;
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
    if (e.key === 'Escape') {
      if (!peopleDialog.open) closeMobileSidebar();
      return;
    }
    if (e.key !== 'Tab' || sidebarOverlay.classList.contains('hidden') || peopleDialog.open) return;
    const focusable = [...mobileSidebar.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(element => element.getClientRects().length > 0);
    if (!focusable.length) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !mobileSidebar.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !mobileSidebar.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  });
}

async function changeAutomationControl() {
  const token = tokenForEditing();
  if (token === null) return;
  automationControlBtn.disabled = true;
  automationControlStatus.textContent = 'Actualizando el control…';
  try {
    const paused = automationControlBtn.dataset.paused !== 'true';
    const response = await apiFetch(`${API_BASE}/api/index/control`, {
      method: 'POST',
      headers: editingHeaders(token),
      body: JSON.stringify({ paused })
    });
    if (response.status === 401) editToken = null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    await loadProcessProgress();
  } catch (error) {
    automationControlStatus.textContent = `No se pudo cambiar el estado: ${error.message}`;
  } finally {
    automationControlBtn.disabled = false;
  }
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
  if (offset === 0) treeRequestId++;
  try {
    const params = new URLSearchParams({ q: query, offset: String(offset), limit: String(SEARCH_PAGE_SIZE) });
    if (searchFrom.value) params.set('from', searchFrom.value);
    if (searchTo.value) params.set('to', searchTo.value);
    if (selectedPersonId) params.set('person_id', String(selectedPersonId));
    if (folder) params.set('folder', folder);
    const response = await apiFetch(`${API_BASE}/api/search?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (requestId !== searchRequestId) return;
    renderSearchResults(data.items, folderTree, query, offset, requestId, folder, data.has_more);
    renderSearchResults(data.items, mobileFolderTree, query, offset, requestId, folder, data.has_more);
    const loaded = offset + data.items.length;
    searchStatus.textContent = loaded === 0
      ? 'No se encontraron videos.'
      : `${loaded} ${loaded === 1 ? 'video cargado' : 'videos cargados'}${data.has_more ? '. Hay más resultados disponibles.' : '.'}`;
    breadcrumbs.classList.add('hidden');
  } catch (error) {
    if (requestId === searchRequestId) {
      if (offset === 0) {
        folderTree.textContent = `Error al buscar: ${error.message}`;
        mobileFolderTree.textContent = `Error al buscar: ${error.message}`;
      } else {
        document.querySelectorAll('.search-more button').forEach(button => {
          button.dataset.loading = 'false';
          button.setAttribute('aria-disabled', 'false');
          button.textContent = 'Reintentar carga de resultados';
        });
      }
      searchStatus.textContent = `No se pudo completar la búsqueda: ${error.message}`;
    }
  }
}

function renderSearchResults(items, container, query, offset, requestId, folder, hasMore) {
  const restoreFocus = offset > 0 && container.contains(document.activeElement);
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
    const visualScore = Number.isFinite(item.visual_score) ? ` · similitud ${item.visual_score.toFixed(3)}` : '';
    detail.textContent = `${item.recorded_at || 'Sin fecha'} · ${item.relative_path}${matchTime}${visualScore}${item.snippet ? ` · Coincidencia: ${item.snippet}` : item.visual_summary ? ` · ${item.visual_summary}` : ''}`;
    button.append(name, detail);
    button.addEventListener('click', () => playVideo(item.relative_path, name.textContent, item.match_at_seconds));
    li.appendChild(button);
    list.appendChild(li);
  }
  if (hasMore) {
    const more = document.createElement('li');
    more.className = 'search-more';
    const button = document.createElement('button');
    button.className = 'w-full px-3 py-2 text-left text-sm text-blue-300 hover:text-white';
    button.textContent = 'Ver más resultados';
    button.addEventListener('click', () => {
      if (button.dataset.loading === 'true') return;
      button.dataset.loading = 'true';
      button.setAttribute('aria-disabled', 'true');
      button.textContent = 'Cargando más resultados…';
      searchVideos(query, offset + items.length, requestId, folder);
    });
    more.appendChild(button);
    list.appendChild(more);
    if (restoreFocus) button.focus();
  } else if (restoreFocus) {
    (list.children[offset]?.querySelector('button') || list.querySelector('li:not(.search-more) button'))?.focus();
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
    emptyState.querySelector('.empty-state-hint')?.classList.add('hidden');
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
  clearTimeout(searchTimer);
  searchRequestId++;
  const requestId = ++treeRequestId;
  searchStatus.textContent = '';
  currentPath = path;
  setSearchFolderPath(path);
  currentPathDisplay.textContent = path === '' ? '/' : `/${path}`;
  
  folderTree.innerHTML = '<div class="text-center text-gray-500 py-8">Cargando...</div>';
  mobileFolderTree.innerHTML = '<div class="text-center text-gray-500 py-8">Cargando...</div>';
  
  try {
    const response = await apiFetch(`${API_BASE}/api/list?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (requestId !== treeRequestId || path !== currentPath) return;
    
    renderTree(data.items, folderTree);
    renderTree(data.items, mobileFolderTree);
    renderBreadcrumbs(path);
    breadcrumbs.classList.remove('hidden');
  } catch (err) {
    if (requestId !== treeRequestId || path !== currentPath) return;
    console.error('Failed to load tree:', err);
    folderTree.textContent = `Error: ${err.message}`;
    mobileFolderTree.textContent = `Error: ${err.message}`;
    searchStatus.textContent = `No se pudo cargar la biblioteca: ${err.message}`;
  }
}

function renderTree(items, container) {
  if (items.length === 0) {
    container.innerHTML = '<div class="text-center text-gray-500 py-8">Carpeta vacía</div>';
    return;
  }
  
  const ul = document.createElement('ul');
  ul.className = 'space-y-1';
  
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
      button.subfolderRequestId = (button.subfolderRequestId || 0) + 1;
      if (expanded) parentLi.querySelector('ul.subfolder')?.remove();
      else loadSubfolder(item.path, parentLi, button, button.subfolderRequestId);
    });
  } else {
    button.innerHTML = '<svg class="w-5 h-5 text-green-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg><span class="truncate"></span>';
    button.querySelector('span').textContent = item.name;
    button.addEventListener('click', () => playVideo(item.path, item.name));
  }
  return button;
}

async function loadSubfolder(folderPath, parentLi, folderButton, requestId) {
  try {
    const response = await apiFetch(`${API_BASE}/api/list?path=${encodeURIComponent(folderPath)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!parentLi.isConnected || folderButton.getAttribute('aria-expanded') !== 'true' ||
        folderButton.subfolderRequestId !== requestId) return;
    
    const subUl = document.createElement('ul');
    subUl.className = 'subfolder ml-4 mt-1 space-y-1 border-l border-gray-700 pl-3';
    if (data.items.length > 0) {
      data.items.forEach(item => {
        const li = document.createElement('li');
        li.appendChild(createTreeButton(item, li));
        subUl.appendChild(li);
      });
    } else {
      const li = document.createElement('li');
      li.className = 'px-3 py-2 text-sm text-gray-400';
      li.textContent = 'Carpeta vacía';
      subUl.appendChild(li);
    }
    parentLi.appendChild(subUl);
  } catch (err) {
    if (folderButton.subfolderRequestId === requestId && folderButton.getAttribute('aria-expanded') === 'true') {
      console.error('Failed to load subfolder:', err);
      const subUl = document.createElement('ul');
      subUl.className = 'subfolder ml-4 mt-1 space-y-1 border-l border-gray-700 pl-3';
      const li = document.createElement('li');
      li.className = 'flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-amber-200';
      const message = document.createElement('span');
      message.textContent = 'No se pudo cargar esta carpeta.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-700';
      retry.textContent = 'Reintentar';
      retry.addEventListener('click', () => {
        const retryRequestId = ++folderButton.subfolderRequestId;
        subUl.remove();
        loadSubfolder(folderPath, parentLi, folderButton, retryRequestId);
      });
      li.append(message, retry);
      subUl.appendChild(li);
      parentLi.appendChild(subUl);
    }
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
  selectedMetadataRevision = null;
  selectedMetadataId = null;
  metadataStatus.textContent = 'Cargando ficha...';
  metadataDuration.textContent = '';
  metadataResolution.textContent = '';
  metadataCodec.textContent = '';
  metadataDate.textContent = '';
  metadataDateEvidence.textContent = '';
  metadataLocation.textContent = '';
  metadataMapLink.removeAttribute('href');
  metadataMapLink.textContent = '';
  metadataMapLink.classList.add('hidden');
  metadataCaptureDevice.textContent = '';
  exportMetadataBtn.classList.add('hidden');
  exportMetadataBtn.disabled = false;
  exportMetadataBtn.onclick = null;
  importMetadataBtn.classList.add('hidden');
  importMetadataBtn.disabled = false;
  importMetadataBtn.onclick = null;
  metadataExportStatus.textContent = '';
  faceIdentityPanel.classList.add('hidden');
  faceIdentityResults.replaceChildren();
  visualPeople.replaceChildren();
  identityHelp.textContent = '';
  visualMetadata.classList.add('hidden');
  try {
    const [response, peopleResponse] = await Promise.all([
      apiFetch(`${API_BASE}/api/metadata?path=${encodeURIComponent(relativePath)}`),
      apiFetch(`${API_BASE}/api/people`)
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
    selectedMetadataRevision = item.visual_revision || null;
    selectedMetadataId = item.id;
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
    const location = item.technical?.location;
    if (location) {
      const coords = location.coordinates;
      const formattedCoords = coords
        ? `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}${coords.altitude_m == null ? '' : ` · ${coords.altitude_m} m`}`
        : '';
      const rawIsCoordinates = /^\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*$/.test(location.raw || '') || /^\s*[+-]\d{2,6}(?:\.\d+)?[+-]\d{3,7}(?:\.\d+)?/.test(location.raw || '');
      const value = formattedCoords && location.raw && !rawIsCoordinates
        ? `${location.raw} · ${formattedCoords}`
        : formattedCoords || location.raw;
      metadataLocation.textContent = `${value}${location.source ? ` (${location.source})` : ''}`;
      if (Number.isFinite(coords?.latitude) && Math.abs(coords.latitude) <= 90 &&
          Number.isFinite(coords?.longitude) && Math.abs(coords.longitude) <= 180) {
        const latitude = coords.latitude;
        const longitude = coords.longitude;
        metadataMapLink.href = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
        metadataMapLink.textContent = 'Abrir mapa';
        metadataMapLink.setAttribute('aria-label', 'Abrir estas coordenadas en OpenStreetMap; el sitio recibirá las coordenadas');
        metadataMapLink.classList.remove('hidden');
      }
    } else {
      metadataLocation.textContent = 'Sin ubicación en los metadatos del archivo';
    }
    const captureDevice = item.technical?.capture_device;
    const captureDeviceText = [captureDevice?.manufacturer, captureDevice?.model]
      .filter(entry => entry?.value)
      .map(entry => `${entry.value}${entry.source ? ` (${entry.source})` : ''}`)
      .join(' · ');
    metadataCaptureDevice.textContent = captureDeviceText || 'Sin tag de cámara/dispositivo';
    const sources = (item.date_candidates || []).map(candidate => `${candidate.date} (${candidate.source})`);
    metadataDateEvidence.textContent = sources.length ? `Fechas encontradas: ${sources.join(' · ')}` : 'No se encontraron fechas en el archivo o su nombre.';
    renderVisualMetadata(item);
    if (item.status === 'done' && item.visual_status === 'done' && item.visual_fingerprint === item.fingerprint && item.can_edit_people) {
      exportMetadataBtn.classList.remove('hidden');
      exportMetadataBtn.onclick = async () => {
        const sidecarPath = `${item.relative_path}.metadata.json`;
        if (!window.confirm(`Se creará ${sidecarPath} en la misma carpeta del video. Si ese sidecar ya existe, no se sobrescribirá. ¿Continuar?`)) return;
        exportMetadataBtn.disabled = true;
        metadataExportStatus.textContent = 'Exportando ficha…';
        try {
          const token = tokenForEditing();
          if (token === null) throw new Error('Se canceló la autenticación');
          const exportResponse = await apiFetch(`${API_BASE}/api/metadata/export`, {
            method: 'POST',
            headers: editingHeaders(token),
            body: JSON.stringify({ path: item.relative_path })
          });
          if (exportResponse.status === 401) editToken = null;
          const result = await exportResponse.json().catch(() => ({}));
          if (!exportResponse.ok) throw new Error(result.error || `HTTP ${exportResponse.status}`);
          if (selectedVideoPath === item.relative_path) {
            metadataExportStatus.textContent = `Sidecar creado: ${result.sidecar_path}`;
          }
        } catch (error) {
          if (selectedVideoPath === item.relative_path) {
            metadataExportStatus.textContent = `No se pudo exportar: ${error.message}`;
          }
        } finally {
          exportMetadataBtn.disabled = false;
        }
      };
    }
    if (item.status === 'done' && !item.visual_revision && item.can_edit_people) {
      importMetadataBtn.classList.remove('hidden');
      importMetadataBtn.onclick = async () => {
        if (!window.confirm('Se intentará importar la ficha del archivo .metadata.json junto al video. Solo se acepta si el fingerprint coincide y no existe una ficha visual previa. ¿Continuar?')) return;
        importMetadataBtn.disabled = true;
        metadataExportStatus.textContent = 'Validando e importando sidecar…';
        try {
          const token = tokenForEditing();
          if (token === null) throw new Error('Se canceló la autenticación');
          const importResponse = await apiFetch(`${API_BASE}/api/metadata/import`, {
            method: 'POST',
            headers: editingHeaders(token),
            body: JSON.stringify({ path: item.relative_path })
          });
          if (importResponse.status === 401) editToken = null;
          const result = await importResponse.json().catch(() => ({}));
          if (!importResponse.ok) throw new Error(result.error || `HTTP ${importResponse.status}`);
          await loadMetadata(item.relative_path);
          if (selectedVideoPath === item.relative_path) {
            const messages = ['Ficha importada; revisá las identidades narrativas restauradas.'];
            if (result.location_restored) messages.push('Se restauró la ubicación del sidecar.');
            if (result.capture_device_restored) messages.push('Se restauró el fabricante/modelo del sidecar.');
            if (result.face_identity_summary_not_restored) {
              messages.push(`${result.face_identity_summary_not_restored} resúmenes faciales no se reasignaron; requieren indexación y revisión local.`);
            }
            metadataExportStatus.textContent = messages.join(' ');
          }
        } catch (error) {
          if (selectedVideoPath === item.relative_path) {
            metadataExportStatus.textContent = `No se pudo importar: ${error.message}`;
          }
        } finally {
          importMetadataBtn.disabled = false;
        }
      };
    }
    if (item.status === 'failed' && item.can_edit_people) {
      if (metadataStatus.textContent) metadataStatus.append(' · ');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'rounded border border-gray-500 px-2 py-1 text-xs hover:bg-gray-700';
      retry.textContent = 'Reintentar análisis técnico';
      retry.addEventListener('click', async () => {
        const token = tokenForEditing();
        if (token === null) return;
        retry.disabled = true;
        try {
          const response = await apiFetch(`${API_BASE}/api/metadata/technical/retry`, {
            method: 'POST',
            headers: editingHeaders(token),
            body: JSON.stringify({ path: item.relative_path })
          });
          if (response.status === 401) editToken = null;
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
          if (selectedVideoPath === item.relative_path) {
            metadataStatus.textContent = 'Reintento técnico en cola; se ejecutará en el próximo inventario.';
          }
        } catch (error) {
          retry.disabled = false;
          window.alert(`No se pudo poner en cola el reintento técnico: ${error.message}`);
        }
      });
      metadataStatus.appendChild(retry);
    }
  } catch (error) {
    if (selectedVideoPath === relativePath) metadataStatus.textContent = `Error al cargar la ficha: ${error.message}`;
  }
}

function tokenForEditing() {
  if (accessSessionRequired) return '';
  if (!editToken) {
    editToken = window.prompt('Token de edición del servidor:');
    if (!editToken) return null;
  }
  return editToken;
}

function editingHeaders(token, includeContentType = true) {
  const headers = includeContentType ? { 'Content-Type': 'application/json' } : {};
  if (!accessSessionRequired) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function saveObservationIdentity(observationIndex, assignment) {
  const pathToEdit = selectedVideoPath;
  const expectedRevision = selectedMetadataRevision;
  if (!pathToEdit || !expectedRevision) return false;
  const token = tokenForEditing();
  if (token === null) return false;
  try {
    const response = await apiFetch(`${API_BASE}/api/metadata/person`, {
      method: 'PUT',
      headers: editingHeaders(token),
      body: JSON.stringify({ path: pathToEdit, analysis_revision: expectedRevision,
        observation_index: observationIndex, ...assignment })
    });
    if (response.status === 401) editToken = null;
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 409 && selectedVideoPath === pathToEdit) await loadMetadata(pathToEdit);
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    const result = await response.json();
    knownPeople = result.people || knownPeople;
    if (selectedVideoPath === pathToEdit) await loadMetadata(pathToEdit);
    return true;
  } catch (error) {
    window.alert(`No se pudo guardar la identificación: ${error.message}`);
    return false;
  }
}

function facePreviewUrl(faceId) {
  return `${API_BASE}/api/faces/${encodeURIComponent(faceId)}/preview`;
}

function faceCardTitle(face) {
  return face.visual_title || String(face.relative_path || '').split('/').filter(Boolean).at(-1) || 'Video';
}

function faceTimeLabel(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function renderFaceInbox() {
  faceInboxGrid.replaceChildren();
  for (const face of faceInboxItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `min-w-0 rounded-lg border p-2 text-left hover:bg-gray-700 ${
      selectedFaceForReview?.id === face.id ? 'border-amber-400 bg-amber-950/30' : 'border-gray-700 bg-gray-900/50'
    }`;
    button.setAttribute('aria-label', `Revisar rostro de ${faceCardTitle(face)} en ${faceTimeLabel(face.at_seconds)}`);
    const image = document.createElement('img');
    image.className = 'aspect-square w-full rounded bg-black object-contain';
    image.loading = 'lazy';
    image.alt = `Rostro en ${faceCardTitle(face)} en ${faceTimeLabel(face.at_seconds)}`;
    image.src = facePreviewUrl(face.id);
    image.addEventListener('error', () => { image.alt = 'Vista previa no disponible'; }, { once: true });
    const title = document.createElement('span');
    title.className = 'mt-2 block truncate text-xs font-medium text-gray-200';
    title.textContent = faceCardTitle(face);
    const time = document.createElement('span');
    time.className = 'block text-xs text-gray-400';
    time.textContent = faceInboxMode === 'automatic'
      ? `${face.person_name || 'Identidad sin nombre'} · ${Number(face.assignment_similarity).toFixed(3)} · minuto ${faceTimeLabel(face.at_seconds)}`
      : `Minuto ${faceTimeLabel(face.at_seconds)}`;
    button.append(image, title, time);
    button.addEventListener('click', () => selectFaceForReview(face));
    faceInboxGrid.appendChild(button);
  }
  const inboxLabel = faceInboxMode === 'automatic' ? 'asignaciones automáticas' : 'rostros sin nombre';
  faceInboxStatus.textContent = faceInboxItems.length
    ? `${faceInboxTotal.toLocaleString('es-AR')} ${inboxLabel} · mostrando ${faceInboxItems.length}`
    : faceInboxMode === 'automatic' ? 'Todavía no hay asignaciones automáticas para revisar.'
      : 'No hay rostros pendientes en los videos ya procesados.';
  faceLoadMore.classList.toggle('hidden', !faceInboxCursor || faceInboxItems.length >= faceInboxTotal);
}

async function setFaceInboxMode(mode) {
  faceInboxMode = mode === 'automatic' ? 'automatic' : 'pending';
  faceInboxPendingMode.setAttribute('aria-pressed', String(faceInboxMode === 'pending'));
  faceInboxAutomaticMode.setAttribute('aria-pressed', String(faceInboxMode === 'automatic'));
  faceInboxPendingMode.className = `rounded border px-3 py-1 text-xs ${faceInboxMode === 'pending' ? 'border-amber-500' : 'border-gray-600'}`;
  faceInboxAutomaticMode.className = `rounded border px-3 py-1 text-xs ${faceInboxMode === 'automatic' ? 'border-amber-500' : 'border-gray-600'}`;
  selectedFaceForReview = null;
  selectedFaceIds = new Set();
  faceRejectBtn.classList.toggle('hidden', faceInboxMode === 'automatic');
  faceRejectBtn.disabled = true;
  faceNeighborGrid.replaceChildren();
  faceSelectedStatus.textContent = 'Elegí un rostro para revisar sus coincidencias.';
  await loadFaceInbox(false);
}

async function loadFaceInbox(append = false) {
  if (!append) {
    faceInboxItems = [];
    faceInboxCursor = 0;
    faceInboxGrid.replaceChildren();
    faceInboxStatus.textContent = 'Cargando rostros…';
  }
  const params = new URLSearchParams({ limit: '18' });
  if (append && faceInboxCursor) params.set('after', String(faceInboxCursor));
  try {
    const endpoint = faceInboxMode === 'automatic' ? 'automatic' : 'inbox';
    const response = await apiFetch(`${API_BASE}/api/faces/${endpoint}?${params}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    faceInboxItems.push(...(result.items || []));
    faceInboxCursor = result.next_after_id || 0;
    faceInboxTotal = result.total || 0;
    if (faceInboxMode === 'pending' && !append && result.progress?.remaining && !faceInboxTotal) {
      faceInboxStatus.textContent = `${result.progress.remaining.toLocaleString('es-AR')} videos pendientes de procesar localmente; todavía no hay rostros para revisar.`;
      faceLoadMore.classList.add('hidden');
      return;
    }
    renderFaceInbox();
  } catch (error) {
    faceInboxStatus.textContent = `No se pudo cargar la bandeja de rostros (${error.message}).`;
  }
}

function addFaceNeighborCard(face, { selected = false, disabled = false, description = '' } = {}) {
  const card = document.createElement('label');
  card.className = 'min-w-0 rounded border border-gray-700 bg-gray-800 p-2';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected;
  checkbox.disabled = disabled;
  checkbox.className = 'mb-2 mr-1 accent-amber-400';
  checkbox.setAttribute('aria-label', `Seleccionar ${faceCardTitle(face)} en ${faceTimeLabel(face.at_seconds)} para asignar o ignorar`);
  if (!disabled) checkbox.addEventListener('change', () => {
    if (checkbox.checked) selectedFaceIds.add(face.id);
    else selectedFaceIds.delete(face.id);
    const count = selectedFaceIds.size;
    faceAssignBtn.textContent = `Asignar identidad a ${count} ${count === 1 ? 'rostro' : 'rostros'}`;
    faceRejectBtn.textContent = `Ignorar ${count} ${count === 1 ? 'rostro' : 'rostros'} sin identificar`;
    faceRejectBtn.disabled = count === 0;
  });
  const image = document.createElement('img');
  image.className = 'aspect-square w-full rounded bg-black object-contain';
  image.loading = 'lazy';
  image.alt = `Rostro de ${faceCardTitle(face)} en ${faceTimeLabel(face.at_seconds)}`;
  image.src = facePreviewUrl(face.id);
  const title = document.createElement('span');
  title.className = 'mt-1 block truncate text-xs font-medium';
  title.textContent = faceCardTitle(face);
  const meta = document.createElement('span');
  meta.className = 'block text-xs text-gray-400';
  meta.textContent = description || `Minuto ${faceTimeLabel(face.at_seconds)}`;
  card.append(checkbox, image, title, meta);
  faceNeighborGrid.appendChild(card);
}

async function selectFaceForReview(face) {
  selectedFaceForReview = face;
  selectedFaceIds = new Set([face.id]);
  faceNewPersonName.value = '';
  faceAssignmentStatus.textContent = '';
  faceAssignBtn.textContent = 'Asignar identidad a 1 rostro';
  faceRejectBtn.textContent = 'Ignorar 1 rostro sin identificar';
  faceRejectBtn.disabled = false;
  faceRejectBtn.classList.toggle('hidden', faceInboxMode === 'automatic');
  faceAssignmentControls.classList.toggle('hidden', !canEditPeopleDirectory);
  facePersonSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = face.assignment_source === 'automatic' ? 'Elegir identidad para confirmar o corregir' : 'Elegir identidad';
  facePersonSelect.appendChild(placeholder);
  for (const person of knownPeople) {
    const option = document.createElement('option');
    option.value = String(person.id);
    option.textContent = person.name;
    facePersonSelect.appendChild(option);
  }
  faceSelectedStatus.textContent = face.assignment_source === 'automatic'
    ? `${faceCardTitle(face)} · minuto ${faceTimeLabel(face.at_seconds)} · asignada a ${face.person_name} con similitud ${Number(face.assignment_similarity).toFixed(3)}; elegí una identidad para confirmar o corregir.`
    : `${faceCardTitle(face)} · minuto ${faceTimeLabel(face.at_seconds)} · detección ${Math.round(face.detection_score * 100)}%`;
  faceNeighborGrid.replaceChildren();
  addFaceNeighborCard(face, { selected: true, disabled: true, description: 'Rostro elegido' });
  renderFaceInbox();
  try {
    const response = await apiFetch(`${API_BASE}/api/faces/${face.id}/neighbors?limit=12`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const neighbors = result.items || [];
    const suggestions = result.identity_suggestions || [];
    const suggestionHeading = document.createElement('p');
    suggestionHeading.className = 'col-span-full text-xs font-semibold text-amber-200';
    suggestionHeading.textContent = suggestions.length
      ? `Recomendaciones manuales (${Number(result.suggestion_threshold).toFixed(2)} a < ${Number(result.auto_assignment_threshold).toFixed(2)}). Elegir una solo completa el selector; hay que confirmar la asignación.`
      : `No hay recomendaciones manuales entre ${Number(result.suggestion_threshold).toFixed(2)} y ${Number(result.auto_assignment_threshold).toFixed(2)}. La similitud es orientativa; revisá los vecinos antes de asignar.`;
    faceNeighborGrid.appendChild(suggestionHeading);
    for (const suggestion of suggestions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'col-span-full rounded border border-amber-700 bg-amber-950/40 px-3 py-2 text-left text-sm hover:bg-amber-900/60';
      button.textContent = `${suggestion.person_name} · similitud ${suggestion.similarity.toFixed(3)} · usar como sugerencia`;
      button.addEventListener('click', () => {
        facePersonSelect.value = String(suggestion.person_id);
        faceSelectedStatus.textContent = `${faceCardTitle(face)} · minuto ${faceTimeLabel(face.at_seconds)} · sugerencia ${suggestion.person_name} (${suggestion.similarity.toFixed(3)}); confirmar con «Asignar identidad».`;
      });
      faceNeighborGrid.appendChild(button);
    }
    faceSelectedStatus.textContent += suggestions.length
      ? ` · ${suggestions.length} sugerencia(s) requieren confirmación`
      : ' · sin sugerencias por encima del umbral; asignación manual disponible';
    for (const neighbor of neighbors) {
      const description = `${neighbor.similarity.toFixed(3)}${neighbor.person_name ? ` · ${neighbor.person_name}` : ''}${neighbor.review_status === 'unassigned' ? ' · sin nombre' : ''}`;
      addFaceNeighborCard(neighbor, { description });
    }
    if (!neighbors.length) {
      const empty = document.createElement('p');
      empty.className = 'col-span-full text-xs text-gray-500';
      empty.textContent = 'Todavía no hay otros embeddings faciales para comparar.';
      faceNeighborGrid.appendChild(empty);
    }
  } catch (error) {
    faceAssignmentStatus.textContent = `No se pudieron buscar parecidos (${error.message}).`;
  }
}

async function openFaceReview() {
  try {
    const peopleResponse = await apiFetch(`${API_BASE}/api/people`);
    if (!peopleResponse.ok) throw new Error(`HTTP ${peopleResponse.status}`);
    const peopleData = await peopleResponse.json();
    knownPeople = peopleData.items || [];
    canEditPeopleDirectory = Boolean(peopleData.can_edit_people);
    faceReviewDialog.showModal();
    await loadFaceInbox(false);
  } catch (error) {
    window.alert(`No se pudo abrir la revisión de rostros: ${error.message}`);
  }
}

async function assignSelectedFaces() {
  if (!selectedFaceIds.size) return;
  const token = tokenForEditing();
  if (token === null) return;
  const personName = faceNewPersonName.value.trim();
  const personId = facePersonSelect.value ? Number(facePersonSelect.value) : null;
  if (!personName && !personId) {
    faceAssignmentStatus.textContent = 'Elegí una persona o escribí un nombre nuevo.';
    return;
  }
  faceAssignBtn.disabled = true;
  faceAssignmentStatus.textContent = 'Guardando identidad…';
  try {
    const response = await apiFetch(`${API_BASE}/api/faces/assign`, {
      method: 'POST', headers: editingHeaders(token),
      body: JSON.stringify({ face_ids: [...selectedFaceIds], ...(personName ? { person_name: personName } : { person_id: personId }) })
    });
    if (response.status === 401) editToken = null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    knownPeople = result.items || knownPeople;
    const previousVideo = selectedVideoPath;
    faceAssignmentStatus.textContent = `Identidad asignada a ${result.assigned} rostros.`;
    selectedFaceForReview = null;
    selectedFaceIds = new Set();
    faceRejectBtn.disabled = true;
    faceRejectBtn.textContent = 'Ignorar rostros seleccionados';
    await loadFaceInbox(false);
    if (previousVideo && (result.video_ids || []).some(id => Number(id) === Number(selectedMetadataId))) {
      await loadMetadata(previousVideo);
    }
  } catch (error) {
    faceAssignmentStatus.textContent = `No se pudo asignar la identidad: ${error.message}`;
  } finally {
    faceAssignBtn.disabled = false;
  }
}

async function rejectSelectedFace() {
  if (!selectedFaceForReview || !selectedFaceIds.size) return;
  const selectedCount = selectedFaceIds.size;
  if (!window.confirm(`Se eliminarán los embeddings de las detecciones seleccionadas que aún no tengan una identidad confirmada. Las identidades confirmadas se conservarán. Si se vuelve a indexar este video con la misma versión del índice facial, las detecciones ignoradas seguirán excluidas mientras el video no cambie. ¿Continuar?`)) return;
  const token = tokenForEditing();
  if (token === null) return;
  faceRejectBtn.disabled = true;
  try {
    const response = await apiFetch(`${API_BASE}/api/faces/reject`, {
      method: 'POST', headers: editingHeaders(token),
      body: JSON.stringify({ face_ids: [...selectedFaceIds] })
    });
    if (response.status === 401) editToken = null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    selectedFaceForReview = null;
    selectedFaceIds = new Set();
    faceNeighborGrid.replaceChildren();
    faceSelectedStatus.textContent = `${result.rejected || 0} rostro(s) ignorado(s); sus embeddings se eliminaron y no volverán a aparecer al reindexar este video con la misma versión del índice.`;
    await loadFaceInbox(false);
  } catch (error) {
    faceAssignmentStatus.textContent = `No se pudo ignorar el rostro: ${error.message}`;
  } finally {
    faceRejectBtn.disabled = selectedFaceIds.size === 0;
  }
}

async function openPeopleDirectory() {
  try {
    const response = await apiFetch(`${API_BASE}/api/people`);
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
    row.className = 'flex flex-wrap items-center gap-2 rounded-lg px-2 py-2 hover:bg-gray-700';
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
        merge.setAttribute('aria-expanded', 'false');
        merge.setAttribute('aria-controls', `merge-panel-${person.id}`);
        merge.addEventListener('click', () => {
          const panel = row.querySelector('[data-merge-panel]');
          panel.classList.toggle('hidden');
          const expanded = !panel.classList.contains('hidden');
          merge.setAttribute('aria-expanded', String(expanded));
          if (expanded) panel.querySelector('select').focus();
        });
        row.appendChild(merge);
        const panel = document.createElement('div');
        panel.id = `merge-panel-${person.id}`;
        panel.dataset.mergePanel = 'true';
        panel.className = 'hidden flex w-full flex-wrap items-center gap-2 border-t border-gray-700 pt-2';
        const targetSelect = document.createElement('select');
        targetSelect.className = 'min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm';
        targetSelect.setAttribute('aria-label', `Persona destino para ${person.name}`);
        for (const target of knownPeople.filter(item => item.id !== person.id)) {
          const option = document.createElement('option');
          option.value = String(target.id);
          option.textContent = `${target.name} · ${target.videos} ${target.videos === 1 ? 'video' : 'videos'}`;
          targetSelect.appendChild(option);
        }
        const confirmMerge = document.createElement('button');
        confirmMerge.type = 'button';
        confirmMerge.className = 'rounded bg-amber-700 px-3 py-2 text-sm hover:bg-amber-600';
        confirmMerge.textContent = 'Continuar';
        confirmMerge.addEventListener('click', () => mergeDirectoryPerson(person, Number(targetSelect.value)));
        const cancelMerge = document.createElement('button');
        cancelMerge.type = 'button';
        cancelMerge.className = 'rounded border border-gray-600 px-3 py-2 text-sm hover:bg-gray-700';
        cancelMerge.textContent = 'Cancelar';
        cancelMerge.addEventListener('click', () => {
          panel.classList.add('hidden');
          merge.setAttribute('aria-expanded', 'false');
          merge.focus();
        });
        panel.append(targetSelect, confirmMerge, cancelMerge);
        row.appendChild(panel);
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
  if (token === null) return;
  try {
    const response = await apiFetch(`${API_BASE}/api/people/${person.id}`, {
      method: 'PATCH',
      headers: editingHeaders(token),
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

async function mergeDirectoryPerson(source, targetId) {
  const targets = knownPeople.filter(person => person.id !== source.id);
  const target = targets.find(person => person.id === targetId);
  if (!target) {
    window.alert('Ese ID no corresponde a otra persona del catálogo.');
    return;
  }
  if (!window.confirm(`Mover las asignaciones de “${source.name}” a “${target.name}”. Se guardará la fusión y se podrá deshacer desde este directorio. ¿Continuar?`)) return;
  const token = tokenForEditing();
  if (token === null) return;
  try {
    const response = await apiFetch(`${API_BASE}/api/people/${source.id}/merge`, {
      method: 'PATCH',
      headers: editingHeaders(token),
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
  if (token === null) return;
  try {
    const response = await apiFetch(`${API_BASE}/api/people/merges/${merge.id}/undo`, {
      method: 'POST',
      headers: editingHeaders(token, false)
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

function renderFaceIdentityResults(item) {
  const identities = item.identified_faces || [];
  faceIdentityResults.replaceChildren();
  faceIdentityPanel.classList.toggle('hidden', identities.length === 0);
  for (const identity of identities) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rounded-full border border-amber-700/70 bg-amber-900/40 px-3 py-1 text-xs text-amber-100 hover:bg-amber-800';
    button.textContent = `${identity.name} · ${identity.appearances} ${identity.appearances === 1 ? 'rostro' : 'rostros'}`;
    button.setAttribute('aria-label', `Buscar videos de ${identity.name}`);
    button.addEventListener('click', () => {
      selectedPersonId = identity.person_id;
      searchInput.value = identity.name;
      mobileSearchInput.value = identity.name;
      updateSearch();
    });
    faceIdentityResults.appendChild(button);
  }
}

function renderVisualMetadata(item) {
  renderFaceIdentityResults(item);
  if (item.visual_status !== 'done') {
    if (item.visual_status === 'failed') {
      metadataStatus.textContent = 'Análisis visual fallido. ';
      if (item.can_edit_people) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'rounded border border-gray-500 px-2 py-1 text-xs hover:bg-gray-700';
        retry.textContent = 'Poner en cola para reintentar';
        retry.addEventListener('click', async () => {
          const token = tokenForEditing();
          if (token === null) return;
          retry.disabled = true;
          try {
            const response = await apiFetch(`${API_BASE}/api/metadata/visual/retry`, {
              method: 'POST',
              headers: editingHeaders(token),
              body: JSON.stringify({ path: item.relative_path })
            });
            if (response.status === 401) editToken = null;
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            if (selectedVideoPath === item.relative_path) {
              metadataStatus.textContent = 'Reintento en cola; se ejecutará en el próximo lote visual.';
            }
          } catch (error) {
            retry.disabled = false;
            window.alert(`No se pudo poner en cola el reintento: ${error.message}`);
          }
        });
        metadataStatus.appendChild(retry);
      }
    }
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
      const identityNames = (previous.identities || [{ name: previous.name }]).map(person => person.name).join(', ');
      summary.textContent = `${identityNames}: ${description} (${time})`;
      entry.appendChild(summary);
      const previousEvidenceLabel = document.createElement('p');
      previousEvidenceLabel.className = 'mt-2 text-xs font-medium text-gray-300';
      previousEvidenceLabel.textContent = 'Fotograma de la ficha anterior';
      entry.appendChild(previousEvidenceLabel);
      appendStaleEvidenceThumbnail(entry, item, previous);
      if (previous.suggested_matches?.length) {
        const match = previous.suggested_matches[0];
        const suggestion = document.createElement('p');
        suggestion.className = 'mt-2 text-xs text-sky-200';
        const matchTime = `${Math.floor(match.at_seconds / 60)}:${String(Math.floor(match.at_seconds % 60)).padStart(2, '0')}`;
        suggestion.textContent = `Posible coincidencia orientativa (${match.score}/100, no es una probabilidad): ${match.description} (${matchTime}). Revisá la evidencia antes de confirmar.`;
        entry.appendChild(suggestion);
      }
      if (item.can_edit_people) {
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'mt-2 rounded border border-gray-600 px-3 py-2 text-xs text-gray-200 hover:bg-gray-700';
        dismiss.textContent = 'Resolver sin reasignar';
        dismiss.addEventListener('click', async () => {
          if (!window.confirm(`Marcar las identificaciones anteriores de ${identityNames} como revisadas sin asignarlas a una observación actual? Se conservarán en el historial.`)) return;
          const pathToReview = selectedVideoPath;
          const token = tokenForEditing();
          if (token === null) return;
          try {
            const response = await apiFetch(`${API_BASE}/api/metadata/person/review-stale`, {
              method: 'POST',
              headers: editingHeaders(token),
              body: JSON.stringify({ path: pathToReview,
                analysis_revision: previous.analysis_revision,
                observation_index: previous.observation_index })
            });
            if (response.status === 401) editToken = null;
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
            if (selectedVideoPath === pathToReview) await loadMetadata(pathToReview);
          } catch (error) {
            window.alert(`No se pudo resolver la identificación anterior: ${error.message}`);
          }
        });
        entry.appendChild(dismiss);
      }
      if (observations.length && item.can_edit_people) {
        const controls = document.createElement('div');
        controls.className = 'mt-2 flex flex-col gap-2';
        const identitySelect = document.createElement('select');
        identitySelect.multiple = true;
        identitySelect.size = Math.min(4, Math.max(2, knownPeople.length));
        identitySelect.className = 'w-full rounded border border-amber-800 bg-gray-900 px-2 py-2 text-sm text-white';
        identitySelect.setAttribute('aria-label', `Elegir identidades para la observación anterior: ${identityNames}`);
        for (const person of knownPeople) {
          const option = document.createElement('option');
          option.value = String(person.id);
          option.textContent = person.name;
          identitySelect.appendChild(option);
        }
        const oldIds = new Set(previous.person_ids.map(String));
        for (const option of identitySelect.options) option.selected = oldIds.has(option.value);
        const select = document.createElement('select');
        select.className = 'min-w-0 flex-1 rounded border border-amber-800 bg-gray-900 px-2 py-2 text-sm text-white';
        select.setAttribute('aria-label', `Elegir observación actual para vincular con ${identityNames}`);
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
        if (previous.suggested_matches?.length) {
          select.value = String(previous.suggested_matches[0].observation_index);
        }
        const currentEvidence = document.createElement('div');
        currentEvidence.className = 'rounded border border-gray-700 bg-gray-950/50 p-2';
        currentEvidence.setAttribute('aria-live', 'polite');
        const renderCurrentEvidence = () => {
          currentEvidence.replaceChildren();
          const label = document.createElement('p');
          label.className = 'mb-1 text-xs font-medium text-gray-300';
          label.textContent = 'Fotograma actual para comparar';
          currentEvidence.appendChild(label);
          const observation = select.value === '' ? null : observations[Number(select.value)];
          if (!observation || !item.visual_evidence?.some(evidence => evidence.at_seconds === observation.at_seconds)) {
            const unavailable = document.createElement('p');
            unavailable.className = 'text-xs text-gray-500';
            unavailable.textContent = observation ? 'No hay fotograma de evidencia para esta observación.' : 'Elegí una observación para ver su fotograma.';
            currentEvidence.appendChild(unavailable);
            return;
          }
          appendEvidenceThumbnail(currentEvidence, item, observation.at_seconds, observation.description);
        };
        renderCurrentEvidence();
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'rounded bg-amber-700 px-3 py-2 text-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50';
        apply.textContent = 'Reasignar';
        apply.disabled = true;
        const updateApplyState = () => { apply.disabled = select.value === '' || identitySelect.selectedOptions.length === 0; };
        select.addEventListener('change', () => {
          updateApplyState();
          renderCurrentEvidence();
        });
        identitySelect.addEventListener('change', updateApplyState);
        updateApplyState();
        apply.addEventListener('click', async () => {
          if (select.value === '') return;
          apply.disabled = true;
          const saved = await saveObservationIdentity(Number(select.value), {
            person_ids: [...identitySelect.selectedOptions].map(option => Number(option.value)),
            stale_observation: {
              analysis_revision: previous.analysis_revision,
              observation_index: previous.observation_index
            }
          });
          if (!saved) apply.disabled = false;
        });
        controls.append(identitySelect, select, currentEvidence, apply);
        entry.appendChild(controls);
      }
      list.appendChild(entry);
    });
    review.appendChild(list);
    visualPeople.appendChild(review);
  }
  const history = item.identity_history || [];
  if (history.length) {
    const details = document.createElement('details');
    details.className = 'rounded-lg border border-gray-700 bg-gray-900/40 p-3';
    const summary = document.createElement('summary');
    summary.className = 'cursor-pointer text-sm text-gray-300';
    summary.textContent = `Historial de identificaciones (${history.length}${history.length === 100 ? '+' : ''})`;
    details.appendChild(summary);
    const list = document.createElement('ol');
    list.className = 'mt-2 max-h-48 space-y-2 overflow-y-auto text-xs text-gray-400';
    for (const change of history) {
      const entry = document.createElement('li');
      const namesFromHistory = value => {
        try { return JSON.parse(value || '[]').map(person => person.name).filter(Boolean).join(', '); }
        catch { return ''; }
      };
      const previousNames = namesFromHistory(change.previous_people_json);
      const nextNames = namesFromHistory(change.people_json);
      const from = previousNames || (change.action === 'reconciled'
        ? `Ficha anterior: ${change.stale_person_name || 'Sin identificar'}; observación actual: ${change.previous_name || 'Sin identificar'}`
        : change.previous_name || 'Sin identificar');
      const to = nextNames || change.person_name || 'Sin identificar';
      const action = change.action === 'reconciled' ? 'Reconciliada'
        : change.action === 'assigned' ? 'Identificada'
        : change.action === 'removed' ? 'Quitada'
        : change.action === 'dismissed' ? 'Resuelta sin reasignar' : 'Cambiada';
      const date = new Date(`${change.changed_at.replace(' ', 'T')}Z`);
      const when = Number.isNaN(date.getTime()) ? change.changed_at : date.toLocaleString();
      entry.textContent = `${when} · ${action}: ${from} → ${to} (observación ${change.observation_index + 1})`;
      list.appendChild(entry);
    }
    details.appendChild(list);
    visualPeople.appendChild(details);
  }
  if (!observations.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No se detectaron personas en los fotogramas analizados.';
    visualPeople.appendChild(empty);
    return;
  }
  identityHelp.textContent = item.can_edit_people
    ? 'La identificación es manual: elegí una o varias personas para esta observación, luego guardá la selección. Usá Ctrl o ⌘ para seleccionar varias; se pueden buscar por separado.'
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
    const assignedAll = item.identified_people_all?.[index] || (assigned ? [assigned] : []);
    if (!item.can_edit_people) {
      if (assigned?.name) {
        const label = document.createElement('span');
        label.className = 'text-xs text-green-300';
        label.textContent = `Identificada: ${assignedAll.map(person => person.name).join(', ')}`;
        row.appendChild(label);
      }
    } else {
      const select = document.createElement('select');
      select.multiple = true;
      select.size = Math.min(5, Math.max(3, knownPeople.length));
      select.className = 'w-full rounded border border-gray-600 bg-gray-800 px-2 py-2 text-sm';
      select.setAttribute('aria-label', 'Asignar una o varias identidades a esta observación');
      for (const person of knownPeople) {
        const option = document.createElement('option');
        option.value = String(person.id);
        option.textContent = person.name;
        select.appendChild(option);
      }
      const assignedIds = new Set(assignedAll.map(person => String(person.id)));
      for (const option of select.options) option.selected = assignedIds.has(option.value);
      row.appendChild(select);
      const savePeople = document.createElement('button');
      savePeople.type = 'button';
      savePeople.className = 'rounded bg-blue-700 px-3 py-2 text-xs hover:bg-blue-600';
      savePeople.textContent = 'Guardar selección';
      savePeople.addEventListener('click', async () => {
        savePeople.disabled = true;
        const saved = await saveObservationIdentity(index, {
          person_ids: [...select.selectedOptions].map(option => Number(option.value))
        });
        if (!saved) savePeople.disabled = false;
      });
      row.appendChild(savePeople);
      const createPerson = document.createElement('button');
      createPerson.type = 'button';
      createPerson.className = 'rounded border border-gray-600 px-3 py-2 text-xs';
      createPerson.textContent = 'Crear persona y agregar';
      createPerson.addEventListener('click', async () => {
        const name = window.prompt('Nombre de esta persona:');
        if (!name?.trim()) return;
        await saveObservationIdentity(index, {
          person_ids: [...select.selectedOptions].map(option => Number(option.value)), person_name: name.trim()
        });
      });
      row.appendChild(createPerson);
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
  image.addEventListener('error', () => {
    button.replaceWith(Object.assign(document.createElement('span'), {
      className: 'text-xs text-gray-500', textContent: 'Fotograma de evidencia no disponible.'
    }));
  }, { once: true });
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

function appendStaleEvidenceThumbnail(container, item, previous) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mt-2 rounded border border-gray-700 focus:outline-none focus:ring-2 focus:ring-amber-400';
  button.setAttribute('aria-label', `Ampliar fotograma anterior de ${previous.name}`);
  const image = document.createElement('img');
  image.className = 'h-20 w-32 rounded bg-black object-contain';
  image.loading = 'lazy';
  image.alt = `Fotograma anterior en el segundo ${previous.at_seconds}: ${previous.description}`;
  const params = new URLSearchParams({ path: item.relative_path,
    revision: previous.analysis_revision, at_seconds: String(previous.at_seconds) });
  image.src = `${API_BASE}/api/metadata/evidence?${params}`;
  image.addEventListener('error', () => {
    button.replaceWith(Object.assign(document.createElement('span'), {
      className: 'mt-2 block text-xs text-gray-500', textContent: 'Fotograma anterior no disponible.'
    }));
  }, { once: true });
  button.appendChild(image);
  button.addEventListener('click', () => {
    const expanded = image.classList.toggle('max-h-80');
    image.classList.toggle('h-20', !expanded);
    image.classList.toggle('w-32', !expanded);
    image.classList.toggle('max-w-full', expanded);
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
  mobileSidebar.inert = false;
  mobileSidebar.setAttribute('aria-hidden', 'false');
  sidebarOverlay.classList.remove('hidden');
  mobileMenuBtn.setAttribute('aria-expanded', 'true');
  document.querySelector('.main-content').inert = true;
  document.body.style.overflow = 'hidden';
  mobileSearchInput.focus();
}

function closeMobileSidebar() {
  const wasOpen = !sidebarOverlay.classList.contains('hidden');
  mobileSidebar.classList.add('-translate-x-full');
  mobileSidebar.inert = true;
  mobileSidebar.setAttribute('aria-hidden', 'true');
  sidebarOverlay.classList.add('hidden');
  mobileMenuBtn.setAttribute('aria-expanded', 'false');
  document.querySelector('.main-content').inert = false;
  document.body.style.overflow = '';
  if (wasOpen) mobileMenuBtn.focus();
}
