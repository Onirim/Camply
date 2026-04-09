// ══════════════════════════════════════════════════════════════
// Camply — Module Carte v2
// Carte zoomable + pannable, marqueurs personnels + suivis.
// Partage via couche (map_layer), intégration campagnes.
// Dépend de : supabase-client.js, map-config.js, scripts.js
// ══════════════════════════════════════════════════════════════

// ── État ──────────────────────────────────────────────────────
let mapMarkers        = {};   // id → marker (own)
let mapFollowedLayers = {};   // layerId → { layer, markers: {} }
let mapOwnLayer       = null; // { id, title, description, is_public, share_code } | null
let mapFollowedIds    = [];   // [layerId, ...]
let mapLoaded         = false;

// Transformation courante
let mapTransform = { x: 0, y: 0, scale: 1 };

// État du drag (pan)
let mapDrag = { active: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false };

// Popup ouverte : { id, owned } | null
let mapOpenPopup = null;

// Modale marqueur : { mode: 'add'|'edit', x?, y?, id? } | null
let mapModalCtx   = null;
let mapModalColor = MAP_CONFIG.markerColors[0];

// ── Références DOM ─────────────────────────────────────────────
let _mapViewport = null;
let _mapCanvas   = null;
let _mapImage    = null;

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

async function initMap() {
  if (mapLoaded) return;
  _mapViewport = document.getElementById('map-viewport');
  _mapCanvas   = document.getElementById('map-canvas');
  _buildMapImage();
  _bindMapEvents();
  await Promise.all([
    loadMapMarkersFromDB(),
    loadOwnLayerFromDB(),
    loadFollowedLayersFromDB(),
  ]);
  _renderLayerPanel();
  mapLoaded = true;
}

function _buildMapImage() {
  const img = document.createElement('img');
  img.id = 'map-image'; img.className = 'map-image';
  img.alt = 'Carte'; img.draggable = false;
  img.onload = () => {
    _mapImage = img;
    _setInitialTransform();
    _renderAllMarkers();
    _updateZoomDisplay();
  };
  img.onerror = () => {
    const err = document.createElement('div');
    err.className = 'map-image-error';
    err.innerHTML = `<div class="icon">🗺️</div>
      <strong>${MAP_CONFIG.labels.imageError}</strong>
      <code>${MAP_CONFIG.image}</code>`;
    _mapCanvas.appendChild(err);
  };
  img.src = MAP_CONFIG.image;
  _mapCanvas.appendChild(img);
}

// ══════════════════════════════════════════════════════════════
// TRANSFORM — ZOOM & PAN
// ══════════════════════════════════════════════════════════════

function _setInitialTransform() {
  if (!_mapViewport || !_mapImage) return;
  const vw = _mapViewport.clientWidth, vh = _mapViewport.clientHeight;
  const iw = MAP_CONFIG.imageWidth,    ih = MAP_CONFIG.imageHeight;
  let scale = MAP_CONFIG.zoomInitial === 'fit'
    ? Math.max(MAP_CONFIG.zoomMin, Math.min(MAP_CONFIG.zoomMax, Math.min(vw / iw, vh / ih) * 0.92))
    : (parseFloat(MAP_CONFIG.zoomInitial) || 1);
  mapTransform.scale = scale;
  mapTransform.x = (vw - iw * scale) / 2;
  mapTransform.y = (vh - ih * scale) / 2;
  _applyTransform();
}

function _applyTransform() {
  if (!_mapCanvas) return;
  _mapCanvas.style.transform =
    `translate(${mapTransform.x}px, ${mapTransform.y}px) scale(${mapTransform.scale})`;
  const inv = 1 / mapTransform.scale;
  document.querySelectorAll('.map-marker').forEach(el => {
    el.style.transform = `translate(-50%, -100%) scale(${inv})`;
  });
}

function _updateZoomDisplay() {
  const el = document.getElementById('map-zoom-value');
  if (el) el.textContent = Math.round(mapTransform.scale * 100) + '%';
}

function _clampTransform() {
  if (!_mapImage) return;
  const vw = _mapViewport.clientWidth, vh = _mapViewport.clientHeight;
  const iw = MAP_CONFIG.imageWidth * mapTransform.scale;
  const ih = MAP_CONFIG.imageHeight * mapTransform.scale;
  const m = 60;
  mapTransform.x = Math.min(vw - m, Math.max(m - iw, mapTransform.x));
  mapTransform.y = Math.min(vh - m, Math.max(m - ih, mapTransform.y));
}

