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