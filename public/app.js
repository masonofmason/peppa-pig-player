// Peppa Pig Player
// - 영상 목록: 공식 채널의 업로드 재생목록을 통째로 받아 localStorage에 보관 (playlistItems.list + videos.list, 호출당 1 유닛)
//   검색/날짜 필터/정렬은 모두 브라우저 안에서 처리하므로 API 사용량이 들지 않는다.
//   (search.list는 호출당 100 유닛이라 쓰지 않는다)
// - 재생/진행률 추적: YouTube IFrame Player API
// - 시청 기록: localStorage (브라우저별 저장)

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const CHANNEL_ID = 'UCAOtE1V7Ots4DjM8JLlrYgg'; // Peppa Pig - Official Channel (영어)
const CHANNEL_NAME = 'Peppa Pig - Official Channel';
const UPLOADS_PLAYLIST_ID = `UU${CHANNEL_ID.slice(2)}`; // 채널의 "업로드 영상" 재생목록
const API_PAGE_SIZE = 50;                    // playlistItems/videos.list 최대값
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;  // 앱을 열 때 1시간 넘게 지났으면 새 영상 확인
const MAX_REFRESH_PAGES = 20;                // 새 영상 확인 시 최대로 넘겨볼 페이지 수
const RENDER_STEP = 48;                      // 한 번에 그리는 카드 수
const COMPLETE_RATIO = 0.95;                 // 95% 이상 보면 "본 영상"
const COMPLETE_REMAINING_SEC = 10;           // 또는 남은 시간이 10초 이하
const WATCHING_MIN_SEC = 3;                  // 3초 미만 재생은 "안 본 영상"으로 취급
const SAVE_INTERVAL_MS = 2000;

const STORAGE = {
  apiKey: 'pp.apiKey',
  progress: 'pp.progress',
  catalog: 'pp.catalog',
  filter: 'pp.filter',
  date: 'pp.dateFilter',
  sort: 'pp.sort',
};
const LEGACY_KEYS = ['pp.searchCache']; // 예전 검색 API 방식의 캐시

const FIRST_YEAR = 2005; // YouTube 서비스 시작 연도
const EMPTY_DATE = { year: '', month: '', day: '', hour: '' };
const EMPTY_CATALOG = { videos: [], nextPageToken: null, complete: false, lastSync: 0 };

const STATUS_LABEL = { unwatched: '안 본 영상', watching: '보는 중', completed: '다 봄' };

// ---------- storage ----------
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // 저장 불가(시크릿 모드, 용량 초과 등)여도 앱은 동작한다
  }
}
LEGACY_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch { /* noop */ } });

// ---------- state ----------
const state = {
  apiKey: load(STORAGE.apiKey, '') || window.PEPPA_CONFIG?.apiKey || '', // config.js의 키는 배포용 기본값
  progress: load(STORAGE.progress, {}), // { [videoId]: ProgressRecord }
  catalog: { ...EMPTY_CATALOG, ...load(STORAGE.catalog, {}) },
  filter: load(STORAGE.filter, 'all'),
  date: { ...EMPTY_DATE, ...load(STORAGE.date, {}) }, // 업로드 날짜 필터 (로컬 시간 기준, 빈 문자열 = 전체)
  sort: load(STORAGE.sort, 'newest'),
  query: '',
  visibleCount: RENDER_STEP,
  syncing: false,
  syncError: null,
};

/**
 * CatalogItem (저장용, 용량을 줄이려고 최소 필드만): { id, title, publishedAt, duration(sec) }
 * Video (화면용): CatalogItem + { channel, thumb }
 * ProgressRecord: Video + { position(sec), completed(bool), updatedAt(ms) }
 */

const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const toVideo = (item) => ({ ...item, channel: CHANNEL_NAME, thumb: thumbUrl(item.id) });

function persistProgress() {
  save(STORAGE.progress, state.progress);
}

function persistCatalog() {
  save(STORAGE.catalog, state.catalog);
}

function statusOf(id) {
  const rec = state.progress[id];
  if (!rec) return 'unwatched';
  if (rec.completed) return 'completed';
  return rec.position >= WATCHING_MIN_SEC ? 'watching' : 'unwatched';
}

function progressRatio(id) {
  const rec = state.progress[id];
  if (!rec) return 0;
  if (rec.completed) return 1;
  return rec.duration ? Math.min(1, rec.position / rec.duration) : 0;
}

