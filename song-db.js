// song-db.js — shared IndexedDB blob storage for uploaded songs.
// GD식 Song ID: 채보에는 id/메타만, 오디오 바이너리는 IndexedDB.
const SONG_DB_NAME = 'neonBeatSongDB';
const SONG_STORE = 'songs';

function openSongDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(SONG_DB_NAME, 1);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(SONG_STORE)){
        db.createObjectStore(SONG_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}

// 에디터의 곡 업로드 흐름에서만 쓰이지만, idbSaveSong이 이 모듈에 있으므로 함께 둔다.
function getAudioDuration(file){
  return new Promise((resolve)=>{
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = ()=>{
      const d = isFinite(a.duration) ? a.duration : 0;
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.onerror = ()=>{ URL.revokeObjectURL(url); resolve(0); };
    a.src = url;
  });
}

async function idbSaveSong(file){
  const id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const duration = await getAudioDuration(file);
  const record = {
    id,
    name: file.name || 'song',
    mime: file.type || 'audio/mpeg',
    blob: file,
    duration,
    addedAt: Date.now()
  };
  const db = await openSongDB();
  await new Promise((resolve, reject)=>{
    const tx = db.transaction(SONG_STORE, 'readwrite');
    tx.objectStore(SONG_STORE).put(record);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
  db.close();
  return { id, name: record.name, duration };
}

async function idbGetSong(id){
  if(!id) return null;
  const db = await openSongDB();
  const row = await new Promise((resolve, reject)=>{
    const tx = db.transaction(SONG_STORE, 'readonly');
    const req = tx.objectStore(SONG_STORE).get(id);
    req.onsuccess = ()=> resolve(req.result || null);
    req.onerror = ()=> reject(req.error);
  });
  db.close();
  return row;
}

async function idbListSongs(){
  const db = await openSongDB();
  const rows = await new Promise((resolve, reject)=>{
    const tx = db.transaction(SONG_STORE, 'readonly');
    const req = tx.objectStore(SONG_STORE).getAll();
    req.onsuccess = ()=> resolve(req.result || []);
    req.onerror = ()=> reject(req.error);
  });
  db.close();
  return rows.sort((a,b)=> (b.addedAt||0) - (a.addedAt||0));
}

async function idbDeleteSong(id){
  const db = await openSongDB();
  await new Promise((resolve, reject)=>{
    const tx = db.transaction(SONG_STORE, 'readwrite');
    tx.objectStore(SONG_STORE).delete(id);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
  db.close();
}
