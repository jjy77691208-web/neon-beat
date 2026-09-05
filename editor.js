(function(){
  // LANE_COLORS now comes from js/shared/canvas-utils.js
  const KEYS = ['D','F','J','K'];
  const STORAGE_KEY = 'neonBeatCustomChart';
  // SONG_DB_NAME / SONG_STORE now come from js/shared/song-db.js
  const PREP_MS = 2000;
  const BASE_APPROACH_MS = 900;

  // ==================== 안전한 로컬 저장소 접근 ====================
  // (makeSafeStorage now comes from js/shared/storage.js)
  const safeLS = makeSafeStorage('localStorage');
  const safeSS = makeSafeStorage('sessionStorage');

  // GD식 Song ID: 채보에는 id/메타만, 오디오 바이너리는 IndexedDB
  /** @type {{id:string,name:string,duration:number}|null} */
  let currentSong = null;

  // openSongDB / getAudioDuration / idbSaveSong / idbGetSong / idbListSongs /
  // idbDeleteSong now come from js/shared/song-db.js
  function formatBytes(n){
    if(!n || n < 0) return '?';
    if(n < 1024) return n + ' B';
    if(n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(1) + ' MB';
  }
  function refreshSongLabel(){
    const el = document.getElementById('song-label');
    if(!el) return;
    if(!currentSong){ el.textContent = '없음'; el.title = ''; return; }
    const sec = currentSong.duration ? (' · ' + Math.round(currentSong.duration) + 's') : '';
    el.textContent = (currentSong.name || currentSong.id) + sec;
    el.title = 'Song ID: ' + currentSong.id;
  }

  async function openSongLibrary(){
    const modal = document.getElementById('song-modal');
    const list = document.getElementById('song-list');
    if(!modal || !list) return;
    list.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:8px;">불러오는 중…</div>';
    modal.classList.add('show');
    let rows = [];
    try{ rows = await idbListSongs(); }
    catch(err){
      list.innerHTML = '<div style="color:#ff3d81;font-size:12px;">보관함 읽기 실패</div>';
      return;
    }
    if(!rows.length){
      list.innerHTML = '<div style="color:var(--dim);font-size:12px;padding:8px;">저장된 곡이 없습니다. 「새 파일 추가」로 넣어 주세요.</div>';
      return;
    }
    list.innerHTML = '';
    for(const row of rows){
      const size = row.blob && row.blob.size != null ? formatBytes(row.blob.size) : '?';
      const sec = row.duration ? Math.round(row.duration) + 's' : '?s';
      const item = document.createElement('div');
      item.className = 'song-item';
      item.innerHTML =
        '<div class="meta">' +
          '<div class="name"></div>' +
          '<div class="sub"></div>' +
        '</div>' +
        '<button type="button" class="pick">선택</button>' +
        '<button type="button" class="del danger">삭제</button>';
      item.querySelector('.name').textContent = row.name || row.id;
      item.querySelector('.sub').textContent = sec + ' · ' + size + ' · ' + row.id;
      item.querySelector('.pick').onclick = ()=>{
        currentSong = { id: row.id, name: row.name || row.id, duration: row.duration || 0 };
        refreshSongLabel();
        modal.classList.remove('show');
        flashStatus('곡 선택: ' + currentSong.name);
      };
      item.querySelector('.del').onclick = async ()=>{
        if(!confirm('이 곡을 브라우저에서 삭제할까요?\n' + (row.name || row.id))) return;
        try{
          await idbDeleteSong(row.id);
          if(currentSong && currentSong.id === row.id){
            currentSong = null;
            refreshSongLabel();
          }
          openSongLibrary();
        }catch(err){
          alert('삭제 실패');
        }
      };
      list.appendChild(item);
    }
  }
  const HIT_WINDOWS = { perfect:40, great:80, good:120, miss:150 };
  // Deliberately looser than the real game's HIT_WINDOWS (see
  // js/shared/canvas-utils.js). HOLD_SCORE, on the other hand, has no reason
  // to differ — the editor's test-play used to award a flat, untuned hold
  // score with no tick/tail grading at all, so it now shares the real game's
  // formula/weights (js/shared/gameplay.js) instead of quietly diverging.
  const HOLD_SCORE = DEFAULT_HOLD_SCORE;
  let speedRate = parseFloat(safeLS.get('neonBeatSpeed', '1')) || 1;
  speedRate = Math.max(0.75, Math.min(2, Math.round(speedRate * 20) / 20));
  function approachMs(){ return BASE_APPROACH_MS / speedRate; }

  // ===== 에디터 상태 =====
  let bpm = 176;
  let bars = 16;           // 한 마디 = 4박
  let snapDiv = 4;         // 1/4, 1/8, 1/16
  let tool = 'tap';         // tap | hold | erase | speed
  /** @type {{t:number, lane:number, hold?:number}[]} */
  let notes = [];
  /** @type {{t:number, rate:number}[]} 박 단위 속도 트리거 */
  let speedTriggers = [];
  let scrollBeat = 0;      // 화면 상단에 보이는 시작 박
  let pxPerBeat = 48;
  let spaceDown = false;
  /** Undo 스택 (노트 배열 JSON 스냅샷) */
  const undoStack = [];
  const UNDO_MAX = 60;
  function pushHistory(){
    try{
      undoStack.push(JSON.stringify({ notes, speedTriggers }));
      if(undoStack.length > UNDO_MAX) undoStack.shift();
    }catch(_){}
  }
  function undo(){
    if(undoStack.length === 0){
      flashStatus('되돌릴 작업 없음');
      return;
    }
    try{
      const snap = JSON.parse(undoStack.pop());
      if(Array.isArray(snap)){
        notes = snap;
      } else {
        notes = snap.notes || [];
        speedTriggers = snap.speedTriggers || [];
      }
    }catch(_){
      notes = [];
      speedTriggers = [];
    }
    sortNotes();
    sortTriggers();
    refreshStatus();
    drawEditor();
  }
  function sortTriggers(){
    speedTriggers.sort((a,b)=> a.t - b.t || a.rate - b.rate);
  }

  const canvas = document.getElementById('editor');
  const ctx = canvas.getContext('2d');
  const statusEl = document.getElementById('status');
  const bpmInput = document.getElementById('bpm');
  const barsInput = document.getElementById('bars');

  function beatMs(){ return 60000 / bpm; }
  function totalBeats(){ return bars * 4; }
  function maxHoldBeats(){ return 8; }
  function visibleBeats(){
    return Math.max(4, (H - padTop - padBot) / pxPerBeat);
  }
  function minScroll(){ return -1.5; } // 맨 위보다 조금 더 올라갈 수 있음
  function maxScroll(){
    // 마지막 노트 아래 여유를 두고, 위로는 항상 0 근처까지 돌아갈 수 있게
    return Math.max(0, totalBeats() - visibleBeats() * 0.35);
  }
  function clampScroll(v){
    return Math.max(minScroll(), Math.min(maxScroll(), v));
  }

  function snapBeat(b){
    const step = 1 / snapDiv;
    return Math.round(b / step) * step;
  }

  function refreshStatus(){
    const tr = speedTriggers.length ? (' · 속도트리거 ' + speedTriggers.length) : '';
    statusEl.textContent = '노트 ' + notes.length + tr;
  }

  // ===== 리사이즈 =====
  let W=0, H=0, dpr=1;
  // 테스트 플레이와 같은 시간→픽셀 비율
  // play: noteSpeed = travel/APPROACH_MS, 1박 높이 = beatMs * noteSpeed
  function syncScaleToPlay(){
    const judgeY = H * 0.78;
    const travel = Math.max(120, judgeY + 20);
    const noteSpeed = travel / approachMs(); // px per ms (속도 배율 반영)
    pxPerBeat = Math.max(36, beatMs() * noteSpeed);
  }
  function resizeEditor(){
    const wrap = document.getElementById('editor-wrap');
    const rect = wrap.getBoundingClientRect();
    const maxDpr = (window.innerWidth > window.innerHeight) ? 1.5 : 2;
    dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    W = Math.max(1, Math.floor(rect.width));
    H = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    syncScaleToPlay();
    _editorRect = null;
    drawEditor();
  }
  window.addEventListener('resize', resizeEditor);
  window.addEventListener('orientationchange', ()=> setTimeout(resizeEditor, 80));

  // ===== 좌표 변환 =====
  // 화면 y=0 이 위, 아래로 갈수록 과거(작은 beat)? 
  // GD 스타일: 보통 시간이 아래로 흐름. 여기서는 위에서 아래로 시간이 증가 (노트 낙하와 동일 감각).
  const padTop = 40;
  const padBot = 24;
  function laneLayout(){
    const landscape = W > H * 1.05;
    const totalW = landscape ? Math.min(W * 0.92, 640) : Math.min(W * 0.92, 400);
    const startX = (W - totalW) / 2;
    const laneW = totalW / 4;
    return { startX, laneW, totalW };
  }
  function beatToY(beat){
    // scrollBeat 가 화면 상단 근처
    return padTop + (beat - scrollBeat) * pxPerBeat;
  }
  function yToBeat(y){
    return scrollBeat + (y - padTop) / pxPerBeat;
  }
  function xToLane(x){
    const { startX, laneW } = laneLayout();
    if(x < startX || x > startX + laneW * 4) return -1;
    return Math.min(3, Math.max(0, Math.floor((x - startX) / laneW)));
  }

  // ===== 그리기 =====
  function drawEditor(){
    ctx.clearRect(0, 0, W, H);
    const { startX, laneW, totalW } = laneLayout();
    const tb = totalBeats();

    // 배경 레인
    for(let i=0;i<4;i++){
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(startX + i*laneW, 0, laneW, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(startX + i*laneW, 0);
      ctx.lineTo(startX + i*laneW, H);
      ctx.stroke();
      // 키 라벨
      ctx.fillStyle = LANE_COLORS[i];
      ctx.font = 'bold 12px Orbitron';
      ctx.textAlign = 'center';
      ctx.fillText(KEYS[i], startX + i*laneW + laneW/2, 18);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(startX, 0, totalW, H);

    // 비트 그리드
    const startB = Math.floor(scrollBeat) - 1;
    const endB = Math.ceil(scrollBeat + (H - padTop) / pxPerBeat) + 1;
    for(let b = startB; b <= endB; b++){
      if(b < 0 || b > tb) continue;
      const y = beatToY(b);
      const isBar = b % 4 === 0;
      const isBeat = Number.isInteger(b);
      ctx.strokeStyle = isBar ? 'rgba(63,224,255,0.35)' : isBeat ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
      ctx.lineWidth = isBar ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(startX + totalW, y);
      ctx.stroke();
      if(isBar){
        ctx.fillStyle = 'rgba(63,224,255,0.6)';
        ctx.font = '10px Orbitron';
        ctx.textAlign = 'right';
        ctx.fillText('M' + (b/4 + 1), startX - 6, y + 3);
      }
    }

    // 속도 트리거 표시 (타임라인 왼쪽 마커)
    for(const tr of speedTriggers){
      const y = beatToY(tr.t);
      if(y < -20 || y > H + 20) continue;
      ctx.strokeStyle = 'rgba(255,210,63,0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(startX + totalW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 배속 뱃지 (measureText는 프레임마다 텍스트 메트릭을 재계산하는 비용이 있어
      // 본게임처럼 고정 폭으로 바꿔 드래그/팬 중 반복 호출을 없앤다)
      const label = tr.rate.toFixed(2) + '×';
      ctx.font = 'bold 11px Orbitron';
      ctx.textAlign = 'left';
      const tw = 46;
      ctx.fillStyle = 'rgba(255,210,63,0.9)';
      ctx.fillRect(startX + totalW + 6, y - 10, tw, 18);
      ctx.fillStyle = '#1a1200';
      ctx.fillText(label, startX + totalW + 11, y + 4);
      // 왼쪽 삼각
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath();
      ctx.moveTo(startX - 4, y);
      ctx.lineTo(startX - 14, y - 8);
      ctx.lineTo(startX - 14, y + 8);
      ctx.closePath();
      ctx.fill();
    }

    // 노트
    for(const n of notes){
      const y = beatToY(n.t);
      const x = startX + n.lane * laneW + 6;
      const w = laneW - 12;
      const color = LANE_COLORS[n.lane];
      if(n.hold && n.hold > 0){
        const y2 = beatToY(n.t + n.hold);
        const top = Math.min(y, y2);
        const h = Math.abs(y2 - y);
        ctx.fillStyle = color + '66';
        roundRect(ctx, x + 4, top, w - 8, Math.max(h, 4), 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(x + w/2 - 1.5, top, 3, Math.max(h, 4));
        // tail
        ctx.fillStyle = color;
        roundRect(ctx, x + 2, y2 - 6, w - 4, 12, 4);
        ctx.fill();
      }
      // head (shadowBlur 제거: 드래그/팬 중 매 프레임 반복되는 가장 비싼 연산이라
      // 본게임 draw()와 동일하게 뺐다 — 대신 밝은 하이라이트 바로 입체감 유지)
      if(y > -20 && y < H + 20){
        ctx.fillStyle = color;
        roundRect(ctx, x, y - 8, w, 16, 5);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        roundRect(ctx, x + 3, y - 4, w - 6, 5, 2);
        ctx.fill();
      }
    }

    // 드래그 프리뷰
    if(drag){
      const y1 = beatToY(drag.startBeat);
      const y2 = beatToY(drag.curBeat);
      const x = startX + drag.lane * laneW + 6;
      const w = laneW - 12;
      const top = Math.min(y1, y2);
      const h = Math.max(4, Math.abs(y2 - y1));
      ctx.strokeStyle = LANE_COLORS[drag.lane];
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, top, w, h);
      ctx.setLineDash([]);
    }
  }

  // roundRect now comes from js/shared/canvas-utils.js

  // ===== 노트 조작 / 충돌 검사 =====
  // 같은 레인에서 시간 구간이 겹치면 불가능 (홀드 바디 위 단타·홀드 겹침 포함)
  function noteInterval(n){
    return { a: n.t, b: n.t + (n.hold || 0) };
  }
  function intervalsOverlap(a1, b1, a2, b2){
    // [a1,b1] 과 [a2,b2] 가 끝점만 맞닿는 것은 허용 (연속 배치)
    return a1 < b2 - 1e-9 && a2 < b1 - 1e-9;
  }
  function conflictsWith(lane, t, hold, ignore){
    const a = t;
    const b = t + (hold || 0);
    for(const n of notes){
      if(n === ignore) continue;
      if(n.lane !== lane) continue;
      const iv = noteInterval(n);
      if(intervalsOverlap(a, b, iv.a, iv.b)) return n;
    }
    return null;
  }

  function findNoteAt(beat, lane, tol){
    tol = tol == null ? (1 / snapDiv) * 0.6 : tol;
    let best = null, bestD = Infinity;
    for(const n of notes){
      if(n.lane !== lane) continue;
      const d = Math.abs(n.t - beat);
      if(d < tol && d < bestD){ best = n; bestD = d; }
      if(n.hold && beat >= n.t - tol && beat <= n.t + n.hold + tol){
        if(best !== n){ best = n; bestD = 0; }
      }
    }
    return best;
  }

  let placeFlash = '';
  function flashStatus(msg){
    placeFlash = msg;
    statusEl.textContent = msg;
    statusEl.style.color = '#ff3d81';
    clearTimeout(flashStatus._t);
    flashStatus._t = setTimeout(()=>{
      placeFlash = '';
      statusEl.style.color = '';
      refreshStatus();
    }, 1200);
  }

  function addTap(beat, lane){
    beat = snapBeat(beat);
    if(beat < 0 || beat > totalBeats()) return;
    const exist = notes.find(n => n.lane === lane && Math.abs(n.t - beat) < 1e-6);
    if(exist){
      pushHistory();
      notes = notes.filter(n => n !== exist);
      sortNotes();
      refreshStatus();
      drawEditor();
      return;
    }
    const hit = conflictsWith(lane, beat, 0, null);
    if(hit){
      flashStatus('겹침/홀드 위 배치 불가');
      return;
    }
    pushHistory();
    notes.push({ t: beat, lane });
    sortNotes();
    refreshStatus();
    drawEditor();
  }

  function addHold(startBeat, endBeat, lane){
    let a = snapBeat(Math.min(startBeat, endBeat));
    let b = snapBeat(Math.max(startBeat, endBeat));
    if(b - a < 1 / snapDiv) b = a + 1 / snapDiv;
    if(b - a > maxHoldBeats()) b = a + maxHoldBeats();
    if(a < 0) a = 0;
    if(b > totalBeats()) b = totalBeats();
    const hit = conflictsWith(lane, a, b - a, null);
    if(hit){
      flashStatus('겹치는 노트 있음 — 배치 불가');
      return;
    }
    pushHistory();
    notes.push({ t: a, lane, hold: b - a });
    sortNotes();
    refreshStatus();
    drawEditor();
  }

  function eraseAt(beat, lane){
    // 속도 트리거 우선 삭제
    const tr = findTriggerAt(beat);
    if(tr){
      pushHistory();
      speedTriggers = speedTriggers.filter(x => x !== tr);
      refreshStatus();
      drawEditor();
      return;
    }
    const n = findNoteAt(beat, lane);
    if(n){
      pushHistory();
      notes = notes.filter(x => x !== n);
      refreshStatus();
      drawEditor();
    }
  }

  function findTriggerAt(beat, tol){
    tol = tol == null ? (1 / snapDiv) * 0.75 : tol;
    let best = null, bestD = Infinity;
    for(const tr of speedTriggers){
      const d = Math.abs(tr.t - beat);
      if(d < tol && d < bestD){ best = tr; bestD = d; }
    }
    return best;
  }

  function addSpeedTrigger(beat){
    beat = snapBeat(beat);
    if(beat < 0 || beat > totalBeats()) return;
    const exist = findTriggerAt(beat, 1e-6);
    if(exist){
      // 같은 위치: 현재 툴바 속도로 갱신 / 같으면 삭제
      if(Math.abs(exist.rate - speedRate) < 1e-6){
        pushHistory();
        speedTriggers = speedTriggers.filter(x => x !== exist);
        flashStatus('속도 트리거 삭제');
      } else {
        pushHistory();
        exist.rate = speedRate;
        flashStatus('속도 트리거 → ' + speedRate.toFixed(2) + '×');
      }
      sortTriggers();
      refreshStatus();
      drawEditor();
      return;
    }
    pushHistory();
    speedTriggers.push({ t: beat, rate: speedRate });
    sortTriggers();
    refreshStatus();
    drawEditor();
    flashStatus(speedRate.toFixed(2) + '× @ ' + beat + '박');
  }

  function sortNotes(){
    notes.sort((a,b)=> a.t - b.t || a.lane - b.lane);
  }

  // sanitizeNotes now comes from js/shared/chart-format.js

  // ===== 포인터 =====
  let drag = null;
  let panning = false;
  let panStartY = 0;
  let panStartScroll = 0;
  const activePointers = new Map(); // multi-touch 팬

  let _editorRect = null;
  function clientToLocal(e){
    // getBoundingClientRect()는 강제 리플로우를 유발한다.
    // 드래그/팬 중 pointermove가 초당 수십 번 발생하므로 매번 다시 읽지 않고
    // resize 시점에만 캐시한다 (본게임과 동일한 최적화).
    if(!_editorRect) _editorRect = canvas.getBoundingClientRect();
    const r = _editorRect;
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function beginPan(y){
    panning = true;
    panStartY = y;
    panStartScroll = scrollBeat;
  }

  canvas.addEventListener('pointerdown', e=>{
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = clientToLocal(e);
    activePointers.set(e.pointerId, { x, y });
    const lane = xToLane(x);
    const beat = yToBeat(y);

    // 두 손가락 → 스크롤
    if(activePointers.size >= 2){
      drag = null;
      beginPan(y);
      return;
    }
    // 가운데 버튼 / Alt / Space / 레인 밖 → 스크롤
    if(e.button === 1 || e.altKey || spaceDown || lane < 0){
      beginPan(y);
      return;
    }
    if(e.button === 2 || tool === 'erase'){
      eraseAt(beat, lane >= 0 ? lane : 0);
      return;
    }
    if(tool === 'speed'){
      addSpeedTrigger(beat);
      return;
    }
    if(lane < 0) return;
    if(tool === 'hold'){
      drag = { lane, startBeat: snapBeat(beat), curBeat: snapBeat(beat) };
      drawEditor();
      return;
    }
    addTap(beat, lane);
  });

  let _drawScheduled = false;
  function scheduleDraw(){
    // pointermove는 화면 주사율보다 훨씬 자주 발생할 수 있어(터치 폴링레이트),
    // 매번 즉시 drawEditor()를 부르면 중복 렌더링이 쌓인다.
    // rAF로 한 프레임에 한 번만 그리도록 묶는다 (드래그/팬 중 체감 차이가 크다).
    if(_drawScheduled) return;
    _drawScheduled = true;
    requestAnimationFrame(()=>{ _drawScheduled = false; drawEditor(); });
  }

  canvas.addEventListener('pointermove', e=>{
    const { x, y } = clientToLocal(e);
    if(activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x, y });
    if(panning){
      const dy = y - panStartY;
      // 손가락/마우스를 아래로 → 차트 위쪽(이전 박)으로 스크롤
      scrollBeat = clampScroll(panStartScroll - dy / pxPerBeat);
      scheduleDraw();
      return;
    }
    if(drag){
      drag.curBeat = snapBeat(yToBeat(y));
      scheduleDraw();
    }
  });

  canvas.addEventListener('pointerup', e=>{
    activePointers.delete(e.pointerId);
    if(panning){
      // 한 손 남으면 팬 종료, 두 손이었다면 한쪽 떼도 종료
      if(activePointers.size < 2) panning = false;
      return;
    }
    if(drag){
      addHold(drag.startBeat, drag.curBeat, drag.lane);
      drag = null;
      drawEditor();
    }
  });

  canvas.addEventListener('pointercancel', e=>{
    activePointers.delete(e.pointerId);
    panning = false; drag = null; drawEditor();
  });

  canvas.addEventListener('contextmenu', e=> e.preventDefault());

  canvas.addEventListener('wheel', e=>{
    e.preventDefault();
    // 트랙패드/마우스 휠 정규화 (위로 스크롤 = 이전 박으로)
    let dy = e.deltaY;
    if(e.deltaMode === 1) dy *= 16;      // lines → px 대략
    if(e.deltaMode === 2) dy *= H;       // pages
    // 감도: 픽셀 기준 → 박
    scrollBeat = clampScroll(scrollBeat + dy / pxPerBeat);
    drawEditor();
  }, { passive:false });

  window.addEventListener('keydown', e=>{
    if(e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){
      e.preventDefault();
      undo();
      return;
    }
    if(e.code === 'Space' && !e.repeat){
      e.preventDefault();
      spaceDown = true;
    }
    if(e.key === 'ArrowUp'){
      e.preventDefault();
      scrollBeat = clampScroll(scrollBeat - 1);
      drawEditor();
    }
    if(e.key === 'ArrowDown'){
      e.preventDefault();
      scrollBeat = clampScroll(scrollBeat + 1);
      drawEditor();
    }
  });
  window.addEventListener('keyup', e=>{
    if(e.code === 'Space') spaceDown = false;
  });

  // ===== 툴바 =====
  function setTool(t){
    tool = t;
    [['tool-tap','tap'],['tool-hold','hold'],['tool-speed','speed'],['tool-erase','erase']].forEach(([id,val])=>{
      const el = document.getElementById(id);
      if(!el) return;
      const on = t === val;
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', String(on));
    });
  }
  document.getElementById('tool-tap').onclick = ()=> setTool('tap');
  document.getElementById('tool-hold').onclick = ()=> setTool('hold');
  document.getElementById('tool-speed').onclick = ()=> setTool('speed');
  document.getElementById('tool-erase').onclick = ()=> setTool('erase');

  function setSnap(d){
    snapDiv = d;
    ['4','8','16'].forEach(s=>{
      const el = document.getElementById('snap-'+s);
      const on = String(d)===s;
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', String(on));
    });
  }
  document.getElementById('snap-4').onclick = ()=> setSnap(4);
  document.getElementById('snap-8').onclick = ()=> setSnap(8);
  document.getElementById('snap-16').onclick = ()=> setSnap(16);

  bpmInput.onchange = ()=>{
    bpm = Math.max(60, Math.min(300, parseInt(bpmInput.value,10)||176));
    bpmInput.value = bpm;
    syncScaleToPlay();
    drawEditor();
  };
  barsInput.onchange = ()=>{
    bars = Math.max(4, Math.min(64, parseInt(barsInput.value,10)||16));
    barsInput.value = bars;
    scrollBeat = clampScroll(scrollBeat);
    drawEditor();
  };

  document.getElementById('scroll-up').onclick = ()=>{
    scrollBeat = clampScroll(scrollBeat - visibleBeats() * 0.4);
    drawEditor();
  };
  document.getElementById('scroll-down').onclick = ()=>{
    scrollBeat = clampScroll(scrollBeat + visibleBeats() * 0.4);
    drawEditor();
  };

  function refreshSpeedLabel(){
    const el = document.getElementById('speed-label');
    if(el) el.textContent = speedRate.toFixed(2) + '×';
  }
  function changeSpeed(delta){
    speedRate = Math.max(0.75, Math.min(2, Math.round((speedRate + delta) * 20) / 20));
    safeLS.set('neonBeatSpeed', String(speedRate));
    refreshSpeedLabel();
    syncScaleToPlay();
    drawEditor();
  }
  document.getElementById('speed-minus').onclick = ()=> changeSpeed(-0.05);
  document.getElementById('speed-plus').onclick = ()=> changeSpeed(0.05);
  refreshSpeedLabel();

  document.getElementById('btn-clear').onclick = ()=>{
    if((notes.length || speedTriggers.length) && !confirm('모든 노트·속도 트리거를 지울까요?')) return;
    pushHistory();
    notes = [];
    speedTriggers = [];
    refreshStatus();
    drawEditor();
  };
  document.getElementById('btn-undo').onclick = ()=> undo();
  document.getElementById('btn-help').onclick = ()=>{
    const m = document.getElementById('help-modal');
    if(m) m.classList.add('show');
  };
  document.getElementById('help-close').onclick = ()=>{
    const m = document.getElementById('help-modal');
    if(m) m.classList.remove('show');
  };

  // ===== Song ID: 브라우저 보관함에서 선택 (파일은 추가용) =====
  const songFileInput = document.getElementById('song-file');
  document.getElementById('btn-song-lib').onclick = ()=> openSongLibrary();
  document.getElementById('btn-song-clear').onclick = ()=>{
    currentSong = null;
    refreshSongLabel();
    flashStatus('음악 제거됨');
  };
  const songModal = document.getElementById('song-modal');
  document.getElementById('song-modal-close').onclick = ()=> songModal && songModal.classList.remove('show');
  document.getElementById('song-modal-file').onclick = ()=>{
    // 모달은 유지한 채 파일 선택 → 추가 후 목록 갱신
    if(songFileInput) songFileInput.click();
  };
  if(songFileInput){
    songFileInput.addEventListener('change', async ()=>{
      const file = songFileInput.files && songFileInput.files[0];
      songFileInput.value = '';
      if(!file) return;
      try{
        statusEl.textContent = '음악 저장 중…';
        currentSong = await idbSaveSong(file);
        refreshSongLabel();
        flashStatus('브라우저에 저장·선택됨');
        // 보관함이 열려 있으면 목록 새로고침
        if(songModal && songModal.classList.contains('show')) openSongLibrary();
      }catch(err){
        alert('음악 저장 실패: '+(err && err.message ? err.message : err));
      }
    });
  }
  refreshSongLabel();

  // ===== 저장 / 불러오기 =====
  // 압축 형식 예: 1.30-4-0@0,1@0.5,2@1:1.5,3@2|176|16
  //  = 속도 1.30 · 노트 4개 · lane@beat(:hold) · BPM · 마디
  function chartObject(){
    const clean = sanitizeNotes(notes);
    const o = {
      version: CHART_FORMAT_VERSION,
      name: 'Custom Chart',
      bpm: bpm,
      bars: bars,
      speed: speedRate,
      notes: clean.map(n=>{
        const x = { t: Math.round(n.t * 1000)/1000, lane: n.lane };
        if(n.hold) x.hold = Math.round(n.hold * 1000)/1000;
        return x;
      }),
      speedTriggers: speedTriggers.map(tr=>({
        t: Math.round(tr.t * 1000)/1000,
        rate: Math.round(tr.rate * 100)/100
      }))
    };
    if(currentSong){
      o.songId = currentSong.id;
      o.songName = currentSong.name;
      o.songDuration = currentSong.duration;
    }
    return o;
  }

  // encodeCompact/parseChartText below are thin wrappers around the shared
  // js/shared/chart-format.js implementations, keeping this file's existing
  // call sites (encodeCompact(data), parseChartText(text)) unchanged while
  // passing this app's fallback bpm/bars/speed and strict:true (the editor
  // throws on malformed input instead of silently dropping it, per the
  // modularization report).
  function encodeCompact(data){
    return window.encodeCompact(data, speedRate, bpm, bars);
  }

  function parseChartText(text){
    return window.parseChartText(text, { bpm, bars, strict: true });
  }

  function applyChart(data, opts){
    if(!data || !Array.isArray(data.notes)) throw new Error('잘못된 차트 형식');
    if(!opts || !opts.noHistory) pushHistory();
    // 수동 입력(bpmInput/barsInput onchange)과 동일한 범위로 방어적 클램프.
    // 가져오기/불러오기 경로는 이 클램프를 거치지 않았어서, bpm이 0/음수/비정상이면
    // beatMs()=60000/bpm 이 Infinity·NaN이 되어 캔버스 전체가 빈 화면으로 깨질 수 있었다.
    const bpmRaw = Number(data.bpm);
    bpm = (isFinite(bpmRaw) && bpmRaw > 0) ? Math.max(60, Math.min(300, bpmRaw)) : 176;
    const barsRaw = Number(data.bars);
    bars = (isFinite(barsRaw) && barsRaw > 0) ? Math.max(4, Math.min(64, Math.round(barsRaw))) : 16;
    if(data.speed != null && isFinite(data.speed)){
      speedRate = Math.max(0.75, Math.min(2, data.speed));
      safeLS.set('neonBeatSpeed', String(speedRate));
      if(typeof refreshSpeedLabel === 'function') refreshSpeedLabel();
      if(typeof syncScaleToPlay === 'function') syncScaleToPlay();
    }
    if(data.songId){
      currentSong = {
        id: data.songId,
        name: data.songName || data.songId,
        duration: data.songDuration || 0
      };
    } else {
      currentSong = null;
    }
    refreshSongLabel();
    bpmInput.value = bpm;
    barsInput.value = bars;
    const before = data.notes.length;
    notes = sanitizeNotes(data.notes);
    sortNotes();
    speedTriggers = Array.isArray(data.speedTriggers)
      ? data.speedTriggers.map(tr=>({
          t: Number(tr.t),
          rate: Math.max(0.75, Math.min(2, Number(tr.rate) || 1))
        })).filter(tr=>isFinite(tr.t))
      : [];
    sortTriggers();
    refreshStatus();
    drawEditor();
    if(notes.length < before){
      flashStatus('겹침 '+(before-notes.length)+'개 제거됨');
    }
  }

  function persistChart(data){
    const json = JSON.stringify(data);
    const compact = encodeCompact(data);
    const ok1 = safeLS.set(STORAGE_KEY, json);
    const ok2 = safeSS.set(STORAGE_KEY, json);
    safeSS.set(STORAGE_KEY + 'Compact', compact);
    safeLS.set('neonBeatCustomChartReady', '1');
    return { json, compact, saved: ok1 || ok2 };
  }

  /** file:// 에서도 동작: URL 해시로 차트 전달 */
  function chartToHash(data){
    const compact = encodeCompact(data);
    // ASCII only → btoa 안전
    try{
      return '#c=' + encodeURIComponent(btoa(compact));
    }catch(_){
      return '#c=' + encodeURIComponent(compact);
    }
  }

  document.getElementById('btn-save').onclick = ()=>{
    const data = chartObject();
    if(!data.notes.length){ alert('저장할 노트가 없습니다.'); return; }
    const result = persistChart(data);
    if(result.saved){
      alert('저장됨.\n· 같은 브라우저면 게임에서 「커스텀 차트 플레이」\n· 안 되면 「게임으로」를 쓰거나 내보내기 코드를 붙여넣으세요.');
    } else {
      alert('브라우저 저장소에 저장하지 못했습니다(용량 초과 또는 저장소 차단).\n대신 「내보내기」로 코드를 복사해 두거나 「게임으로」를 사용하세요.');
    }
  };

  document.getElementById('btn-load').onclick = ()=>{
    const raw = safeLS.get(STORAGE_KEY, null) || safeSS.get(STORAGE_KEY, null);
    if(!raw){ alert('저장된 차트가 없습니다.'); return; }
    try{
      applyChart(typeof raw === 'string' && raw[0] === '{' ? JSON.parse(raw) : parseChartText(raw));
    }catch(err){ alert('불러오기 실패: '+err.message); }
  };

  document.getElementById('btn-to-game').onclick = ()=>{
    if(notes.length === 0){ alert('노트를 먼저 배치하세요.'); return; }
    const data = chartObject();
    persistChart(data);
    // 해시로 넘겨 file:// localStorage 분리 문제 회피
    location.href = 'game.html' + chartToHash(data);
  };

  const ioModal = document.getElementById('io-modal');
  const ioText = document.getElementById('io-text');
  const ioTitle = document.getElementById('io-title');
  let ioMode = 'export';

  document.getElementById('btn-export').onclick = ()=>{
    ioMode = 'export';
    ioTitle.textContent = '내보내기 (압축 / JSON)';
    const data = chartObject();
    ioText.value = encodeCompact(data) + '\n\n' + JSON.stringify(data, null, 2);
    ioModal.classList.add('show');
  };
  document.getElementById('btn-import').onclick = ()=>{
    ioMode = 'import';
    ioTitle.textContent = '가져오기 (압축 또는 JSON)';
    ioText.value = '';
    ioModal.classList.add('show');
  };
  document.getElementById('io-cancel').onclick = ()=> ioModal.classList.remove('show');
  document.getElementById('io-ok').onclick = ()=>{
    if(ioMode === 'export'){
      // 압축 한 줄만 복사
      const line = ioText.value.split('\n')[0];
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(line).then(()=>{
          alert('압축 코드 복사됨:\n'+line);
        }).catch(()=>{
          ioText.select();
          alert('클립보드 복사에 실패했습니다. 선택된 텍스트를 직접 복사해 주세요.');
        });
      } else {
        ioText.select();
      }
      ioModal.classList.remove('show');
      return;
    }
    try{
      let text = ioText.value.trim();
      if(!text) throw new Error('내용이 비어 있습니다');
      // '{' 가 있으면 그 지점부터를 JSON으로 우선 파싱한다(내보내기 형식과 정확히 일치).
      // 압축 줄에 우연히 '-'가 들어가는 경우(예: 곡 이름)에도 안전하게 동작한다.
      const jsonStart = text.indexOf('{');
      const data = jsonStart !== -1
        ? JSON.parse(text.slice(jsonStart))
        : parseChartText(text.split('\n')[0].trim());
      applyChart(data);
      ioModal.classList.remove('show');
    }catch(err){
      alert('가져오기 실패: '+err.message);
    }
  };

  // ===== 플레이 테스트 =====
  const playOverlay = document.getElementById('play-overlay');
  const playCanvas = document.getElementById('play-canvas');
  const pctx = playCanvas.getContext('2d');
  let playing = false, playRAF = 0;
  let pW=0, pH=0, pJudgeY=0, pLaneW=0;
  let pTravelPx = 400, pScrollK = 0, curPScroll = 0;
  // ===== 속도 트리거용 스크롤-시간 적분 (본 게임과 동일한 방식, js/shared/speed-scroll.js) =====
  // 노트 위치를 "현재 배속 × 남은시간"으로 직접 계산하면, 트리거로 배속이
  // 바뀌는 순간 화면 위 노트마다 남은시간이 달라서 서로 다른 비율로 튀어
  // 노트 사이 간격이 일그러진다. 대신 시간 t까지의 누적 스크롤량을 구간별로
  // 적분해두고, 각 노트는 스폰 시 자신의 hitTime에 해당하는 스크롤값을 한 번만
  // 캐싱한다. 그러면 트리거 순간에도 위치가 끊기지 않고 간격이 항상 유지된다.
  // Own timeline instance — independent from the real game's (see report:
  // "Independent timelines", each app must own its own createSpeedTimeline()).
  const editorSpeedTimeline = createSpeedTimeline();
  let pScrollAtSpawn = (t)=>t;
  let pScrollAtNow = (t)=>t;
  function buildPSpeedSegments(startRate, triggersMs){
    editorSpeedTimeline.build(startRate, triggersMs);
    pScrollAtSpawn = editorSpeedTimeline.makeScroller();
    pScrollAtNow = editorSpeedTimeline.makeScroller();
  }
  let pNotes = [], pSongTime = 0, pStart = 0;
  let pScore=0, pCombo=0, pHits=0, pJudged=0;
  const pKeys = {0:false,1:false,2:false,3:false};
  let audioCtx = null, masterGain = null;
  let pMusic = null, pMusicUrl = null, pMusicStarted = false;

  function initAudio(){
    if(audioCtx) return;
    try{
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 0.3;
      masterGain.connect(audioCtx.destination);
    }catch(_){
      audioCtx = null;
      masterGain = null;
    }
  }
  function beep(t, freq, dur){
    if(!audioCtx) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.type = 'square';
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t+dur);
    o.connect(g); g.connect(masterGain);
    o.start(t); o.stop(t+dur);
  }

  function resizePlay(){
    const wrap = document.getElementById('play-canvas-wrap');
    const r = wrap.getBoundingClientRect();
    const maxDpr = (window.innerWidth > window.innerHeight) ? 1.5 : 2;
    const d = Math.min(window.devicePixelRatio||1, maxDpr);
    pW = Math.floor(r.width); pH = Math.floor(r.height);
    playCanvas.width = Math.floor(pW*d);
    playCanvas.height = Math.floor(pH*d);
    playCanvas.style.width = pW+'px';
    playCanvas.style.height = pH+'px';
    pctx.setTransform(d,0,0,d,0,0);
    const landscape = pW > pH * 1.05;
    if(landscape){
      const trackW = Math.min(pW * 0.88, pH * 2.2);
      pLaneW = trackW / 4;
      pJudgeY = pH * 0.70;
    } else {
      pLaneW = Math.min(90, pW * 0.2);
      pJudgeY = pH * 0.78;
    }
    pTravelPx = Math.max(100, pJudgeY - 40);
    pScrollK = pTravelPx / BASE_APPROACH_MS;
  }

  async function startPlay(){
    if(notes.length === 0){ alert('노트를 먼저 배치하세요.'); return; }
    initAudio();
    // 이전 음악 정리
    if(pMusic){ try{ pMusic.pause(); }catch(_){ } pMusic = null; }
    if(pMusicUrl){ URL.revokeObjectURL(pMusicUrl); pMusicUrl = null; }
    pMusicStarted = false;
    // 음악·노트 준비 후 시계 시작 (시작 렉 완화)
    if(currentSong && currentSong.id){
      try{
        const row = await idbGetSong(currentSong.id);
        if(row && row.blob){
          pMusicUrl = URL.createObjectURL(row.blob);
          pMusic = new Audio(pMusicUrl);
          pMusic.preload = 'auto';
          try{ pMusic.load(); }catch(_){}
        } else {
          flashStatus('Song ID 오디오 없음 (다시 불러오기)');
        }
      }catch(_){ flashStatus('음악 로드 실패'); }
    }
    if(audioCtx && audioCtx.state === 'suspended'){
      try{ await audioCtx.resume(); }catch(_){}
    }
    const bm = beatMs();
    pScore=0; pCombo=0; pHits=0; pJudged=0;
    pSongTime=0;
    for(const k in pKeys) pKeys[k]=false;
    // 속도 트리거 (ms, PREP 포함)
    pPlaySpeed = speedRate;
    pSpeedTriggersMs = speedTriggers.map(tr=>({
      t: PREP_MS + tr.t * bm,
      rate: Math.max(0.75, Math.min(2, tr.rate))
    })).sort((a,b)=>a.t-b.t);
    pTriggerIdx = 0;
    // 스크롤 적분 세그먼트 구성 (트리거를 지나도 노트 간 간격이 뒤틀리지 않게 함)
    buildPSpeedSegments(pPlaySpeed, pSpeedTriggersMs);
    pNotes = notes.map(n=>{
      const hitTime = PREP_MS + n.t * bm;
      const holdDur = n.hold ? n.hold * bm : 0;
      const holdEndTime = hitTime + holdDur;
      return {
        lane: n.lane,
        hitTime,
        holdDur,
        isHold: !!n.hold,
        holdEndTime,
        hitScroll: pScrollAtSpawn(hitTime),
        tailScroll: n.hold ? pScrollAtSpawn(holdEndTime) : 0,
        judged: false, hit: false, holding: false,
        y: 0, tailY: 0
      };
    });
    playing = true;
    playOverlay.classList.add('show');
    resizePlay();
    pLastTs = 0;
    updatePlayHUD();
    // 한 프레임 양보 후 시계 시작
    cancelAnimationFrame(playRAF);
    requestAnimationFrame(()=>{
      pStart = performance.now();
      playRAF = requestAnimationFrame(playLoop);
    });
  }

  function stopPlay(){
    playing = false;
    cancelAnimationFrame(playRAF);
    if(pMusic){ try{ pMusic.pause(); }catch(_){ } pMusic = null; }
    if(pMusicUrl){ URL.revokeObjectURL(pMusicUrl); pMusicUrl = null; }
    pMusicStarted = false;
    playOverlay.classList.remove('show');
  }

  function updatePlayHUD(){
    document.getElementById('p-score').textContent = pScore;
    document.getElementById('p-combo').textContent = pCombo;
    const acc = pJudged===0 ? 100 : Math.round(pHits/pJudged*100);
    document.getElementById('p-acc').textContent = acc+'%';
    const sp = document.getElementById('p-speed');
    if(sp) sp.textContent = (pPlaySpeed || speedRate).toFixed(2) + '×';
  }

  function playTryHit(lane){
    if(!playing) return;
    let best=null, bestDiff=Infinity, bestSigned=0;
    for(const n of pNotes){
      if(n.lane!==lane || n.judged || n.holding) continue;
      const signed = pSongTime - n.hitTime;
      const d = Math.abs(signed);
      if(d <= HIT_WINDOWS.miss && d < bestDiff){ best=n; bestDiff=d; bestSigned=signed; }
    }
    if(!best){
      pJudged++; pCombo=0; pScore=Math.max(0,pScore-30);
      updatePlayHUD(); return;
    }
    // Formula shared with the real game (js/shared/gameplay.js) — this app
    // just supplies its own (looser) HIT_WINDOWS.
    const ev = judgeDelta(bestSigned, HIT_WINDOWS);
    const pts = ev ? ev.points : 50;
    if(best.isHold){
      best.holding = true;
      best.headHit = true;
      best.headMult = holdHeadMult(ev ? ev.judge : 'BAD');
      best.nextTick = best.hitTime + beatMs() * 0.5;
      pCombo++;
      pScore += Math.round(pts * HOLD_SCORE.headScale) + Math.min(pCombo,50)*2;
    } else {
      best.judged=true; best.hit=true;
      pJudged++; pHits++; pCombo++;
      pScore+=pts+Math.min(pCombo,50)*2;
    }
    updatePlayHUD();
    beep(audioCtx.currentTime, 600+lane*80, 0.06);
  }

  let pTriggerIdx = 0;
  let pPlaySpeed = 1;
  let pSpeedTriggersMs = [];
  let pLastTs = 0;

  function playLoop(ts){
    if(!playing) return;
    if(!pLastTs) pLastTs = ts || performance.now();
    const frameDt = Math.min(50, (ts || performance.now()) - pLastTs);
    pLastTs = ts || performance.now();
    const elapsed = performance.now() - pStart;
    if(pMusic){
      if(elapsed >= PREP_MS && !pMusicStarted){
        pMusicStarted = true;
        const a = pMusic;
        requestAnimationFrame(()=>{
          try{ a.currentTime = 0; a.play().catch(()=>{}); }catch(_){}
        });
      }
      if(pMusicStarted && !pMusic.paused){
        pSongTime = PREP_MS + pMusic.currentTime * 1000;
      } else {
        pSongTime = elapsed;
      }
    } else {
      pSongTime = elapsed;
    }
    // 속도 트리거: 통과 시 배속 갱신 (표시용 pPlaySpeed만 갱신 — 실제 위치는
    // 스크롤 적분값 차이로 계산하므로 노트 간 거리는 항상 그대로 유지된다)
    while(pTriggerIdx < pSpeedTriggersMs.length && pSongTime >= pSpeedTriggersMs[pTriggerIdx].t){
      const tr = pSpeedTriggersMs[pTriggerIdx];
      pPlaySpeed = Math.max(0.75, Math.min(2, Number(tr.rate) || 1));
      pTriggerIdx++;
      updatePlayHUD();
    }
    // 위치 + 홀드 + 미스 단일 패스
    // (본 게임과 동일하게: 화면 가시 범위로 위치 갱신을 건너뛰지 않는다.
    //  트리거로 pPlaySpeed가 바뀌면 그 범위도 매 프레임 바뀌어서, 갱신을
    //  건너뛴 노트가 낡은 위치에 멈춰있다가 나중에 툭 튀는 것처럼 보였다.)
    curPScroll = pScrollAtNow(pSongTime);
    let pHud = false;
    for(const n of pNotes){
      if(n.judged && n.hit) continue;
      n.y = pJudgeY - (n.hitScroll - curPScroll) * pScrollK;
      if(n.isHold) n.tailY = pJudgeY - (n.tailScroll - curPScroll) * pScrollK;
      if(n.isHold && !n.judged && n.holding){
        if(!pKeys[n.lane]){
          n.judged=true; n.hit=false; n.holding=false;
          pCombo=0; pJudged++; pHud = true;
        } else {
          // Tick scoring during the hold, same formula/weights as the real
          // game (js/shared/gameplay.js DEFAULT_HOLD_SCORE) — test-play used
          // to award nothing here, so a hold's score wasn't representative.
          const mult = n.headMult || 1;
          while(n.nextTick < n.holdEndTime && pSongTime >= n.nextTick){
            pScore += Math.round(HOLD_SCORE.tickBase * mult);
            n.nextTick += beatMs() * 0.5;
            pHud = true;
          }
          if(pSongTime >= n.holdEndTime){
            const absTail = Math.abs(pSongTime - n.holdEndTime);
            n.judged=true; n.hit=true; n.holding=false;
            pJudged++; pHits++; pCombo++;
            const beats = Math.max(0.5, n.holdDur / beatMs());
            const tail = holdTailJudgment(absTail, HIT_WINDOWS, HOLD_SCORE);
            pScore += HOLD_SCORE.completeBase + Math.round(beats * HOLD_SCORE.perBeat * mult) + tail.bonus + Math.min(pCombo,50)*2;
            pHud = true;
            if(audioCtx) beep(audioCtx.currentTime, 880, 0.08);
          }
        }
      }
      if(!n.judged && !n.holding && pSongTime - n.hitTime > HIT_WINDOWS.miss){
        n.judged=true; n.hit=false; pCombo=0; pJudged++; pHud = true;
      }
    }
    if(pHud) updatePlayHUD();
    // 드로우
    pctx.clearRect(0,0,pW,pH);
    const total = pLaneW*4;
    const sx = (pW-total)/2;
    for(let i=0;i<4;i++){
      pctx.fillStyle = 'rgba(255,255,255,0.03)';
      pctx.fillRect(sx+i*pLaneW,0,pLaneW,pH);
      pctx.fillStyle = LANE_COLORS[i];
      pctx.font='bold 14px Orbitron';
      pctx.textAlign='center';
      pctx.fillText(KEYS[i], sx+i*pLaneW+pLaneW/2, pJudgeY+28);
    }
    pctx.strokeStyle='rgba(255,255,255,0.7)';
    pctx.lineWidth=3;
    pctx.beginPath();
    pctx.moveTo(sx,pJudgeY); pctx.lineTo(sx+total,pJudgeY);
    pctx.stroke();
    pctx.lineWidth=1;

    for(const n of pNotes){
      if(n.judged&&n.hit) continue;
      const x = sx+n.lane*pLaneW+8;
      const w = pLaneW-16;
      const color = LANE_COLORS[n.lane];
      if(n.isHold && !(n.judged&&n.hit)){
        const hy = n.holding ? pJudgeY : n.y;
        const ty = n.tailY;
        const top = Math.min(hy,ty), bot = n.holding ? pJudgeY : Math.max(hy,ty);
        if(bot-top>2){
          pctx.fillStyle = color+(n.holding?'aa':'66');
          roundRect(pctx,x+4,top,w-8,bot-top,4); pctx.fill();
        }
        if(ty>-16 && ty<pH+16){
          pctx.fillStyle = color;
          roundRect(pctx, x+2, ty-6, w-4, 12, 6); pctx.fill();
        }
      }
      if(!n.judged || (n.isHold&&!n.hit)){
        const hy = (n.isHold&&n.holding)?pJudgeY:n.y;
        if(hy>-20&&hy<pH+20){
          pctx.fillStyle=color;
          roundRect(pctx,x,hy-9,w,18,6); pctx.fill();
        }
      }
    }

    // 종료
    if(pSongTime > PREP_MS + totalBeats()*beatMs() + 1500){
      // 자동 종료는 하지 않고 계속 대기 — 유저가 편집으로
    }
    playRAF = requestAnimationFrame(playLoop);
  }

  document.getElementById('btn-play').onclick = startPlay;
  document.getElementById('btn-stop').onclick = stopPlay;

  window.addEventListener('keydown', e=>{
    if(!playing) return;
    const map = {d:0,f:1,j:2,k:3};
    const k = e.key.toLowerCase();
    if(k in map){
      e.preventDefault();
      const lane = map[k];
      if(!pKeys[lane]){ pKeys[lane]=true; playTryHit(lane); }
    }
  });
  window.addEventListener('keyup', e=>{
    const map = {d:0,f:1,j:2,k:3};
    const k = e.key.toLowerCase();
    if(k in map) pKeys[map[k]]=false;
  });

  // 터치 플레이
  playCanvas.addEventListener('pointerdown', e=>{
    if(!playing) return;
    const r = playCanvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const total = pLaneW*4;
    const sx = (pW-total)/2;
    if(x<sx||x>sx+total) return;
    const lane = Math.min(3, Math.floor((x-sx)/pLaneW));
    pKeys[lane]=true;
    playTryHit(lane);
  });
  playCanvas.addEventListener('pointerup', e=>{
    for(const k in pKeys) pKeys[k]=false;
  });

  // 자동 로드
  try{
    const raw = safeLS.get(STORAGE_KEY, null);
    if(raw) applyChart(JSON.parse(raw));
  }catch(_){}

  // 첫 입력에서 AudioContext 워밍 (테스트 시작 렉 완화)
  function warmAudioOnce(){
    try{
      initAudio();
      if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }catch(_){}
    window.removeEventListener('pointerdown', warmAudioOnce);
    window.removeEventListener('keydown', warmAudioOnce);
  }
  window.addEventListener('pointerdown', warmAudioOnce, { once:true });
  window.addEventListener('keydown', warmAudioOnce, { once:true });

  resizeEditor();
  refreshStatus();
})();