function isComplete(position, duration) {
  if (!duration) return false;
  return position / duration >= COMPLETE_RATIO || duration - position <= COMPLETE_REMAINING_SEC;
}

function updateProgress(video, position, duration, { forceComplete = false } = {}) {
  const prev = state.progress[video.id];
  const completed = Boolean(prev?.completed) || forceComplete || isComplete(position, duration);
  state.progress[video.id] = {
    id: video.id,
    title: video.title,
    channel: video.channel,
    thumb: video.thumb,
    publishedAt: video.publishedAt,
    duration: duration || video.duration || prev?.duration || 0,
    position: completed ? (duration || position) : position,
    completed,
    updatedAt: Date.now(),
  };
  persistProgress();
}

// ---------- upload date filter ----------
// 선택한 단계(년/월/일/시)에 해당하는 [시작, 끝) 구간. 사용자의 로컬 시간대 기준.
function dateRange(d = state.date) {
  if (!d.year) return null;
  const y = Number(d.year);
  if (d.month === '') return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
  const m = Number(d.month) - 1;
  if (d.day === '') return [new Date(y, m, 1), new Date(y, m + 1, 1)];
  const day = Number(d.day);
  if (d.hour === '') return [new Date(y, m, day), new Date(y, m, day + 1)];
  const h = Number(d.hour);
  return [new Date(y, m, day, h), new Date(y, m, day, h + 1)];
}

function inDateRange(video, range) {
  if (!range) return true;
  const t = Date.parse(video.publishedAt);
  return !Number.isNaN(t) && t >= range[0].getTime() && t < range[1].getTime();
}

function dateLabel(d = state.date) {
  if (!d.year) return '';
  let s = `${d.year}년`;
  if (d.month !== '') s += ` ${d.month}월`;
  if (d.day !== '') s += ` ${d.day}일`;
  if (d.hour !== '') s += ` ${d.hour}시`;
  return s;
}

// ---------- YouTube Data API ----------
function parseISODuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((v) => Number(v) || 0);
  return d * 86400 + h * 3600 + min * 60 + s;
}

class ApiError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

async function apiGet(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  Object.entries({ ...params, key: state.apiKey }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || String(res.status);
    throw new ApiError(body?.error?.message || `HTTP ${res.status}`, reason);
  }
  return body;
}

// 업로드 재생목록 한 페이지(50개) + 영상 상세(길이, 라이브 여부). 합계 2 유닛.
async function fetchUploadsPage(pageToken) {
  const list = await apiGet('playlistItems', {
    part: 'contentDetails',
    playlistId: UPLOADS_PLAYLIST_ID,
    maxResults: API_PAGE_SIZE,
    ...(pageToken ? { pageToken } : {}),
  });
  const ids = list.items.map((it) => it.contentDetails?.videoId).filter(Boolean);
  let videos = [];
  if (ids.length) {
    // 비공개/삭제된 영상은 videos.list 응답에 없으므로 자연히 빠진다
    const details = await apiGet('videos', { part: 'snippet,contentDetails', id: ids.join(','), maxResults: API_PAGE_SIZE });
    videos = details.items
      .filter((v) => v.snippet.liveBroadcastContent === 'none') // 진행 중/예정 라이브는 제외 (끝난 라이브는 포함)
      .map((v) => ({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        duration: parseISODuration(v.contentDetails?.duration),
      }));
  }
  return { ids, videos, nextPageToken: list.nextPageToken || null };
}

function addToCatalog(videos) {
  const known = new Set(state.catalog.videos.map((v) => v.id));
  const fresh = videos.filter((v) => !known.has(v.id));
  if (fresh.length) state.catalog.videos.push(...fresh);
  return fresh.length;
}

// 처음에는 전체 목록을 받고(중간에 끊기면 이어받기), 그 뒤로는 앞쪽(최신)부터 이미 아는 영상이 나올 때까지만 받는다.
async function syncCatalog() {
  if (!state.apiKey || state.syncing) return;
  state.syncing = true;
  state.syncError = null;
  render();
  try {
    const cat = state.catalog;
    if (!cat.complete) {
      let token = cat.nextPageToken;
      do {
        const page = await fetchUploadsPage(token);
        addToCatalog(page.videos);
        token = page.nextPageToken;
        cat.nextPageToken = token;
        cat.complete = !token;
        persistCatalog();
        render();
      } while (token);
    } else {
      const known = new Set(cat.videos.map((v) => v.id));
      let token = null;
      for (let i = 0; i < MAX_REFRESH_PAGES; i++) {
        const page = await fetchUploadsPage(token);
        addToCatalog(page.videos);
        token = page.nextPageToken;
        if (!token || page.ids.some((id) => known.has(id))) break;
      }
    }
    cat.lastSync = Date.now();
    persistCatalog();
  } catch (err) {
    state.syncError = err;
  } finally {
    state.syncing = false;
    render();
  }
}