function _zoomAt(cx, cy, newScale) {
  newScale = Math.max(MAP_CONFIG.zoomMin, Math.min(MAP_CONFIG.zoomMax, newScale));
  const r = newScale / mapTransform.scale;
  mapTransform.x = cx - r * (cx - mapTransform.x);
  mapTransform.y = cy - r * (cy - mapTransform.y);
  mapTransform.scale = newScale;
  _clampTransform(); _applyTransform(); _updateZoomDisplay(); _repositionPopup();
}

function mapZoomIn()    { const c = _vc(); _zoomAt(c.x, c.y, mapTransform.scale + MAP_CONFIG.zoomStep); }
function mapZoomOut()   { const c = _vc(); _zoomAt(c.x, c.y, mapTransform.scale - MAP_CONFIG.zoomStep); }
function mapZoomReset() { _setInitialTransform(); _updateZoomDisplay(); _closePopup(); }
function _vc()          { return { x: _mapViewport.clientWidth / 2, y: _mapViewport.clientHeight / 2 }; }

// ══════════════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════════════

function _bindMapEvents() {
  const vp = _mapViewport;

  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    _zoomAt(e.clientX - r.left, e.clientY - r.top,
            mapTransform.scale * (e.deltaY < 0 ? 1.1 : 0.9));
  }, { passive: false });

  let _pinch = null;
  vp.addEventListener('touchstart', e => {
    if (e.touches.length === 2) _pinch = _pinchDist(e);
  }, { passive: true });
  vp.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && _pinch !== null) {
      const d = _pinchDist(e), rect = vp.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
      _zoomAt(cx, cy, mapTransform.scale * (d / _pinch));
      _pinch = d; e.preventDefault();
    }
  }, { passive: false });
  vp.addEventListener('touchend', () => { _pinch = null; });

  vp.addEventListener('mousedown', e => {
    const popup = document.getElementById('map-popup');
    if (popup && !popup.contains(e.target)) _closePopup();
    if (e.shiftKey && e.button === 0) {
      e.preventDefault();
      const pos = _v2m(e.clientX, e.clientY);
      openMapMarkerModal('add', pos.x, pos.y);
      return;
    }
    if (e.button === 0) {
      Object.assign(mapDrag, {
        active: true, moved: false,
        startX: e.clientX, startY: e.clientY,
        originX: mapTransform.x, originY: mapTransform.y,
      });
    }
  });

  window.addEventListener('mousemove', e => {
    if (!mapDrag.active) return;
    const dx = e.clientX - mapDrag.startX, dy = e.clientY - mapDrag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) mapDrag.moved = true;
    mapTransform.x = mapDrag.originX + dx;
    mapTransform.y = mapDrag.originY + dy;
    _clampTransform(); _applyTransform(); _repositionPopup();
  });
  window.addEventListener('mouseup', () => { mapDrag.active = false; });

  let _touch = null;
  vp.addEventListener('touchstart', e => {
    if (e.touches.length === 1)
      _touch = { x: e.touches[0].clientX, y: e.touches[0].clientY,
                 ox: mapTransform.x, oy: mapTransform.y };
  }, { passive: true });
  vp.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && _touch) {
      mapTransform.x = _touch.ox + e.touches[0].clientX - _touch.x;
      mapTransform.y = _touch.oy + e.touches[0].clientY - _touch.y;
      _clampTransform(); _applyTransform();
    }
  }, { passive: true });
  vp.addEventListener('touchend', () => { _touch = null; });

  window.addEventListener('resize', () => {
    if (mapLoaded) { _clampTransform(); _applyTransform(); }
  });
}

function _pinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// viewport px → position relative image [0,1]
function _v2m(cx, cy) {
  const r = _mapViewport.getBoundingClientRect();
  return {
    x: (cx - r.left - mapTransform.x) / mapTransform.scale / MAP_CONFIG.imageWidth,
    y: (cy - r.top  - mapTransform.y) / mapTransform.scale / MAP_CONFIG.imageHeight,
  };
}
// position relative [0,1] → coordonnées canvas px
function _m2c(rx, ry) {
  return { x: rx * MAP_CONFIG.imageWidth, y: ry * MAP_CONFIG.imageHeight };
}

