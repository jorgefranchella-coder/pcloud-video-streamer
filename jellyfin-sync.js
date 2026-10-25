const path = require('path');

const MANAGED_PERSON_ROLE = 'Identificada por Video Home';
const MANAGED_TAG_PREFIX = 'Archivo: ';
const PAGE_SIZE = 500;

class JellyfinError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'JellyfinError';
    this.status = status;
  }
}

function configuration() {
  const base = process.env.JELLYFIN_URL?.trim() || '';
  const apiKey = process.env.JELLYFIN_API_KEY?.trim() || '';
  if (!base || !apiKey) return { configured: false };
  let parsed;
  try { parsed = new URL(base); } catch { throw new JellyfinError('JELLYFIN_URL must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new JellyfinError('JELLYFIN_URL must be an HTTP(S) base URL without credentials, query, or fragment');
  }
  return {
    configured: true,
    baseUrl: parsed.toString().replace(/\/$/, ''),
    apiKey,
    userId: process.env.JELLYFIN_USER_ID?.trim() || ''
  };
}

function isConfigured() {
  try { return configuration().configured; } catch { return false; }
}

async function request(config, pathname, { method = 'GET', query, body } = {}) {
  const url = new URL(`${config.baseUrl}${pathname}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, item));
      else url.searchParams.set(key, String(value));
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        // Jellyfin 12.x disables legacy token headers by default. Use the
        // MediaBrowser Authorization scheme supported by current servers.
        Authorization: `MediaBrowser Token="${config.apiKey}"`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new JellyfinError('Jellyfin did not respond in time');
    throw new JellyfinError('Could not connect to Jellyfin');
  }
  if (!response.ok) throw new JellyfinError(`Jellyfin returned HTTP ${response.status}`, response.status);
  if (response.status === 204) return null;
  try { return await response.json(); }
  catch { throw new JellyfinError('Jellyfin returned an invalid response'); }
}

async function resolveUserId(config) {
  if (config.userId) return config.userId;
  const users = await request(config, '/Users');
  const admin = (Array.isArray(users) ? users : []).find(user => user.Policy?.IsAdministrator);
  if (!admin?.Id) throw new JellyfinError('No administrator user was found in Jellyfin');
  return admin.Id;
}

async function findItemByPath(config, userId, targetPath) {
  const normalizedTarget = path.resolve(targetPath);
  let startIndex = 0;
  let total = Infinity;
  while (startIndex < total && startIndex < 100000) {
    const page = await request(config, '/Items', {
      query: {
        userId, recursive: true, fields: ['Path'], startIndex, limit: PAGE_SIZE,
        enableTotalRecordCount: true
      }
    });
    const items = Array.isArray(page?.Items) ? page.Items : [];
    const matches = items.filter(item => typeof item.Path === 'string' && path.resolve(item.Path) === normalizedTarget);
    if (matches.length > 1) throw new JellyfinError('Jellyfin returned multiple entries for this video path');
    if (matches.length === 1) return matches[0];
    total = Number.isSafeInteger(page?.TotalRecordCount) ? page.TotalRecordCount : startIndex + items.length;
    if (items.length === 0) break;
    startIndex += items.length;
  }
  return null;
}

function validCoordinates(location) {
  const coordinates = location?.coordinates;
  if (!Number.isFinite(coordinates?.latitude) || !Number.isFinite(coordinates?.longitude) ||
      Math.abs(coordinates.latitude) > 90 || Math.abs(coordinates.longitude) > 180) return null;
  return coordinates;
}

function managedTags(parsed) {
  const values = [
    ...(Array.isArray(parsed.visual_places) ? parsed.visual_places : []),
    ...(Array.isArray(parsed.visual_keywords) ? parsed.visual_keywords : [])
  ];
  const location = parsed.technical?.location?.raw?.trim();
  if (location && !/^\s*[+-]?\d/.test(location)) values.push(`Lugar: ${location}`);
  const unique = new Map();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const clean = value.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!clean) continue;
    unique.set(clean.toLocaleLowerCase(), `${MANAGED_TAG_PREFIX}${clean}`);
  }
  return [...unique.values()].slice(0, 50);
}

function managedPeople(identifiedPeople, identifiedFaces) {
  const names = new Map();
  for (const assignments of Object.values(identifiedPeople?.all || {})) {
    for (const person of assignments || []) {
      if (typeof person.name === 'string' && person.name.trim()) names.set(person.name.trim().toLocaleLowerCase(), person.name.trim());
    }
  }
  for (const person of identifiedFaces || []) {
    if (typeof person.name === 'string' && person.name.trim()) names.set(person.name.trim().toLocaleLowerCase(), person.name.trim());
  }
  return [...names.values()].map(name => ({ Name: name, Role: MANAGED_PERSON_ROLE, Type: 'Actor' }));
}

function makeDto(current, parsed, identifiedPeople, identifiedFaces, approvedRefinement) {
  const dto = structuredClone(current);
  const updates = {};
  const title = typeof approvedRefinement?.title === 'string' ? approvedRefinement.title.trim()
    : typeof parsed.visual_title === 'string' ? parsed.visual_title.trim() : '';
  const summary = typeof approvedRefinement?.summary === 'string' ? approvedRefinement.summary.trim()
    : typeof parsed.visual_summary === 'string' ? parsed.visual_summary.trim() : '';
  if (title) updates.Name = title;
  if (summary) updates.Overview = summary;

  if (parsed.recorded_at) {
    const date = new Date(parsed.recorded_at);
    if (!Number.isNaN(date.getTime())) {
      updates.PremiereDate = date.toISOString();
      updates.ProductionYear = date.getUTCFullYear();
    }
  }

  const existingPeople = Array.isArray(current.People) ? current.People : [];
  const confirmedPeople = managedPeople(identifiedPeople, identifiedFaces);
  const managedPeopleByName = new Map(existingPeople
    .filter(person => person?.Role === MANAGED_PERSON_ROLE && typeof person.Name === 'string')
    .map(person => [person.Name.toLocaleLowerCase(), person]));
  const nextManagedPeople = confirmedPeople.map(person => ({
    ...(managedPeopleByName.get(person.Name.toLocaleLowerCase()) || {}),
    ...person
  }));
  const currentManagedNames = existingPeople
    .filter(person => person?.Role === MANAGED_PERSON_ROLE)
    .map(person => `${person.Name || ''}\u0000${person.Role || ''}\u0000${person.Type || ''}`)
    .sort();
  const nextManagedNames = nextManagedPeople
    .map(person => `${person.Name}\u0000${person.Role}\u0000${person.Type}`)
    .sort();
  updates.People = [
    ...existingPeople.filter(person => person?.Role !== MANAGED_PERSON_ROLE),
    ...nextManagedPeople
  ];
  if (JSON.stringify(currentManagedNames) === JSON.stringify(nextManagedNames)) updates.People = current.People;

  const existingTags = Array.isArray(current.Tags) ? current.Tags : [];
  updates.Tags = [
    ...existingTags.filter(tag => typeof tag !== 'string' || !tag.startsWith(MANAGED_TAG_PREFIX)),
    ...managedTags(parsed)
  ];

  const location = parsed.technical?.location;
  const coordinates = validCoordinates(location);
  if (coordinates) {
    updates.Latitude = coordinates.latitude;
    updates.Longitude = coordinates.longitude;
    if (Number.isFinite(coordinates.altitude_m)) updates.Altitude = coordinates.altitude_m;
  }
  const locationName = typeof location?.raw === 'string' && !/^\s*[+-]?\d/.test(location.raw)
    ? location.raw.trim() : '';
  const visualPlaces = Array.isArray(parsed.visual_places) ? parsed.visual_places.filter(value => typeof value === 'string' && value.trim()) : [];
  const locations = [...new Set([...(locationName ? [locationName] : []), ...visualPlaces])];
  if (locations.length) updates.ProductionLocations = locations;

  const capture = parsed.technical?.capture_device;
  if (capture?.manufacturer?.value) updates.CameraMake = capture.manufacturer.value;
  if (capture?.model?.value) updates.CameraModel = capture.model.value;

  Object.assign(dto, updates);
  const changedFields = Object.keys(updates).filter(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(updates[key] ?? null));
  return {
    dto,
    changedFields,
    proposed: Object.fromEntries(changedFields.map(key => [key, updates[key]])),
    peopleCount: confirmedPeople.length
  };
}

async function prepareSync({ targetPath, parsed, identifiedPeople, identifiedFaces, approvedRefinement }) {
  const config = configuration();
  if (!config.configured) throw new JellyfinError('Jellyfin integration is not configured');
  const userId = await resolveUserId(config);
  const match = await findItemByPath(config, userId, targetPath);
  if (!match) throw new JellyfinError('This video path is not present in the Jellyfin library');
  const current = await request(config, `/Items/${encodeURIComponent(match.Id)}`, { query: { userId } });
  if (!current || path.resolve(current.Path || '') !== path.resolve(targetPath)) {
    throw new JellyfinError('The Jellyfin item path changed while preparing synchronization');
  }
  const result = makeDto(current, parsed, identifiedPeople, identifiedFaces, approvedRefinement);
  return { config, match: current, ...result };
}

async function preview(args) {
  const prepared = await prepareSync(args);
  return {
    item_id: prepared.match.Id,
    current_title: prepared.match.Name || '',
    changed_fields: prepared.changedFields,
    proposed: prepared.proposed,
    people_count: prepared.peopleCount
  };
}

async function sync(args) {
  const prepared = await prepareSync(args);
  if (!prepared.changedFields.length) {
    return { synced: true, changed: false, item_id: prepared.match.Id, title: prepared.match.Name || '', changed_fields: [] };
  }
  await request(prepared.config, `/Items/${encodeURIComponent(prepared.match.Id)}`, {
    method: 'POST', body: prepared.dto
  });
  return {
    synced: true,
    changed: true,
    item_id: prepared.match.Id,
    title: prepared.dto.Name || '',
    changed_fields: prepared.changedFields,
    people_count: prepared.peopleCount
  };
}

module.exports = { isConfigured, JellyfinError, preview, sync };