function syncIfStale() {
  const cat = state.catalog;
  if (!cat.complete || Date.now() - cat.lastSync > REFRESH_INTERVAL_MS) syncCatalog();
}

// ---------- list building ----------
function matchesQuery(video, tokens) {
  if (!tokens.length) return true;
  const title = (video.title || '').toLowerCase();
  return tokens.every((t) => title.includes(t));
}

function queryTokens() {
  return state.query.toLowerCase().split(/\s+/).filter(Boolean);
}

// 검색어와 업로드 날짜 필터를 통과한 채널 영상
function catalogList() {
  const tokens = queryTokens();
  const range = dateRange();
  const list = state.catalog.videos
    .filter((v) => inDateRange(v, range) && matchesQuery(v, tokens))
    .map(toVideo);
  const dir = state.sort === 'oldest' ? 1 : -1;
  return list.sort((a, b) => dir * (Date.parse(a.publishedAt) - Date.parse(b.publishedAt)));
}

// 시청 기록은 채널 목록과 무관하게 전체 기록에서 보여준다 (최근 본 순서)
function historyList(status) {
  const tokens = queryTokens();
  const range = dateRange();
  return Object.values(state.progress)
    .filter((rec) => statusOf(rec.id) === status && inDateRange(rec, range) && matchesQuery(rec, tokens))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function listsFor() {
  const all = catalogList();
  return {
    all,
    unwatched: all.filter((v) => statusOf(v.id) === 'unwatched'),
    watching: historyList('watching'),
    completed: historyList('completed'),
  };
}

const usesCatalog = () => state.filter === 'all' || state.filter === 'unwatched';

// ---------- rendering ----------
const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const message = $('#message');
const moreBtn = $('#more-btn');
const hint = $('#filter-hint');
const syncStatus = $('#sync-status');
const syncBtn = $('#sync-btn');
const sortSelect = $('#sort');
const cardTemplate = $('#card-template');

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function formatUploadDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatAgo(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

function renderCounts(lists) {
  document.querySelectorAll('[data-count]').forEach((el) => {
    const n = lists[el.dataset.count].length;
    el.textContent = n ? n.toLocaleString() : '';
  });
  document.querySelectorAll('.filter').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.filter === state.filter));
  });
}

function renderSyncStatus() {
  const cat = state.catalog;
  const total = cat.videos.length.toLocaleString();
  if (state.syncing) {
    syncStatus.textContent = cat.complete ? '새 영상 확인 중…' : `영상 목록 받는 중… ${total}개`;
  } else if (!state.apiKey) {
    syncStatus.textContent = cat.videos.length ? `저장된 영상 ${total}개` : '';
  } else if (!cat.complete && cat.videos.length) {
    syncStatus.textContent = `영상 ${total}개 (목록 일부만 받음)`;
  } else {
    syncStatus.textContent = cat.videos.length ? `영상 ${total}개 · ${formatAgo(cat.lastSync)} 확인` : '';
  }
  syncBtn.hidden = !state.apiKey;
  syncBtn.disabled = state.syncing;
  syncBtn.textContent = cat.complete ? '새 영상 확인' : '목록 이어받기';
}

function renderCard(video) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  const status = statusOf(video.id);
  const rec = state.progress[video.id];
  const duration = video.duration || rec?.duration || 0;

  node.dataset.status = status;
  node.querySelector('img').src = video.thumb;
  node.querySelector('.duration').textContent = duration ? formatTime(duration) : '';
  node.querySelector('.card-title').textContent = video.title;
  node.querySelector('.card-title').title = video.title;
  node.querySelector('.progress-fill').style.width = `${progressRatio(video.id) * 100}%`;

  const badge = node.querySelector('.badge');
  if (status !== 'unwatched') {
    badge.textContent = STATUS_LABEL[status];
    badge.classList.add(status);
  }

  const meta = [formatUploadDate(video.publishedAt)];
  if (video.channel && video.channel !== CHANNEL_NAME) meta.unshift(video.channel); // 예전 검색으로 본 다른 채널 영상
  if (status === 'watching' && rec) meta.push(`${formatTime(rec.position)} / ${formatTime(duration)} 시청`);
  node.querySelector('.card-meta').textContent = meta.filter(Boolean).join(' · ');

  const open = () => openPlayer(video);
  node.addEventListener('click', open);
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return node;
}