// ══════════════════════════════════════════════════════════════
// DB — MARQUEURS PROPRES
// ══════════════════════════════════════════════════════════════

async function loadMapMarkersFromDB() {
  if (!currentUser) return;
  const { data, error } = await sb.from('map_markers')
    .select('id, x, y, name, description, color')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: true });
  if (error) { console.error('Erreur marqueurs:', error); return; }
  mapMarkers = {};
  (data || []).forEach(m => { mapMarkers[m.id] = m; });
}

async function _saveMarkerToDB(payload, ctx) {
  if (ctx.mode === 'add') {
    const { data, error } = await sb.from('map_markers')
      .insert({ ...payload, user_id: currentUser.id })
      .select('id, x, y, name, description, color').single();
    if (error) { showToast(MAP_CONFIG.labels.toastError); return; }
    mapMarkers[data.id] = data;
    _renderMarker(data, true);
    _updateMarkerCount();
    showToast(MAP_CONFIG.labels.toastAdded);
  } else {
    const { data, error } = await sb.from('map_markers')
      .update(payload).eq('id', ctx.id)
      .select('id, x, y, name, description, color').single();
    if (error) { showToast(MAP_CONFIG.labels.toastError); return; }
    mapMarkers[data.id] = data;
    _refreshMarkerDOM(data);
    showToast(MAP_CONFIG.labels.toastSaved);
  }
}

async function deleteMapMarker(id) {
  if (!confirm(MAP_CONFIG.labels.confirmDelete)) return;
  const { error } = await sb.from('map_markers').delete().eq('id', id);
  if (error) { showToast(MAP_CONFIG.labels.toastError); return; }
  delete mapMarkers[id];
  document.getElementById('marker-' + id)?.remove();
  _updateMarkerCount();
  _closePopup();
  showToast(MAP_CONFIG.labels.toastDeleted);
}

// ══════════════════════════════════════════════════════════════
// DB — COUCHE PROPRE (map_layer)
// ══════════════════════════════════════════════════════════════

async function loadOwnLayerFromDB() {
  if (!currentUser) return;
  const { data } = await sb.from('map_layers')
    .select('id, title, description, is_public, share_code')
    .eq('user_id', currentUser.id).maybeSingle();
  mapOwnLayer = data || null;
}

async function saveOwnLayerToDB() {
  const title  = document.getElementById('map-layer-title')?.value.trim() || '';
  const desc   = document.getElementById('map-layer-desc')?.value.trim()  || '';
  const pub    = document.getElementById('map-layer-public')?.checked      || false;
  const payload = { title, description: desc, is_public: pub };

  if (mapOwnLayer?.id) {
    const { data, error } = await sb.from('map_layers')
      .update(payload).eq('id', mapOwnLayer.id)
      .select('id, title, description, is_public, share_code').single();
    if (error) { showToast(MAP_CONFIG.labels.toastError); return; }
    mapOwnLayer = data;
  } else {
    const { data, error } = await sb.from('map_layers')
      .insert({ ...payload, user_id: currentUser.id })
      .select('id, title, description, is_public, share_code').single();
    if (error) { showToast(MAP_CONFIG.labels.toastError); return; }
    mapOwnLayer = data;
  }
  _renderLayerPanel();
  showToast(MAP_CONFIG.labels.toastSaved);
}

// ══════════════════════════════════════════════════════════════
// DB — COUCHES SUIVIES
// ══════════════════════════════════════════════════════════════

async function loadFollowedLayersFromDB() {
  if (!currentUser) return;
  const { data: follows } = await sb.from('followed_map_layers')
    .select('layer_id').eq('user_id', currentUser.id);
  mapFollowedIds = (follows || []).map(r => r.layer_id);
  if (!mapFollowedIds.length) { mapFollowedLayers = {}; return; }

  const { data: layers } = await sb.from('map_layers')
    .select('id, title, description, is_public, share_code, user_id')
    .in('id', mapFollowedIds).eq('is_public', true);

  const ownerIds = [...new Set((layers || []).map(l => l.user_id))];
  let ownerMap = {};
  if (ownerIds.length) {
    const { data: profiles } = await sb.from('profiles').select('id, username').in('id', ownerIds);
    (profiles || []).forEach(p => { ownerMap[p.id] = p.username; });
  }

  mapFollowedLayers = {};
  for (const layer of (layers || [])) {
    const { data: markers } = await sb.from('map_markers')
      .select('id, x, y, name, description, color').eq('user_id', layer.user_id);
    mapFollowedLayers[layer.id] = {
      layer: { ...layer, _owner_name: ownerMap[layer.user_id] || '?' },
      markers: Object.fromEntries((markers || []).map(m => [m.id, m])),
    };
  }
}

