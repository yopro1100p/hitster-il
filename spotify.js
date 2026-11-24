/* חיבור ל-Spotify: התחברות (PKCE), חיפוש שירים, ונגינה בדפדפן (Web Playback SDK) או באפליקציית Spotify (Connect). */
const SP = (() => {
  const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
  const LS = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
               set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
               del: k => { try { localStorage.removeItem(k); } catch {} } };
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /* ---------- התחברות ---------- */
  async function login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    LS.set('sp_verifier', verifier); LS.set('sp_return', location.hash);
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: SETTINGS.spotifyClientId, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, redirect_uri: SETTINGS.spotifyRedirect });
  }
  async function tokenRequest(params) {
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: SETTINGS.spotifyClientId, ...params }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error_description || j.error || 'token error');
    LS.set('sp_access', j.access_token); LS.set('sp_expires', Date.now() + (j.expires_in - 60) * 1000);
    if (j.refresh_token) LS.set('sp_refresh', j.refresh_token);
  }
  /* נקרא בטעינת הדף: משלים התחברות אם חזרנו מ-Spotify. מחזיר את ה-hash שהיה לפני ההתחברות. */
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    if (!q.get('code') && !q.get('error')) return null;
    const ret = LS.get('sp_return') || '';
    if (q.get('code')) await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: SETTINGS.spotifyRedirect, code_verifier: LS.get('sp_verifier') });
    LS.del('sp_verifier'); LS.del('sp_return');
    history.replaceState(null, '', location.pathname + ret);
    return ret;
  }
  const connected = () => !!LS.get('sp_refresh');
  function logout() { ['sp_access', 'sp_expires', 'sp_refresh'].forEach(LS.del); }
  async function token() {
    if (!connected()) throw new Error('not connected');
    if (Date.now() > Number(LS.get('sp_expires') || 0)) await tokenRequest({ grant_type: 'refresh_token', refresh_token: LS.get('sp_refresh') });
    return LS.get('sp_access');
  }
  async function api(path, opts = {}) {
    const r = await fetch('https://api.spotify.com/v1' + path, { ...opts,
      headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (r.status === 204) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error(j?.error?.message || r.status); e.status = r.status; e.reason = j?.error?.reason; throw e; }
    return j;
  }

  /* ---------- חיפוש והתאמה ---------- */
  const norm = s => (s || '').normalize('NFC').replace(/[֑-ׇ]/g, '').replace(/[״"'׳`’.,!?()\[\]\-–_:]/g, ' ')
                             .toLowerCase().replace(/\s+/g, ' ').trim();
  const BAD = /(live|לייב|remix|רמיקס|karaoke|קריוקי|instrumental|cover|acoustic|אקוסטי|הופעה|sped up|slowed)/i;
  function score(tr, song) {
    const tt = norm(tr.name.replace(/\s*[-(].*$/, '')) || norm(tr.name), st = norm(song.t);
    let s = tt === st ? 4 : (tt.includes(st) || st.includes(tt)) ? 3 : 0;
    if (!s) { const a = new Set(st.split(' ')), b = tt.split(' '); const ov = b.filter(w => a.has(w)).length / Math.max(a.size, 1); s = ov >= .6 ? 2 : 0; }
    if (!s) return 0;
    const sa = norm(song.a);
    if (tr.artists.some(x => { const n = norm(x.name); return n && (sa.includes(n) || n.includes(sa)); })) s += 2;
    const y = parseInt(tr.album?.release_date, 10);
    if (y) { const d = Math.abs(y - song.y); s += d <= 1 ? 2 : d <= 4 ? 1 : 0; }
    if (BAD.test(tr.name) || BAD.test(tr.album?.name || '')) s -= 2;
    return s;
  }
  const pack = tr => ({ uri: tr.uri, id: tr.id, name: tr.name, artists: tr.artists.map(a => a.name).join(', '),
                        year: parseInt(tr.album?.release_date, 10) || null, durMs: tr.duration_ms });
  async function resolve(song, { fresh = false } = {}) {
    const key = `sp_match:${song.n}|${song.t}|${song.a}|${song.sp || ''}`;
    if (!fresh) { const c = LS.get(key); if (c) return JSON.parse(c); }
    let best = null;
    if (song.sp) best = { tr: await api('/tracks/' + song.sp), s: 99 };
    else {
      for (const q of [`${song.t} ${song.a}`, `track:${song.t} artist:${song.a}`, song.t]) {
        const r = await api('/search?' + new URLSearchParams({ q, type: 'track', limit: 10, market: 'from_token' }));
        for (const tr of r?.tracks?.items || []) { const s = score(tr, song); if (s >= 3 && (!best || s > best.s)) best = { tr, s }; }
        if (best && best.s >= 6) break;
      }
    }
    const res = best ? { ...pack(best.tr), score: best.s } : { notFound: true };
    LS.set(key, JSON.stringify(res));
    return res;
  }

  /* ---------- נגינה ---------- */
  let sdkPlayer = null, sdkDevice = null, sdkFailed = false, sdkLoading = null;
  function initSDK() {
    if (sdkLoading) return sdkLoading;
    sdkLoading = new Promise(res => {
      const done = ok => { if (!ok) sdkFailed = true; res(ok); };
      setTimeout(() => done(!!sdkDevice), 8000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        sdkPlayer = new Spotify.Player({ name: 'פסקול הזמן', volume: 0.9, getOAuthToken: cb => token().then(cb) });
        sdkPlayer.addListener('ready', ({ device_id }) => { sdkDevice = device_id; done(true); });
        sdkPlayer.addListener('not_ready', () => { sdkDevice = null; });
        sdkPlayer.addListener('autoplay_failed', () => api_.onAutoplayFailed?.());
        ['initialization_error', 'authentication_error', 'account_error'].forEach(ev => sdkPlayer.addListener(ev, () => done(false)));
        sdkPlayer.connect();
      };
      const s = document.createElement('script'); s.src = 'https://sdk.scdn.co/spotify-player.js'; s.onerror = () => done(false);
      document.head.appendChild(s);
    });
    return sdkLoading;
  }
  /* חייב לקרות בתוך לחיצה של המשתמש (מאפשר שמע בדפדפני טלפון) */
  function unlockAudio() { try { sdkPlayer?.activateElement(); } catch {} }

  let output = LS.get('sp_output') || 'browser';           // 'browser' או 'app'
  const setOutput = o => { output = o; LS.set('sp_output', o); };
  async function device() {
    if (output === 'browser' && !sdkFailed) { await initSDK(); if (sdkDevice) return { id: sdkDevice, browser: true }; }
    const { devices } = await api('/me/player/devices');
    const d = devices.find(x => x.is_active && x.id !== sdkDevice) || devices.find(x => /smartphone/i.test(x.type) && x.id !== sdkDevice)
           || devices.find(x => x.id !== sdkDevice) || devices[0];
    if (!d) { const e = new Error('no device'); e.noDevice = true; throw e; }
    return { id: d.id, browser: false, name: d.name };
  }
  let dev = null;
  async function playFrom(uri, sec) {
    dev = await device();
    const body = JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(sec * 1000)) });
    try { await api('/me/player/play?device_id=' + dev.id, { method: 'PUT', body }); }
    catch (e) {
      if (e.status !== 404) throw e;
      await api('/me/player', { method: 'PUT', body: JSON.stringify({ device_ids: [dev.id], play: false }) });
      await api('/me/player/play?device_id=' + dev.id, { method: 'PUT', body });
    }
    return dev;
  }
  async function pause() {
    if (dev?.browser && sdkPlayer) return sdkPlayer.pause();
    try { await api('/me/player/pause' + (dev ? '?device_id=' + dev.id : ''), { method: 'PUT' }); } catch {}
  }
  const api_ = { login, logout, handleRedirect, connected, resolve, initSDK, unlockAudio, playFrom, pause,
           get output() { return output; }, setOutput, get sdkFailed() { return sdkFailed; } };
  return api_;
})();