function showMessage(html, { error = false } = {}) {
  message.hidden = false;
  message.classList.toggle('error', error);
  message.innerHTML = html;
}

function errorText(err) {
  switch (err.reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      return '오늘의 YouTube API 사용량을 모두 썼습니다. 이미 받은 영상은 계속 볼 수 있고, 한국 시간 오후 4~5시(사용량 초기화) 이후에 다시 시도하면 이어서 받습니다.';
    case 'keyInvalid':
    case 'badRequest':
    case 'API_KEY_INVALID':
      return 'API 키가 올바르지 않습니다. 설정에서 키를 다시 확인해 주세요.';
    case 'accessNotConfigured':
    case 'forbidden':
    case 'PERMISSION_DENIED':
      return 'API 키에 YouTube Data API v3 사용이 허용되어 있지 않습니다. Google Cloud Console에서 API를 사용 설정해 주세요.';
    default:
      return `영상 목록을 받지 못했습니다: ${err.message}`;
  }
}

function render() {
  const lists = listsFor();
  renderCounts(lists);
  renderDateFilter();
  renderSyncStatus();
  grid.replaceChildren();
  message.hidden = true;
  sortSelect.hidden = !usesCatalog();
  sortSelect.value = state.sort;

  const period = dateLabel();
  const prefix = [period && `${period}에 업로드된`, state.query && `"${state.query}" 검색`].filter(Boolean).join(' · ');
  hint.textContent = (prefix ? `${prefix} · ` : '') + {
    all: 'Peppa Pig 공식 채널 영상',
    unwatched: '아직 보지 않은 영상',
    watching: '재생했지만 끝까지 보지 않은 영상 (최근 본 순서)',
    completed: '끝까지 본 영상 (최근 본 순서)',
  }[state.filter];

  const catalogEmpty = !state.catalog.videos.length;

  if (usesCatalog() && !state.apiKey && catalogEmpty) {
    showMessage(`
      <h3>YouTube API 키가 필요합니다</h3>
      <p>Peppa Pig 공식 채널의 영상 목록을 받으려면 YouTube Data API v3 키를 한 번만 등록해 주세요. 키는 이 브라우저에만 저장됩니다.</p>
      <button type="button" data-action="open-settings">API 키 등록하기</button>`);
    moreBtn.hidden = true;
    return;
  }

  if (state.syncError && !state.syncing) {
    showMessage(`<p>${errorText(state.syncError)}</p>
      <button type="button" data-action="retry">다시 시도</button>
      <button type="button" class="ghost" data-action="open-settings">설정</button>`, { error: true });
  }

  const videos = lists[state.filter];
  videos.slice(0, state.visibleCount).forEach((v) => grid.appendChild(renderCard(v)));

  if (usesCatalog() && state.syncing && catalogEmpty) {
    for (let i = 0; i < 8; i++) {
      const sk = document.createElement('div');
      sk.className = 'skeleton';
      grid.appendChild(sk);
    }
  }

  if (!videos.length && !(state.syncing && catalogEmpty) && !state.syncError) {
    const filtered = period || state.query;
    const empty = {
      all: filtered ? '조건에 맞는 영상이 없습니다. 검색어나 기간을 바꿔 보세요.' : '영상이 없습니다.',
      unwatched: lists.all.length ? '조건에 맞는 영상을 모두 시청했어요! 🎉' : '조건에 맞는 영상이 없습니다. 검색어나 기간을 바꿔 보세요.',
      watching: filtered ? '조건에 맞는 보고 있는 영상이 없습니다.' : '보고 있는 영상이 없습니다.',
      completed: filtered ? '조건에 맞는 끝까지 본 영상이 없습니다.' : '아직 끝까지 본 영상이 없습니다.',
    }[state.filter];
    showMessage(`<p>${empty}</p>`);
  }

  const remaining = videos.length - state.visibleCount;
  moreBtn.hidden = remaining <= 0;
  moreBtn.textContent = `더 보기 (${remaining.toLocaleString()}개 남음)`;
}

// 필터 조건이 바뀌면 처음부터 다시 그린다
function resetAndRender() {
  state.visibleCount = RENDER_STEP;
  render();
}