async function followMapLayerByCode(code) {
  if (!code.trim()) return;
  const clean = code.trim().toUpperCase();
  const { data, error } = await sb.from('map_layers')
    .select('id, title, user_id, is_public')
    .eq('share_code', clean).eq('is_public', true).single();
  if (error || !data) { showToast(MAP_CONFIG.labels.toastLayerNotFound || 'Couche introuvable.'); return; }
  if (data.user_id === currentUser.id) { showToast(MAP_CONFIG.labels.toastLayerOwn || 'C\'est votre propre couche !'); return; }
  if (mapFollowedIds.includes(data.id)) { showToast(MAP_CONFIG.labels.toastLayerAlreadyFollowed || 'Déjà abonné.'); return; }

  const { error: err } = await sb.from('followed_map_layers')
    .insert({ user_id: currentUser.id, layer_id: data.id });
  if (err) { showToast(MAP_CONFIG.labels.toastError); return; }

  mapFollowedIds.push(data.id);
  await loadFollowedLayersFromDB();
  _renderAllMarkers();
  _renderLayerPanel();
  document.getElementById('map-follow-input').value = '';
  const msg = (MAP_CONFIG.labels.toastLayerSubscribed || 'Abonné à "${title}" !')
    .replace('${title}', data.title || clean);
  showToast(msg);
}

async function unfollowMapLayer(layerId) {
  const layer = mapFollowedLayers[layerId]?.layer;
  // Vérifie les campagnes bloquantes
  if (layer?.share_code && typeof getFollowedCampaignTitlesByItem === 'function') {
    const blocking = await getFollowedCampaignTitlesByItem('map', layer.share_code);
    if (blocking.length) {
      showToast(`Impossible : cette couche fait partie de la (des) campagne(s) : ${blocking.join(', ')}.`);
      return;
    }
  }
  await sb.from('followed_map_layers')
    .delete().eq('user_id', currentUser.id).eq('layer_id', layerId);
  mapFollowedIds = mapFollowedIds.filter(id => id !== layerId);
  delete mapFollowedLayers[layerId];
  _renderAllMarkers();
  _renderLayerPanel();
  showToast(MAP_CONFIG.labels.toastLayerUnsubscribed || 'Abonnement supprimé.');
}

// ══════════════════════════════════════════════════════════════
// RENDU — MARQUEURS
// ══════════════════════════════════════════════════════════════

function _renderAllMarkers() {
  if (!_mapCanvas) return;
  _mapCanvas.querySelectorAll('.map-marker').forEach(el => el.remove());
  // Couches suivies en dessous
  Object.values(mapFollowedLayers).forEach(({ markers }) => {
    Object.values(markers).forEach(m => _renderMarker(m, false));
  });
  // Marqueurs propres par-dessus
  Object.values(mapMarkers).forEach(m => _renderMarker(m, true));
  _updateMarkerCount();
}

function _renderMarker(m, owned) {
  if (!_mapCanvas) return;
  const { x: cx, y: cy } = _m2c(m.x, m.y);
  const size = MAP_CONFIG.markerSize;
  const inv  = 1 / mapTransform.scale;

  const el = document.createElement('div');
  el.className = 'map-marker' + (owned ? '' : ' map-marker-followed');
  el.id        = 'marker-' + m.id;
  el.style.left      = cx + 'px';
  el.style.top       = cy + 'px';
  el.style.transform = `translate(-50%, -100%) scale(${inv})`;

  const opacity = owned ? '0.92' : '0.65';
  const innerDot = !owned
    ? `<circle cx="14" cy="14" r="2.5" fill="${m.color}" opacity="0.7"/>`
    : '';

  el.innerHTML = `
    <svg class="map-marker-pin"
      width="${size}" height="${Math.round(size * 1.4)}"
      viewBox="0 0 28 40" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 26 14 26s14-16.667 14-26C28 6.268 21.732 0 14 0z"
        fill="${m.color}" opacity="${opacity}"/>
      <circle cx="14" cy="14" r="5.5" fill="white" opacity="0.95"/>
      ${innerDot}
    </svg>
    <div class="map-marker-label">${esc(m.name)}</div>`;

  el.addEventListener('click', e => {
    e.stopPropagation();
    if (mapDrag.moved) return;
    _openPopup(m.id, owned);
  });

  _mapCanvas.appendChild(el);
}

