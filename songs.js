/* טוען את רשימת השירים מ-songs.csv — משותף ל-index.html ול-cards.html.
   עמודות: מספר קלף, שנה, שם השיר, מבצע, קישורי יוטיוב, שנייה להתחלה (רשות), קישור ספוטיפיי (רשות)
   - קישור ספוטיפיי: ריק = האתר מחפש לבד לפי שם ומבצע. מדביקים קישור רק כדי לקבוע גרסה מסוימת.
   - קישורי יוטיוב: קישור מלא או מזהה, אפשר כמה (מופרדים ברווח) — הנוסף משמש גיבוי.
   - שנייה להתחלה: ריק = אוטומטי. */

const SETTINGS = {
  clipSeconds: 30,        // אורך הקטע שמתנגן
  extraSeconds: 15,       // כמה מוסיף הכפתור "+"
  csvFile: 'songs.csv',
  spotifyClientId: '8c809f5ee337468aafa6d9617754b172',
  spotifyRedirect: 'https://yopro1100p.github.io/hitster-il/',   // חייב להיות זהה ל-Redirect URI באפליקציית Spotify
};

function spotifyId(cell) {
  const m = (cell || '').match(/(?:track[/:])([A-Za-z0-9]{22})/) || (cell || '').trim().match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
}

function parseCSV(text) {
  const rows = []; let row = [], f = '', i = 0, q = false;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i += 2; continue; }
      if (c === '"' && /[,\r\n]/.test(text[i + 1] ?? '\n')) { q = false; i++; continue; }
      f += c; i++; continue;                       // גרש בודד בתוך טקסט (כמו הנח"ל) נשמר כמו שהוא
    }
    if (c === '"' && f === '') { q = true; i++; continue; }
    if (c === ',') { row.push(f); f = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; continue; }
    f += c; i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function youtubeIds(cell) {
  return (cell || '').split(/[\s|;]+/).map(s => {
    const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
    return m && m[1];
  }).filter(Boolean);
}

async function loadSongs() {
  const buf = await (await fetch(SETTINGS.csvFile, { cache: 'no-cache' })).arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('windows-1255').decode(buf); }   // CSV שנשמר מאקסל בקידוד עברי
  const songs = [], problems = [];
  parseCSV(text).slice(1).forEach((r, k) => {
    if (!r.some(x => x.trim())) return;
    const [n, y, t, a, yt, start, sp] = r.map(x => (x || '').trim());
    const s = { n: parseInt(n, 10), y: parseInt(y, 10), t, a, v: youtubeIds(yt),
                start: (start ?? '') === '' ? null : Number(start), sp: spotifyId(sp) };
    if (!s.n || !s.y || !s.t) problems.push(`שורה ${k + 2}: חסר מספר/שנה/שם`);
    else songs.push(s);   // בלי קישורים — יחופש אוטומטית ב-Spotify לפי שם ומבצע
  });
  const seen = new Set();
  songs.forEach(s => { if (seen.has(s.n)) problems.push(`מספר קלף ${s.n} מופיע פעמיים`); seen.add(s.n); });
  if (problems.length) console.warn('songs.csv:', problems);
  return { songs, problems };
}