// ---------- upload date filter UI ----------
const dateSelects = {
  year: $('#f-year'),
  month: $('#f-month'),
  day: $('#f-day'),
  hour: $('#f-hour'),
};
const DATE_LEVELS = ['year', 'month', 'day', 'hour'];

function dateOptions(level) {
  const d = state.date;
  switch (level) {
    case 'year': {
      const years = [];
      for (let y = new Date().getFullYear(); y >= FIRST_YEAR; y--) years.push([String(y), `${y}년`]);
      return [['', '전체 연도'], ...years];
    }
    case 'month':
      return [['', '전체 월'], ...Array.from({ length: 12 }, (_, i) => [String(i + 1), `${i + 1}월`])];
    case 'day': {
      const days = d.year && d.month ? new Date(Number(d.year), Number(d.month), 0).getDate() : 31;
      return [['', '전체 일'], ...Array.from({ length: days }, (_, i) => [String(i + 1), `${i + 1}일`])];
    }
    default:
      return [['', '전체 시간'], ...Array.from({ length: 24 }, (_, i) => [String(i), `${i}시`])];
  }
}

function renderDateFilter() {
  DATE_LEVELS.forEach((level, i) => {
    const select = dateSelects[level];
    const options = dateOptions(level);
    if (select.options.length !== options.length) {
      select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    }
    select.value = state.date[level];
    // 상위 단계를 고른 뒤에만 하위 단계를 고를 수 있다 (년 → 월 → 일 → 시)
    select.disabled = i > 0 && state.date[DATE_LEVELS[i - 1]] === '';
    select.classList.toggle('active', state.date[level] !== '');
  });
  $('#date-reset').hidden = !state.date.year;
}

function setDateFilter(next) {
  // 상위 단계가 비면 하위 단계도 비운다
  const date = { ...next };
  DATE_LEVELS.forEach((level, i) => {
    if (i > 0 && date[DATE_LEVELS[i - 1]] === '') date[level] = '';
  });
  // 2월 30일처럼 존재하지 않는 날짜는 일/시 선택을 해제한다
  if (date.day && new Date(Number(date.year), Number(date.month), 0).getDate() < Number(date.day)) {
    date.day = '';
    date.hour = '';
  }
  if (DATE_LEVELS.every((l) => date[l] === state.date[l])) return;

  state.date = date;
  save(STORAGE.date, date);
  resetAndRender();
}

DATE_LEVELS.forEach((level) => {
  dateSelects[level].addEventListener('change', (e) => {
    setDateFilter({ ...state.date, [level]: e.target.value });
  });
});
$('#date-reset').addEventListener('click', () => setDateFilter(EMPTY_DATE));

sortSelect.addEventListener('change', () => {
  state.sort = sortSelect.value;
  save(STORAGE.sort, state.sort);
  resetAndRender();
});

// ---------- player ----------
const playerDialog = $('#player-dialog');
const playerTitle = $('#player-title');
const playerStatus = $('#player-status');
let player = null;
let current = null;     // 재생 중인 Video
let saveTimer = null;
let ytReady = null;

function loadYouTubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytReady = null; reject(new Error('YouTube 플레이어를 불러오지 못했습니다.')); };
    document.head.appendChild(s);
  });
  return ytReady;
}

function updatePlayerStatus() {
  if (!current) return;
  const status = statusOf(current.id);
  const rec = state.progress[current.id];
  const text = status === 'completed'
    ? '✅ 끝까지 본 영상'
    : status === 'watching'
      ? `▶ 보는 중 · ${formatTime(rec.position)} / ${formatTime(rec.duration)}`
      : '아직 안 본 영상';
  playerStatus.textContent = text;
  $('#mark-completed').disabled = status === 'completed';
}

function captureProgress({ forceComplete = false } = {}) {
  if (!player || !current || typeof player.getCurrentTime !== 'function') return;
  const position = player.getCurrentTime() || 0;
  const duration = player.getDuration() || current.duration || 0;
  const prev = state.progress[current.id];
  // 다 본 영상을 다시 볼 때는 기록을 덮어쓰지 않는다
  if (prev?.completed && !forceComplete) return;
  // 아주 잠깐 재생 후 닫은 경우 기록을 남기지 않는다
  if (!prev && position < WATCHING_MIN_SEC && !forceComplete) return;
  updateProgress(current, position, duration, { forceComplete });
  updatePlayerStatus();
}