function _refreshMarkerDOM(m) {
  const el = document.getElementById('marker-' + m.id);
  if (!el) { _renderMarker(m, true); return; }
  const path   = el.querySelector('path');
  if (path) path.setAttribute('fill', m.color);
  const label = el.querySelector('.map-marker-label');
  if (label) label.textContent = m.name;
}

function _updateMarkerCount() {
  const el = document.getElementById('map-marker-count');
  if (!el) return;
  const own      = Object.keys(mapMarkers).length;
  const followed = Object.values(mapFollowedLayers)
    .reduce((acc, { markers }) => acc + Object.keys(markers).length, 0);
  const total = own + followed;
  el.innerHTML = `<span>${total}</span> marqueur${total !== 1 ? 's' : ''}`;
}

// ══════════════════════════════════════════════════════════════
// POPUP D'INFO
// ══════════════════════════════════════════════════════════════

function _openPopup(markerId, owned) {
  let m = mapMarkers[markerId];
  let ownerName = null;
  if (!m) {
    for (const { layer, markers } of Object.values(mapFollowedLayers)) {
      if (markers[markerId]) { m = markers[markerId]; ownerName = layer._owner_name; break; }
    }
  }
  if (!m) return;
  mapOpenPopup = { id: markerId, owned };

  document.getElementById('map-popup')?.remove();

  const popup = document.createElement('div');
  popup.className = 'map-popup'; popup.id = 'map-popup';

  popup.innerHTML = `
    <div class="map-popup-header">
      <div class="map-popup-color-dot" style="background:${m.color}"></div>
      <div class="map-popup-name">${esc(m.name)}</div>
      <button class="map-popup-close" onclick="_closePopup()">✕</button>
    </div>
    ${m.description ? `<div class="map-popup-desc">${esc(m.description)}</div>` : ''}
    ${ownerName ? `<div class="map-popup-owner">par ${esc(ownerName)}</div>` : ''}
    ${owned ? `
    <div class="map-popup-actions">
      <button class="map-popup-edit-btn"
        onclick="openMapMarkerModal('edit',null,null,'${markerId}')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
          width="11" height="11"><path d="M11 2l3 3-9 9H2v-3z"/></svg>
        Modifier
      </button>
      <button class="map-popup-delete-btn" onclick="deleteMapMarker('${markerId}')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
          width="11" height="11">
          <polyline points="3,4 13,4"/>
          <path d="M5 4V2h6v2M6 7v5M10 7v5"/>
          <path d="M4 4l1 10h6l1-10"/>
        </svg>
        ${MAP_CONFIG.labels.btnDelete}
      </button>
    </div>` : ''}`;

  _mapViewport.appendChild(popup);
  _repositionPopupOn(markerId, popup);
}

function _repositionPopup() {
  if (!mapOpenPopup) return;
  const popup = document.getElementById('map-popup');
  if (popup) _repositionPopupOn(mapOpenPopup.id, popup);
}

function _repositionPopupOn(markerId, popup) {
  let m = mapMarkers[markerId];
  if (!m) {
    for (const { markers } of Object.values(mapFollowedLayers)) {
      if (markers[markerId]) { m = markers[markerId]; break; }
    }
  }
  if (!m) return;
  const { x: cx, y: cy } = _m2c(m.x, m.y);
  const vx = cx * mapTransform.scale + mapTransform.x;
  const vy = cy * mapTransform.scale + mapTransform.y;
  const pw = popup.offsetWidth || 240, ph = popup.offsetHeight || 120;
  const vw = _mapViewport.clientWidth,  vh = _mapViewport.clientHeight;
  let left = vx - pw / 2;
  let top  = vy - MAP_CONFIG.markerSize / mapTransform.scale * 1.4 - ph - 8;
  if (left < 8)       left = 8;
  if (left + pw > vw) left = vw - pw - 8;
  if (top  < 8)       top  = vy + MAP_CONFIG.markerSize + 8;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';
}

function _closePopup() {
  document.getElementById('map-popup')?.remove();
  mapOpenPopup = null;
}