async function openPlayer(video) {
  current = video;
  playerTitle.textContent = video.title;
  updatePlayerStatus();
  playerDialog.showModal();

  let YT;
  try {
    YT = await loadYouTubeApi();
  } catch (err) {
    playerStatus.textContent = err.message;
    return;
  }
  if (current !== video) return; // 로딩 중 닫힘

  const rec = state.progress[video.id];
  const start = rec && !rec.completed ? Math.floor(rec.position) : 0;

  // 이전 플레이어가 iframe으로 교체했던 자리를 새 div로 되돌린다
  const frame = playerDialog.querySelector('.player-frame');
  frame.replaceChildren(Object.assign(document.createElement('div'), { id: 'player' }));

  player = new YT.Player('player', {
    videoId: video.id,
    playerVars: { autoplay: 1, start, rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) {
          clearInterval(saveTimer);
          saveTimer = setInterval(captureProgress, SAVE_INTERVAL_MS);
        } else {
          clearInterval(saveTimer);
          if (e.data === YT.PlayerState.ENDED) captureProgress({ forceComplete: true });
          else if (e.data === YT.PlayerState.PAUSED) captureProgress();
        }
      },
      onError: () => {
        playerStatus.textContent = '이 영상은 앱에서 재생할 수 없습니다. (업로더가 외부 재생을 막았을 수 있어요)';
      },
    },
  });
}

function closePlayer() {
  clearInterval(saveTimer);
  captureProgress();
  try { player?.destroy(); } catch { /* noop */ }
  player = null;
  current = null;
  render();
}

playerDialog.addEventListener('close', closePlayer);
$('#player-close').addEventListener('click', () => playerDialog.close());
playerDialog.addEventListener('click', (e) => { if (e.target === playerDialog) playerDialog.close(); });

$('#mark-completed').addEventListener('click', () => {
  if (!current) return;
  const duration = player?.getDuration?.() || current.duration || state.progress[current.id]?.duration || 0;
  updateProgress(current, duration, duration, { forceComplete: true });
  updatePlayerStatus();
});

$('#reset-progress').addEventListener('click', () => {
  if (!current) return;
  delete state.progress[current.id];
  persistProgress();
  try { player?.seekTo(0, true); player?.pauseVideo(); } catch { /* noop */ }
  updatePlayerStatus();
});

// ---------- settings ----------
const settingsDialog = $('#settings-dialog');
const apiKeyInput = $('#api-key-input');

function openSettings() {
  apiKeyInput.value = state.apiKey;
  settingsDialog.showModal();
  apiKeyInput.focus();
}

$('#settings-btn').addEventListener('click', openSettings);

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
  const key = apiKeyInput.value.trim();
  if (key === state.apiKey) return;
  state.apiKey = key;
  save(STORAGE.apiKey, key);
  state.syncError = null;
  render();
  syncIfStale();
});

$('#clear-history').addEventListener('click', () => {
  const btn = $('#clear-history');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '한 번 더 누르면 삭제됩니다';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = '모든 시청 기록 삭제'; }, 3000);
    return;
  }
  state.progress = {};
  persistProgress();
  btn.dataset.confirm = '';
  btn.textContent = '삭제했습니다';
  render();
});

// ---------- wiring ----------
document.querySelectorAll('.filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.filter = btn.dataset.filter;
    save(STORAGE.filter, state.filter);
    resetAndRender();
  });
});

// 검색은 받아 둔 목록 안에서 하므로 입력하는 즉시 결과가 바뀐다 (API 사용량 없음)
const searchInput = $('#search-input');
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = searchInput.value.trim();
    resetAndRender();
  }, 150);
});
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(searchTimer);
  state.query = searchInput.value.trim();
  resetAndRender();
});

moreBtn.addEventListener('click', () => {
  state.visibleCount += RENDER_STEP;
  render();
});

syncBtn.addEventListener('click', () => syncCatalog());

message.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'open-settings') openSettings();
  if (action === 'retry') syncCatalog();
});

// 다른 탭에서 시청 기록이나 영상 목록이 바뀌면 반영
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE.progress) {
    state.progress = load(STORAGE.progress, {});
    render();
  } else if (e.key === STORAGE.catalog && !state.syncing) {
    state.catalog = { ...EMPTY_CATALOG, ...load(STORAGE.catalog, {}) };
    render();
  }
});

// 창을 닫을 때 재생 위치 저장
window.addEventListener('pagehide', () => captureProgress());

render();
syncIfStale();