// ══════════════════════════════════════════════════════════════
// MODALE MARQUEUR
// ══════════════════════════════════════════════════════════════

function openMapMarkerModal(mode, rx, ry, markerId) {
  mapModalCtx = { mode, x: rx, y: ry, id: markerId };
  const m = (mode === 'edit' && markerId) ? mapMarkers[markerId] : null;
  mapModalColor = m?.color || MAP_CONFIG.markerColors[0];

  document.getElementById('map-modal-title-text').textContent =
    mode === 'add' ? MAP_CONFIG.labels.markerModalTitle : MAP_CONFIG.labels.editModalTitle;
  document.getElementById('map-modal-name').value = m?.name        || '';
  document.getElementById('map-modal-desc').value = m?.description || '';

  document.getElementById('map-modal-swatches').innerHTML =
    MAP_CONFIG.markerColors.map(c => `
      <div class="map-color-swatch ${c === mapModalColor ? 'selected' : ''}"
        style="background:${c}" onclick="selectMapModalColor('${c}',this)"></div>`
    ).join('');

  document.getElementById('map-marker-modal').classList.add('open');
  requestAnimationFrame(() => document.getElementById('map-modal-name').focus());
  _closePopup();
}

function selectMapModalColor(color, el) {
  mapModalColor = color;
  document.querySelectorAll('.map-color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

function closeMapMarkerModal() {
  document.getElementById('map-marker-modal').classList.remove('open');
  mapModalCtx = null;
}

async function submitMapMarkerModal() {
  const name = document.getElementById('map-modal-name').value.trim();
  const desc = document.getElementById('map-modal-desc').value.trim();
  if (!name) { document.getElementById('map-modal-name').focus(); return; }
  const ctx = { ...mapModalCtx };
  const payload = {
    name, description: desc, color: mapModalColor,
    ...(ctx.mode === 'add' && {
      x: Math.max(0, Math.min(1, ctx.x)),
      y: Math.max(0, Math.min(1, ctx.y)),
    }),
  };
  closeMapMarkerModal();
  await _saveMarkerToDB(payload, ctx);
}

document.addEventListener('keydown', e => {
  const modal = document.getElementById('map-marker-modal');
  if (!modal?.classList.contains('open')) return;
  if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault(); submitMapMarkerModal();
  }
  if (e.key === 'Escape') closeMapMarkerModal();
});

// ══════════════════════════════════════════════════════════════
// PANNEAU LATÉRAL — PARTAGE & ABONNEMENTS
// ══════════════════════════════════════════════════════════════

function _renderLayerPanel() {
  const panel = document.getElementById('map-layer-panel');
  if (!panel) return;

  const layer    = mapOwnLayer;
  const isPublic = layer?.is_public || false;
  const code     = layer?.share_code || null;

  const shareCodeHtml = isPublic && code ? `
    <div class="map-share-code-box">
      <span class="map-share-code-val">${code}</span>
      <button onclick="_copyMapShareCode('${code}')">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
          width="12" height="12">
          <rect x="5" y="5" width="8" height="8" rx="1"/>
          <path d="M3 11H2a1 1 0 01-1-1V2a1 1 0 011-1h8a1 1 0 011 1v1"/>
        </svg>
        Copier
      </button>
    </div>` : '';

  const followedHtml = Object.values(mapFollowedLayers).length
    ? Object.values(mapFollowedLayers).map(({ layer: l }) => `
        <div class="map-followed-row">
          <div class="map-followed-dot"></div>
          <div class="map-followed-info">
            <div class="map-followed-title">${esc(l.title || l.share_code)}</div>
            <div class="map-followed-owner">par ${esc(l._owner_name)}</div>
          </div>
          <button class="icon-btn danger" onclick="unfollowMapLayer('${l.id}')"
            title="Se désabonner">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <polyline points="3,4 13,4"/>
              <path d="M5 4V2h6v2M6 7v5M10 7v5"/>
              <path d="M4 4l1 10h6l1-10"/>
            </svg>
          </button>
        </div>`).join('')
    : `<div class="map-followed-empty">Aucune couche suivie.</div>`;

  panel.innerHTML = `
    <div class="map-panel-inner">

      <div class="map-panel-section">
        <div class="map-panel-title">Ma couche</div>
        <div class="map-panel-field">
          <label>Titre</label>
          <input type="text" id="map-layer-title"
            value="${esc(layer?.title || '')}"
            placeholder="Ex : Carte de Théodric">
        </div>
        <div class="map-panel-field">
          <label>Description</label>
          <textarea id="map-layer-desc"
            placeholder="Notes pour les joueurs…">${esc(layer?.description || '')}</textarea>
        </div>
        <div class="map-panel-public-row">
          <label>Partage public</label>
          <label class="map-panel-toggle">
            <input type="checkbox" id="map-layer-public"
              ${isPublic ? 'checked' : ''}
              onchange="_onLayerPublicChange(this.checked)">
            <span id="map-layer-public-label">${isPublic ? 'Public (code actif)' : 'Privé'}</span>
          </label>
        </div>
        ${shareCodeHtml}
        <button class="map-panel-save-btn" onclick="saveOwnLayerToDB()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
            width="12" height="12"><polyline points="2,8 6,12 14,4"/></svg>
          Enregistrer
        </button>
      </div>

      <div class="map-panel-section">
        <div class="map-panel-title">Couches suivies</div>
        <div class="map-follow-input-wrap">
          <input type="text" id="map-follow-input"
            placeholder="Code de partage (8 car.)"
            maxlength="8"
            oninput="this.value=this.value.toUpperCase()"
            onkeydown="if(event.key==='Enter') followMapLayerByCode(this.value)">
          <button onclick="followMapLayerByCode(document.getElementById('map-follow-input').value)">
            + Suivre
          </button>
        </div>
        <div class="map-followed-list">${followedHtml}</div>
      </div>

    </div>`;
}

function _onLayerPublicChange(checked) {
  const label = document.getElementById('map-layer-public-label');
  if (label) label.textContent = checked ? 'Public (code actif)' : 'Privé';
}

function _copyMapShareCode(code) {
  navigator.clipboard.writeText(code)
    .then(() => showToast(`Code "${code}" copié !`))
    .catch(() => prompt('Code de partage :', code));
}

function toggleMapPanel() {
  const panel = document.getElementById('map-layer-panel');
  const btn   = document.getElementById('map-panel-btn');
  if (!panel) return;
  const open = panel.classList.toggle('open');
  if (btn) btn.classList.toggle('active', open);
}

// ══════════════════════════════════════════════════════════════
// INTÉGRATION CAMPAGNES
// buildSelectableList('map') est appelé par campaigns.js.
// navigateToCampaignItem('map', code) ouvre simplement la carte.
// ══════════════════════════════════════════════════════════════

// Patch de buildSelectableList pour le type 'map'
// On surcharge après que la fonction originale a été définie.
document.addEventListener('DOMContentLoaded', () => {
  const _orig = window.buildSelectableList;
  window.buildSelectableList = function(type) {
    if (type !== 'map') return _orig ? _orig(type) : [];
    const items = [];
    if (mapOwnLayer?.share_code && mapOwnLayer?.is_public) {
      items.push({
        code: mapOwnLayer.share_code,
        name: mapOwnLayer.title || 'Ma carte',
        sub:  mapOwnLayer.description || '',
        owner: null,
      });
    }
    Object.values(mapFollowedLayers).forEach(({ layer: l }) => {
      if (l.share_code && l.is_public) {
        items.push({ code: l.share_code, name: l.title || l.share_code, sub: '', owner: l._owner_name });
      }
    });
    return items;
  };
});

function navigateToMap(shareCode) {
  showView('map');
  return true;
}

// ══════════════════════════════════════════════════════════════
// SYNC CAMPAGNES — abonnement automatique aux couches d'une
// campagne suivie (appelé depuis campaigns.js)
// ══════════════════════════════════════════════════════════════

async function syncFollowedMapLayers(shareCodes) {
  if (!shareCodes || !shareCodes.length) return 0;
  const { data: layerRows } = await sb.from('map_layers')
    .select('id, title, user_id, is_public, share_code')
    .in('share_code', shareCodes).eq('is_public', true);
  let added = 0;
  for (const row of (layerRows || [])) {
    if (row.user_id === currentUser.id) continue;
    if (mapFollowedIds.includes(row.id)) continue;
    const { error } = await sb.from('followed_map_layers')
      .insert({ user_id: currentUser.id, layer_id: row.id });
    if (!error) { mapFollowedIds.push(row.id); added++; }
  }
  if (added) {
    await loadFollowedLayersFromDB();
    _renderAllMarkers();
    _renderLayerPanel();
  }
  return added;
}
