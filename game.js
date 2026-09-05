// game.js — core game engine, top-level (no IIFE wrapper) so that
// audio.js / input.js / engine.js / flow.js (sibling <script> files,
// see game.html) share this file's let/const/function bindings via
// the page's global lexical scope — the same mechanism the
// js/shared/*.js modules already use.
  // ==================== 안전한 로컬 저장소 접근 ====================
  // (makeSafeStorage now comes from js/shared/storage.js)
  const safeLS = makeSafeStorage('localStorage');
  const safeSS = makeSafeStorage('sessionStorage');
  // ==================== 설정 (고난이도) ====================
  const BPM = 176;                          // 음악 BPM (더 빠름)
  const BEAT_MS = 60000 / BPM;              // 1박 시간(ms)
  const BASE_APPROACH_MS = 900;             // 1.0× 기준 접근 시간
  const PREP_MS = 3000;                     // 시작 준비 시간 (ms)
  const JUDGE_Y_RATIO = 0.78;               // 판정선 위치 (원본)
  // 노트 속도 배율 (높을수록 빨리 떨어짐 = 접근 시간 짧음)
  let speedRate = parseFloat(safeLS.get('neonBeatSpeed', '1')) || 1;
  speedRate = Math.max(0.75, Math.min(2, Math.round(speedRate * 20) / 20));
  let cachedApproachMs = BASE_APPROACH_MS / speedRate;
  function approachMs(){ return cachedApproachMs; }

  // ===== 속도 트리거용 스크롤-시간 적분 (js/shared/speed-scroll.js) =====
  // 노트 위치를 "지금 속도 × 남은시간"으로 근사하면, 속도가 바뀌는 순간
  // 화면 위 노트마다 남은시간이 달라서 서로 다른 비율로 튀어 간격이 일그러진다.
  // 대신 시간 t까지 누적된 "스크롤량(rate를 시간에 대해 적분한 값)"을 구간별로
  // 미리 계산해두고, 각 노트는 자신의 hitTime에 해당하는 스크롤값을 스폰 시 한 번만
  // 캐싱한다. 그러면 트리거 순간에도 위치가 끊기지 않고 이어지며(연속),
  // 노트 사이의 상대적 간격이 항상 정확하게 유지된다.
  // Own timeline instance — must not be shared with the editor's playtest timeline.
  const gameSpeedTimeline = createSpeedTimeline();
  function buildSpeedSegments(){
    // 시작 배속 + 차트 속도 트리거로 구간별 rate 적분 테이블 구성.
    // 위치는 항상 적분값 차이로 계산하므로 트리거 순간에도 끊기지 않음.
    gameSpeedTimeline.build(speedRate, chartSpeedTriggers);
    scrollTimeAtSpawn = gameSpeedTimeline.makeScroller();
    scrollTimeAtNow = gameSpeedTimeline.makeScroller();
    scrollTimeAtMarker = gameSpeedTimeline.makeScroller();
  }
  // 스캐너를 세 개로 분리: 하나는 노트 스폰 시 hitTime(미래, 오름차순) 조회용,
  // 하나는 매 프레임 현재 songTime(단조 증가) 조회용, 하나는 마커용. 하나만 쓰면
  // 서로 다른 시간대를 오가며 스캔 위치가 매번 앞뒤로 튀어 불필요한 탐색이 늘어난다.
  let scrollTimeAtSpawn = gameSpeedTimeline.makeScroller();
  let scrollTimeAtNow = gameSpeedTimeline.makeScroller();
  let scrollTimeAtMarker = gameSpeedTimeline.makeScroller();
  let curScroll = 0, scrollK = 0; // update()에서 매 프레임 갱신, draw()에서도 참조
  // noteSpeed / cullMargin 은 화면 크기(세로·가로)에 맞춰 resize()에서 재계산
  let noteSpeed = 0.92;
  let cullMargin = 80;
  const LANES = 4;
  const KEYS = ['d','f','j','k'];
  // LANE_COLORS now comes from js/shared/canvas-utils.js
  const HIT_WINDOWS = {                     // 판정 윈도우 (ms) – 약간 타이트 (game-specific, kept local — see report)
    perfect: 36,
    great: 72,
    good: 110,
    miss: 145
  };
  // 홀드 점수: 헤드(시작) + 틱(유지) + 테일(종료) + 길이 보너스
  // (formula + holdHeadMult now come from js/shared/gameplay.js — see report item 2)
  const HOLD_SCORE = DEFAULT_HOLD_SCORE;
  // 타이밍 오프셋(ms): 양수 = 판정을 뒤로(입력이 늦을 때), 음수 = 앞으로
  let timingOffset = parseInt(safeLS.get('neonBeatOffset', '0'), 10) || 0;
  timingOffset = Math.max(-150, Math.min(150, timingOffset));

  // ==================== DOM ====================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score-value');
  const comboEl = document.getElementById('combo-value');
  const accEl = document.getElementById('acc-value');
  const judgeEl = document.getElementById('judge');
  const timingSideEl = document.getElementById('timing-side');
  const startScreen = document.getElementById('start-screen');
  const pauseScreen = document.getElementById('pause-screen');
  const endScreen = document.getElementById('end-screen');
  const startBtn = document.getElementById('start-btn');
  const customBtn = document.getElementById('custom-btn');
  const importCustomBtn = document.getElementById('import-custom-btn');
  const startMsg = document.getElementById('start-msg');
  let useCustomChart = false;

  function setStartMsg(text, color){
    if(!startMsg) return;
    startMsg.textContent = text || '';
    startMsg.style.color = color || '#ffd23f';
  }
  const resumeBtn = document.getElementById('resume-btn');
  const restartBtn = document.getElementById('restart-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const muteBtn = document.getElementById('mute-btn');
  const bestStart = document.getElementById('best-start');
  const bestEnd = document.getElementById('best-end');
  const finalScore = document.getElementById('final-score');
  const finalCombo = document.getElementById('final-combo');
  const finalAcc = document.getElementById('final-acc');
  const finalEarly = document.getElementById('final-early');
  const finalLate = document.getElementById('final-late');
  const finalTotal = document.getElementById('final-total');
  const rankEl = document.getElementById('rank');
  const endTitle = document.getElementById('end-title');

  // ==================== 상태 ====================
  let W, H, laneW, judgeY;
  let running = false, paused = false, muted = false;
  let score = 0, combo = 0, maxCombo = 0;
  let hits = 0, totalNotes = 0, judged = 0;
  // earlyCount, lateCount, keysDown, pointerLane now live in js/game/input.js.
  let notes = [];           // {lane, hitTime, y, hit, judged, isHold, holdDur, holdEndTime, holding}
  let particles = [];
  let lastTime = 0;
  let songTime = 0;         // 현재 곡 시간(ms) — audioCtx.currentTime 기준으로 매 프레임 계산됨
  let audioStartTime = 0;   // 게임 시작 시점의 audioCtx.currentTime (songTime의 기준점)
  let chart = [];           // 미리 생성된 노트 차트 [{t, lane}]
  let chartIdx = 0;
  let chartSpeedTriggers = []; // [{t:ms, rate}]
  let speedTriggerIdx = 0;
  let travelPx = 400;
  let prebuiltChart = null; // 랜덤 차트 미리 생성 (시작 렉 방지)
  const laneQueues = {0:[], 1:[], 2:[], 3:[]}; // 레인별 노트 큐 (tryHit 탐색 최적화용)
  const laneCursor = {0:0, 1:0, 2:0, 3:0};     // 각 레인에서 다음에 확인할 큐 위치
  let best = parseInt(safeLS.get('neonBeatBest', '0'), 10);
  bestStart.textContent = best;
  bestEnd.textContent = best;

  // ==================== Audio ====================
  // audioCtx, masterGain, nextBeatTime, beatCount, initAudio, makeNoiseBuffer,
  // playKick/playSnare/playHat/playSynth, and scheduleMusic all now live in
  // js/game/audio.js (loaded before this file, see game.html).
  // GD식 Song ID: 채보 메타의 songId → IndexedDB blob
  // (openSongDB / idbGetSong now come from js/shared/song-db.js)
  let musicAudio = null;
  let musicUrl = null;
  let musicStarted = false;
  let useMusicTrack = false;
  let pendingSongMeta = null; // {songId,songName,songDuration}

  function stopMusicTrack(){
    if(musicAudio){ try{ musicAudio.pause(); }catch(_){ } musicAudio = null; }
    if(musicUrl){ try{ URL.revokeObjectURL(musicUrl); }catch(_){ } musicUrl = null; }
    musicStarted = false;
    useMusicTrack = false;
  }

  // ==================== 커스텀 차트 로드 (에디터 저장본) ====================
  // parseChartText now comes from js/shared/chart-format.js — called as
  // parseChartText(text) with no opts below, which uses the module's lenient
  // defaults (bpm:176, bars:16, strict:false), identical to this file's old
  // hardcoded behavior since BPM here is also 176.

  // sanitizeBeatNotes body is identical to shared sanitizeNotes() in
  // js/shared/chart-format.js — delegate instead of keeping a second copy.
  function sanitizeBeatNotes(list){
    return sanitizeNotes(list);
  }

  function applyCustomChartData(data){
    if(!data || !Array.isArray(data.notes) || data.notes.length === 0) return false;
    if(data.speed != null && isFinite(data.speed)){
      speedRate = Math.max(0.75, Math.min(2, Number(data.speed)));
      safeLS.set('neonBeatSpeed', String(speedRate));
      if(typeof refreshSpeedUI === 'function') refreshSpeedUI();
      if(typeof resize === 'function') resize();
    }
    pendingSongMeta = data.songId ? {
      songId: data.songId,
      songName: data.songName || data.songId,
      songDuration: data.songDuration || 0
    } : null;
    const clean = sanitizeBeatNotes(data.notes);
    if(clean.length === 0) return false;
    // 붙여넣은/외부 JSON은 bpm이 0·음수·극단값일 수 있으므로 방어적으로 클램프한다.
    // (에디터에서 저장한 정상 차트는 항상 60~300 범위라 이 클램프는 실질적으로 무영향)
    const bpmRaw = Number(data.bpm);
    const safeBpm = (isFinite(bpmRaw) && bpmRaw > 0) ? Math.max(60, Math.min(300, bpmRaw)) : BPM;
    const bm = 60000 / safeBpm;
    chart = clean.map(n=>{
      const o = { t: n.t * bm, lane: n.lane };
      if(n.hold > 0) o.hold = n.hold * bm;
      return o;
    });
    chart.sort((a,b)=> a.t - b.t || a.lane - b.lane);
    chartSpeedTriggers = Array.isArray(data.speedTriggers)
      ? data.speedTriggers.map(tr=>({
          t: Number(tr.t) * bm,
          rate: Math.max(0.75, Math.min(2, Number(tr.rate) || 1))
        })).filter(tr=>isFinite(tr.t)).sort((a,b)=>a.t-b.t)
      : [];
    return chart.length > 0;
  }

  function loadCustomChart(){
    const raw = safeLS.get('neonBeatCustomChart', null)
      || safeSS.get('neonBeatCustomChart', null);
    if(!raw) return false;
    let data;
    try{ data = parseChartText(raw); }catch(_){
      try{ data = JSON.parse(raw); }catch(__){ return false; }
    }
    return applyCustomChartData(data);
  }

  // ==================== 차트 생성 (랜덤 / 고밀도) ====================
  function generateChart(){
    chart = [];
    const totalBeats = 160;
    let t = 0;
    // 짧은 인트로
    for(let i=0; i<4; i++){
      chart.push({t: t, lane: i % 4});
      t += BEAT_MS;
    }
    const patterns = [
      [0,1,2,3],
      [0,2,1,3],
      [0,0,2,2],
      [1,3,1,3],
      [0,1,0,1,2,3,2,3],
      [0,2,3,1],
      [0,1,2,1,0,3],
      [0,3,1,2,0,3],
      [0,0,1,1,2,2,3,3],
      [0,2,0,2,1,3,1,3],
      [0,1,2,3,2,1],
      [0,3,0,3,1,2,1,2],
      [0,1,0,2,0,3],
      [0,1,2,0,1,2,3,3],
      [0,2,1,3,0,2,1,3]
    ];
    let pIdx = 0;
    while(chart.length < totalBeats * 2.4){
      const pat = patterns[pIdx % patterns.length];
      for(const lane of pat){
        chart.push({t: t, lane});
        if(Math.random() < 0.22 && chart.length > 12){
          const other = (lane + 1 + Math.floor(Math.random()*3)) % 4;
          chart.push({t: t, lane: other});
        }
        if(Math.random() < 0.08 && chart.length > 20){
          const other2 = (lane + 2) % 4;
          if(other2 !== lane) chart.push({t: t, lane: other2});
        }
        const roll = Math.random();
        if(roll < 0.35) t += BEAT_MS * 0.5;
        else if(roll < 0.48) t += BEAT_MS * 0.25;
        else t += BEAT_MS;
      }
      if(pIdx % 5 === 4) t += BEAT_MS * 0.25;
      pIdx++;
    }
    chart.sort((a,b)=> a.t - b.t || a.lane - b.lane);
    const seen = new Set();
    chart = chart.filter(n=>{
      const key = n.t.toFixed(0)+'-'+n.lane;
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 홀드 랜덤 배치
    for(let i=0;i<chart.length;i++){
      const n = chart[i];
      if(i < 4) continue;
      if(Math.random() < 0.22){
        const holdBeats = Math.random() < 0.45 ? 1 : (Math.random() < 0.7 ? 2 : 3);
        const holdDur = BEAT_MS * holdBeats;
        const endT = n.t + holdDur;
        let conflict = false;
        for(let j=0;j<chart.length;j++){
          if(j === i) continue;
          const o = chart[j];
          if(o.lane === n.lane && o.t > n.t - 1 && o.t < endT + BEAT_MS*0.2){
            conflict = true; break;
          }
        }
        if(!conflict) n.hold = holdDur;
      }
    }
  }

  // ==================== 리사이즈 (세로·가로 모두 지원) ====================
  const rotateLock = document.getElementById('rotate-lock');
  if(rotateLock) rotateLock.classList.add('hidden');

  let _canvasRect = null;
  function resize(){
    // 픽셀 밀도 제한 (드로우 비용)
    const maxDpr = Math.min(window.innerWidth, window.innerHeight) < 700 ? 1.25 : 1.75;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const landscape = W > H * 1.05;
    if(landscape){
      // 가로: 화면 너비의 대부분을 4레인에 사용, 판정선은 아래쪽 여유(키 영역)
      const trackW = Math.min(W * 0.88, H * 2.2);
      laneW = trackW / 4;
      judgeY = H * 0.70;
    } else {
      laneW = Math.min(90, W * 0.2);
      judgeY = H * JUDGE_Y_RATIO;
    }

    travelPx = Math.max(100, judgeY - 40);
    cachedApproachMs = BASE_APPROACH_MS / speedRate;
    noteSpeed = travelPx / cachedApproachMs;
    cullMargin = Math.max(60, H * 0.1);
    _canvasRect = null;
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', ()=> setTimeout(resize, 80));
  resize();

  // 첫 클릭에서 AudioContext 미리 깨워 시작 렉 완화
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

  // 랜덤 차트 미리 생성 (시작 버튼 순간의 긴 GC/연산 회피)
  function warmChartOnce(){
    try{
      generateChart();
      prebuiltChart = chart.map(n=>({ t: n.t, lane: n.lane, hold: n.hold }));
      chart = [];
    }catch(_){}
  }
  if(typeof requestIdleCallback === 'function') requestIdleCallback(warmChartOnce, { timeout: 1500 });
  else setTimeout(warmChartOnce, 100);

  // ==================== 게임 루프 ====================
  let noteSpeedTarget = noteSpeed;
  let speedChangeCooldown = 0; // 트리거 직후 스폰 예산 축소
  // 안드로이드/터치 기기: 즉시 배속 스냅 + dashed 선이 한 프레임 스파이크를 냄
  const isAndroidLike = /Android/i.test(navigator.userAgent || '')
    || (window.matchMedia && window.matchMedia('(pointer:coarse)').matches);

  function applyPlaySpeed(rate, opts){
    speedRate = Math.max(0.75, Math.min(2, rate));
    cachedApproachMs = BASE_APPROACH_MS / speedRate;
    noteSpeedTarget = travelPx / Math.max(1, cachedApproachMs);
    // 모바일은 스냅 대신 짧게 보간 (한 프레임 노트 점프·GC 완화)
    if(opts && opts.snap && !isAndroidLike){
      noteSpeed = noteSpeedTarget;
    } else if(opts && opts.snap && isAndroidLike){
      // 목표의 60%만 즉시, 나머지는 보간
      noteSpeed = noteSpeed + (noteSpeedTarget - noteSpeed) * 0.55;
    }
    if(opts && opts.ui && typeof refreshSpeedUI === 'function') refreshSpeedUI();
  }

  function spawnNotes(maxCount){
    // 한 프레임 스폰 상한 (시작·속도 트리거 시 폭주 방지)
    let budget = maxCount == null ? (isAndroidLike ? 4 : 8) : maxCount;
    if(speedChangeCooldown > 0) budget = Math.min(budget, isAndroidLike ? 1 : 2);
    // 보간 중에도 노트를 놓치지 않도록 더 넓은 쪽 호라이즌 사용
    const horizonMs = Math.max(cachedApproachMs, travelPx / Math.max(0.05, noteSpeed));
    const horizon = songTime + horizonMs;
    while(budget-- > 0 && chartIdx < chart.length && chart[chartIdx].t <= horizon){
      const n = chart[chartIdx];
      const isHold = !!n.hold;
      const holdDur = n.hold || 0;
      const obj = {
        lane: n.lane,
        hitTime: n.t,
        hitScroll: scrollTimeAtSpawn(n.t),
        y: judgeY - (n.t - songTime) * noteSpeed,
        hit: false,
        judged: false,
        isHold: isHold,
        holdDur: holdDur,
        holdEndTime: n.t + holdDur,
        tailScroll: isHold ? scrollTimeAtSpawn(n.t + holdDur) : 0,
        tailY: judgeY - ((n.t + holdDur) - songTime) * noteSpeed,
        holding: false,
        headHit: false
      };
      notes.push(obj);
      laneQueues[n.lane].push(obj);
      chartIdx++;
      totalNotes++;
    }
  }

  function update(dt){
    if(!running || paused) return;
    // songTime은 audioCtx의 클럭을 기준으로 계산한다 (rAF의 dt 누적을 쓰지 않음).
    // 이렇게 하면 노트 판정과 실제로 재생 중인 음악(scheduleMusic도 audioCtx.currentTime 기준)이
    // 항상 같은 시계를 공유하게 되어 장시간 플레이해도 서로 어긋나지 않는다.
    // 또한 audioCtx가 suspend 상태일 땐 currentTime이 멈추므로, 일시정지 중에도
    // songTime이 자연히 멈춰서 별도의 pause 보정 로직이 필요 없다.
    if(useMusicTrack && musicAudio){
      if(musicStarted && !musicAudio.paused){
        songTime = PREP_MS + musicAudio.currentTime * 1000;
      } else if(audioCtx){
        songTime = (audioCtx.currentTime - audioStartTime) * 1000;
        if(songTime >= PREP_MS && !musicStarted){
          musicStarted = true;
          const a = musicAudio;
          const vol = muted ? 0 : 0.85;
          // play()를 다음 프레임으로 미뤄 메인 스레드 스파이크 완화
          requestAnimationFrame(()=>{
            try{
              a.currentTime = 0;
              a.volume = vol;
              a.play().catch(()=>{
                // 자동재생 차단 등으로 실제 재생이 거부된 경우: 화면엔 노트가 이미
                // 흐르고 있으므로 무음으로 두지 않고 합성 비트로 넘어간다.
                if(useMusicTrack){
                  useMusicTrack = false;
                  setStartMsg('음악 자동재생이 차단되어 합성 비트로 진행합니다.', '#ffd23f');
                }
              });
            }catch(_){
              useMusicTrack = false;
            }
          });
        }
      }
    } else if(audioCtx){
      songTime = (audioCtx.currentTime - audioStartTime) * 1000;
    }

    // 속도 트리거: 통과 시 낙하 배속 변경 (위치는 스크롤 적분으로 연속 유지)
    while(speedTriggerIdx < chartSpeedTriggers.length && songTime >= chartSpeedTriggers[speedTriggerIdx].t){
      const tr = chartSpeedTriggers[speedTriggerIdx];
      const newRate = Math.max(0.75, Math.min(2, Number(tr.rate) || 1));
      // 설정값(speedRate)·localStorage 는 건드리지 않고 플레이 중 noteSpeed만 갱신
      cachedApproachMs = BASE_APPROACH_MS / newRate;
      noteSpeedTarget = travelPx / Math.max(1, cachedApproachMs);
      if(!isAndroidLike){
        noteSpeed = noteSpeedTarget;
      } else {
        // 한 프레임 스파이크 완화: 목표의 일부만 즉시 반영
        noteSpeed = noteSpeed + (noteSpeedTarget - noteSpeed) * 0.55;
      }
      speedChangeCooldown = isAndroidLike ? 12 : 4;
      speedTriggerIdx++;
    }
    if(speedChangeCooldown > 0){
      speedChangeCooldown--;
      if(isAndroidLike){
        noteSpeed = noteSpeed + (noteSpeedTarget - noteSpeed) * 0.35;
      }
    } else {
      noteSpeed = noteSpeedTarget;
    }

    // 시작 카운트다운 (DOM 1회)
    if(songTime < PREP_MS + 200){
      const remain = PREP_MS - songTime;
      let label = null;
      if(remain > 2000) label = '3';
      else if(remain > 1000) label = '2';
      else if(remain > 0) label = '1';
      else if(remain > -200) label = 'GO';
      if(label && update._cdLabel !== label){
        update._cdLabel = label;
        showJudge(label, label === 'GO' ? '#ffd23f' : '#3fe0ff');
      }
    }

    spawnNotes(isAndroidLike ? 4 : 8);

    // ===== 단일 패스: 위치 + 홀드 + 미스 + 인플레이스 정리 =====
    const jt = judgeTime();
    // 노트별로 노트속도를 곱하는 대신, 시간에 대해 적분된 스크롤값의 차이를 쓴다.
    // (트리거 순간에도 위치가 끊기지 않고, 노트 사이 간격이 항상 정확히 유지된다)
    curScroll = scrollTimeAtNow(songTime);
    scrollK = travelPx / BASE_APPROACH_MS;
    const K = scrollK;
    let write = 0;
    let hudDirty = false;
    let allJudged = true; // 곡 종료 판단용 — 이 프레임에 판정 안 된 노트가 하나라도 남아있는지
    for(let i = 0; i < notes.length; i++){
      const n = notes[i];

      if(n.judged && n.hit){
        // 성공 노트 즉시 폐기
        continue;
      }
      if(!n.judged) allJudged = false;

      // 위치
      if(!(n.judged && n.hit)){
        n.y = judgeY - (n.hitScroll - curScroll) * K;
        if(n.isHold) n.tailY = judgeY - (n.tailScroll - curScroll) * K;
      }

      // 홀드 유지
      if(n.isHold && !n.judged && n.holding){
        if(!keysDown[n.lane]){
          n.judged = true; n.hit = false; n.holding = false;
          combo = 0; judged++;
          showJudge('BREAK', '#ff3d81');
          hudDirty = true;
        } else {
          if(n.nextTick == null) n.nextTick = n.hitTime + BEAT_MS * 0.5;
          const mult = n.headMult || 1;
          while(n.nextTick < n.holdEndTime && songTime >= n.nextTick){
            score += Math.round(HOLD_SCORE.tickBase * mult);
            n.nextTick += BEAT_MS * 0.5;
            hudDirty = true;
          }
          if(songTime >= n.holdEndTime){
            const absTail = Math.abs(judgeTime() - n.holdEndTime);
            n.judged = true; n.hit = true; n.holding = false;
            judged++; hits++; combo++;
            if(combo > maxCombo) maxCombo = combo;
            const beats = Math.max(0.5, n.holdDur / BEAT_MS);
            const tail = holdTailJudgment(absTail, HIT_WINDOWS, HOLD_SCORE);
            score += HOLD_SCORE.completeBase + Math.round(beats * HOLD_SCORE.perBeat * mult) + tail.bonus + Math.min(combo,50)*2;
            showJudge(tail.label, tail.color);
            spawnHitParticles(n.lane, tail.color);
            hudDirty = true;
            continue; // 성공 → 배열에서 제거
          }
        }
      }

      // Miss
      if(!n.judged && !n.holding && jt - n.hitTime > HIT_WINDOWS.miss){
        n.judged = true; n.hit = false;
        combo = 0; judged++;
        showJudge('MISS', '#ff3d81');
        hudDirty = true;
      }

      // 유지 여부 (실패 노트는 화면 밖까지)
      if(n.judged && n.hit) continue;
      if(n.judged && !n.hit){
        if(n.isHold){
          const topY = Math.min(n.y, n.tailY != null ? n.tailY : n.y);
          if(topY > H + cullMargin) continue;
        } else if(n.y > H + cullMargin) continue;
      }
      notes[write++] = n;
    }
    notes.length = write;

    // 곡이 끝나면 자동 종료 — update() 안에서 매 프레임 확인하므로 프레임 정확하고,
    // 위에서 이미 순회한 값(allJudged)을 재사용하므로 별도의 notes.every() 스캔이 없다.
    // (예전엔 setInterval(…, 500)으로 따로 돌려서 최대 500ms까지 늦게 끝날 수 있었고,
    //  큰 차트에서 500ms마다 전체 재스캔을 했으며, 페이지 이탈 시 정리되지 않았다.)
    if(chartIdx >= chart.length && allJudged){
      endGame(true);
      return;
    }

    // 파티클 인플레이스
    let pw = 0;
    for(let i = 0; i < particles.length; i++){
      const p = particles[i];
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.0004 * dt;
      if(p.life > 0) particles[pw++] = p;
    }
    particles.length = pw;

    if(hudDirty){
      scoreEl.textContent = score;
      updateHUD();
    }

    scheduleMusic();
  }

  function draw(){
    ctx.clearRect(0,0,W,H);

    const centerX = W/2;
    const totalLaneW = laneW * LANES;
    const startX = centerX - totalLaneW/2;
    const landscape = W > H * 1.05;
    const keyH = landscape ? Math.max(28, Math.min(40, H - judgeY - 8)) : 36;
    const keyY = Math.min(judgeY + 10, H - keyH - 4);

    for(let i=0;i<LANES;i++){
      const x = startX + i * laneW;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, 0, laneW, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
      ctx.stroke();

      const pressed = keysDown[i];
      ctx.fillStyle = pressed ? LANE_COLORS[i] + '55' : LANE_COLORS[i] + '33';
      ctx.fillRect(x + 4, keyY, laneW - 8, keyH);
      ctx.fillStyle = LANE_COLORS[i];
      ctx.font = (landscape ? 'bold 13px ' : 'bold 16px ') + 'Orbitron';
      ctx.textAlign = 'center';
      ctx.fillText(KEYS[i].toUpperCase(), x + laneW/2, keyY + keyH * 0.65);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(startX + totalLaneW, 0);
    ctx.lineTo(startX + totalLaneW, H);
    ctx.stroke();

    // 판정선 (shadow 제거 — GPU 부하)
    ctx.strokeStyle = 'rgba(63,224,255,0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(startX, judgeY);
    ctx.lineTo(startX + totalLaneW, judgeY);
    ctx.stroke();
    ctx.lineWidth = 1;

    // 속도 트리거 마커 (다음 1개만 · dash/measureText 회피 — 안드로이드 GPU 부하)
    if(speedTriggerIdx < chartSpeedTriggers.length){
      const tr = chartSpeedTriggers[speedTriggerIdx];
      // 노트와 같은 스크롤 적분값을 사용해 트리거 순간에도 노트 줄과 어긋나지 않게 한다.
      const y = judgeY - (scrollTimeAtMarker(tr.t) - curScroll) * scrollK;
      if(y >= -30 && y <= H + 30){
        ctx.strokeStyle = 'rgba(255,210,63,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(startX + totalLaneW, y);
        ctx.stroke();
        ctx.lineWidth = 1;
        // 고정 폭 뱃지 (measureText 비용 제거)
        const bx = startX + totalLaneW + 4;
        ctx.fillStyle = 'rgba(255,210,63,0.9)';
        ctx.fillRect(bx, y - 9, 44, 16);
        ctx.fillStyle = '#1a1200';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(tr.rate.toFixed(2) + 'x', bx + 4, y + 3);
      }
    }

    const noteH = landscape ? 14 : 18;
    for(const n of notes){
      if(n.judged && n.hit) continue;
      if(n.y > H + cullMargin && (!n.isHold || (n.tailY || 0) > H + cullMargin)) continue;

      const x = startX + n.lane * laneW + 6;
      const w = laneW - 12;
      const color = LANE_COLORS[n.lane];
      const r = Math.min(8, w/2);

      if(n.isHold && !(n.judged && n.hit)){
        const headY = n.holding ? judgeY : n.y;
        const tailY = n.tailY != null ? n.tailY : headY;
        let drawTop = Math.min(headY, tailY);
        let drawBot = Math.max(headY, tailY);
        if(n.holding) drawBot = judgeY;
        const bodyPad = 3;
        const bodyW = w - bodyPad * 2;
        if(drawBot - drawTop > 2){
          ctx.fillStyle = color + (n.holding ? 'aa' : '66');
          roundRect(ctx, x + bodyPad, drawTop, bodyW, drawBot - drawTop, 4);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,' + (n.holding ? '0.4' : '0.2') + ')';
          ctx.fillRect(x + w/2 - 1.5, drawTop, 3, drawBot - drawTop);
        }
        if(tailY > -20 && tailY < H + 20){
          ctx.fillStyle = color;
          roundRect(ctx, x + 2, tailY - 6, w - 4, 12, 6);
          ctx.fill();
        }
      }

      if(!n.judged || (n.isHold && !n.hit)){
        const hy = (n.isHold && n.holding) ? judgeY : n.y;
        if(hy > -30 && hy < H + 30){
          ctx.fillStyle = color;
          roundRect(ctx, x, hy - noteH/2, w, noteH, r);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(x + 3, hy - noteH/2 + 2, w - 6, 4);
        }
      }
    }

    // 파티클 (최대 개수 제한)
    const maxP = 40;
    const start = particles.length > maxP ? particles.length - maxP : 0;
    for(let i = start; i < particles.length; i++){
      const p = particles[i];
      ctx.globalAlpha = Math.max(0, p.life / 400);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  // roundRect now comes from js/shared/canvas-utils.js

  function loop(ts){
    if(!lastTime) lastTime = ts;
    const dt = Math.min(ts - lastTime, 50);
    lastTime = ts;
    if(running){
      update(dt);
      draw();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // judgeTime / evaluateTiming / tryHit / recordTimingSide / keysDown /
  // pointerLane / keyMap / laneFromClientX / releasePointer and their
  // keydown/keyup/blur/pointer* listeners now live in js/game/input.js
  // (loaded after this file — see game.html).

  function showJudge(text, color){
    // 블러 반경을 20px→9px로 축소: 안드로이드에서 text-shadow 블러는
    // 히트마다 GPU 합성 비용이 크게 드는데, 반경이 줄면 그 비용도 크게 줄어든다.
    // (히트가 몰리는 첫 노트/트리거 직후 구간에서 특히 체감 차이가 크다)
    judgeEl.textContent = text;
    judgeEl.style.color = color;
    judgeEl.style.textShadow = `0 0 9px ${color}`;
    judgeEl.style.opacity = '1';
    clearTimeout(judgeEl._t);
    judgeEl._t = setTimeout(()=> judgeEl.style.opacity = '0', 380);
  }

  function spawnHitParticles(lane, color){
    // 파티클 최소화 (렉 방지)
    if(particles.length > 24) return;
    const centerX = W/2;
    const totalLaneW = laneW * LANES;
    const startX = centerX - totalLaneW/2;
    const cx = startX + lane * laneW + laneW/2;
    for(let i=0;i<3;i++){
      particles.push({
        x: cx, y: judgeY,
        vx: (Math.random()-0.5)*0.35,
        vy: -Math.random()*0.3 - 0.08,
        r: Math.random()*2.5 + 1,
        life: 200 + Math.random()*120,
        color
      });
    }
  }

  function updateHUD(){
    scoreEl.textContent = score;
    comboEl.textContent = combo;
    comboEl.classList.add('pop');
    setTimeout(()=> comboEl.classList.remove('pop'), 100);
    const acc = judged === 0 ? 100 : Math.round(hits / judged * 100);
    accEl.textContent = acc + '%';
  }

  // keyMap / keydown,keyup,blur listeners / laneFromClientX / pointerdown,
  // pointerup,pointercancel,pointerleave listeners / releasePointer now live
  // in js/game/input.js.

  // ==================== 게임 흐름 ====================
  let gameStarting = false; // 시작·재시작 버튼 연타로 startGame()이 겹쳐 실행되는 것 방지
  async function startGame(){
    if(gameStarting) return;
    gameStarting = true;
    try{
      setStartMsg('');
      if(!initAudio()){
        setStartMsg('이 브라우저에서는 오디오를 사용할 수 없어 게임을 시작할 수 없습니다.', '#ff3d81');
        return;
      }
      stopMusicTrack();
      pendingSongMeta = null;

      score = 0; combo = 0; maxCombo = 0;
      hits = 0; totalNotes = 0; judged = 0;
      earlyCount = 0; lateCount = 0;
      notes = []; particles = [];
      chartIdx = 0;
      for(const l of [0,1,2,3]){ laneQueues[l] = []; laneCursor[l] = 0; }
      for(const l in keysDown) keysDown[l] = false;
      pointerLane.clear();
      beatCount = 0;
      songTime = 0;
      // 차트·음악 로드를 먼저 끝낸 뒤 시계를 시작 (시작 렉·시간 점프 방지)
      if(useCustomChart){
        if(!loadCustomChart()){
          setStartMsg('저장된 커스텀 차트가 없습니다. 에디터에서 저장하거나 JSON을 붙여넣으세요.', '#ff3d81');
          useCustomChart = false;
          return;
        }
        if(pendingSongMeta && pendingSongMeta.songId){
          try{
            const row = await idbGetSong(pendingSongMeta.songId);
            if(row && row.blob){
              musicUrl = URL.createObjectURL(row.blob);
              musicAudio = new Audio(musicUrl);
              musicAudio.preload = 'auto';
              musicAudio.volume = muted ? 0 : 0.85;
              useMusicTrack = true;
              musicStarted = false;
              // 자동재생 차단·디코딩 실패 등으로 파일이 아예 재생되지 않을 수 있으므로,
              // 에러 시 합성 비트로 자동 전환해 "음악도 비트도 없는 무음 진행"을 막는다.
              musicAudio.onerror = ()=>{
                if(musicAudio) stopMusicTrack();
                useMusicTrack = false;
                setStartMsg('음악 파일을 재생할 수 없어 합성 비트로 진행합니다.', '#ffd23f');
              };
              try{ musicAudio.load(); }catch(_){}
              // play()/pause 워밍은 메인 스레드를 막아 시작 렉 유발 → 제거
            } else {
              setStartMsg('Song ID 오디오 없음: '+pendingSongMeta.songId+' (에디터에서 같은 브라우저로 다시 「음악」 불러오기)', '#ffd23f');
            }
          }catch(err){
            setStartMsg('음악 로드 실패', '#ff3d81');
          }
        }
      } else {
        if(prebuiltChart && prebuiltChart.length){
          chart = prebuiltChart.map(n=>({ t: n.t, lane: n.lane, hold: n.hold }));
        } else {
          generateChart();
        }
        prebuiltChart = null;
        chartSpeedTriggers = [];
        const regen = ()=>{
          // 플레이 중 active chart를 덮어쓰지 않도록 백업
          const active = chart;
          try{
            generateChart();
            prebuiltChart = chart.map(n=>({ t: n.t, lane: n.lane, hold: n.hold }));
          }catch(_){}
          chart = active;
        };
        if(typeof requestIdleCallback === 'function') requestIdleCallback(regen, { timeout: 2500 });
        else setTimeout(regen, 50);
      }
      for(const n of chart) n.t += PREP_MS;
      for(const tr of chartSpeedTriggers) tr.t += PREP_MS;
      speedTriggerIdx = 0;

      resize();
      applyPlaySpeed(speedRate, { ui:true, snap:true });
      buildSpeedSegments();
      speedChangeCooldown = 0;
      songTime = 0;
      // 프리 스폰 없음 — 첫 프레임부터 소량씩 (시작 렉 핵심)
      if(audioCtx){
        if(audioCtx.state === 'suspended'){
          try{ await audioCtx.resume(); }catch(_){}
        }
        await new Promise(r=> requestAnimationFrame(r));
        audioStartTime = audioCtx.currentTime;
        nextBeatTime = audioStartTime + 0.3;
      } else {
        await new Promise(r=> requestAnimationFrame(r));
        audioStartTime = 0;
        nextBeatTime = 0.3;
      }
      songTime = 0;
      lastTime = 0;

      running = true; paused = false;
      startScreen.classList.add('hidden');
      pauseScreen.classList.add('hidden');
      endScreen.classList.add('hidden');
      if(typeof helpScreen !== 'undefined' && helpScreen) helpScreen.classList.add('hidden');
      pauseBtn.classList.remove('hidden');
      muteBtn.classList.remove('hidden');
      updateHUD();
      if(timingSideEl) timingSideEl.style.opacity = '0';
      if(!(pendingSongMeta && !useMusicTrack)) setStartMsg('');
    } finally {
      gameStarting = false;
    }
  }

  function togglePause(){
    if(!running) return;
    paused = !paused;
    pauseScreen.classList.toggle('hidden', !paused);
    if(paused){
      if(audioCtx) audioCtx.suspend();
      if(musicAudio) try{ musicAudio.pause(); }catch(_){}
    } else {
      if(audioCtx) audioCtx.resume();
      if(musicAudio && musicStarted) try{ musicAudio.play(); }catch(_){}
    }
  }

  /** 일시정지 메뉴: 홈/에디터 — 진행 중 세션을 버리고 리셋 */
  function quitToHome(){
    if(!running && !paused) return;
    running = false;
    paused = false;
    pauseScreen.classList.add('hidden');
    endScreen.classList.add('hidden');
    pauseBtn.classList.add('hidden');
    muteBtn.classList.add('hidden');
    if(timingSideEl) timingSideEl.style.opacity = '0';
    if(audioCtx) try{ audioCtx.suspend(); }catch(_){}
    stopMusicTrack();
    notes = [];
    particles = [];
    chartIdx = 0;
    for(const l of [0,1,2,3]){ laneQueues[l] = []; laneCursor[l] = 0; }
    for(const l in keysDown) keysDown[l] = false;
    pointerLane.clear();
    startScreen.classList.remove('hidden');
    if(typeof helpScreen !== 'undefined' && helpScreen) helpScreen.classList.add('hidden');
    setStartMsg('');
  }
  function quitToEditor(){
    quitToHome();
    location.href = 'editor.html';
  }

  function endGame(cleared){
    running = false;
    paused = false;
    pauseBtn.classList.add('hidden');
    if(timingSideEl) timingSideEl.style.opacity = '0';
    if(audioCtx) audioCtx.suspend();
    stopMusicTrack();

    if(score > best){
      best = score;
      safeLS.set('neonBeatBest', best);
    }
    bestStart.textContent = best;
    bestEnd.textContent = best;
    finalScore.textContent = score;
    finalCombo.textContent = maxCombo;
    const acc = judged === 0 ? 100 : Math.round(hits / judged * 1000) / 10; // 소수점 1자리
    finalAcc.textContent = acc + '%';
    if(finalEarly) finalEarly.textContent = earlyCount;
    if(finalLate) finalLate.textContent = lateCount;
    if(finalTotal) finalTotal.textContent = totalNotes;

    // 세밀 등급: 정확도 + 최고 콤보 보너스
    let rank = 'D';
    if(acc >= 99.5 && maxCombo >= 50) rank = 'SSS';
    else if(acc >= 99) rank = 'SS';
    else if(acc >= 97) rank = 'S+';
    else if(acc >= 95) rank = 'S';
    else if(acc >= 92) rank = 'A+';
    else if(acc >= 88) rank = 'A';
    else if(acc >= 84) rank = 'B+';
    else if(acc >= 78) rank = 'B';
    else if(acc >= 72) rank = 'C+';
    else if(acc >= 65) rank = 'C';
    else if(acc >= 50) rank = 'D';
    else rank = 'F';

    rankEl.textContent = rank;
    endTitle.textContent = '세션 클리어!';
    endScreen.classList.remove('hidden');
  }

  const helpBtn = document.getElementById('help-btn');
  const helpScreen = document.getElementById('help-screen');
  const helpCloseBtn = document.getElementById('help-close-btn');
  if(helpBtn && helpScreen){
    helpBtn.addEventListener('click', ()=> helpScreen.classList.remove('hidden'));
  }
  if(helpCloseBtn && helpScreen){
    helpCloseBtn.addEventListener('click', ()=> helpScreen.classList.add('hidden'));
  }

  startBtn.addEventListener('click', ()=>{ useCustomChart = false; startGame(); });
  if(customBtn) customBtn.addEventListener('click', ()=>{
    const has = safeLS.get('neonBeatCustomChart', null)
      || safeSS.get('neonBeatCustomChart', null);
    if(!has){
      setStartMsg('커스텀 차트 없음 → 에디터에서 「저장」 후 다시 누르거나, 아래 JSON 붙여넣기를 사용하세요.', '#ffd23f');
      return;
    }
    useCustomChart = true;
    startGame();
  });
  if(importCustomBtn) importCustomBtn.addEventListener('click', ()=>{
    const text = prompt('차트 코드 붙여넣기\n예: 1.30-2-0@0,1@1:2|176|16');
    if(text == null || !String(text).trim()) return;
    try{
      const data = parseChartText(String(text).trim().split('\n')[0]);
      if(!applyCustomChartData(data)){
        setStartMsg('형식이 올바르지 않거나 노트가 없습니다.', '#ff3d81');
        return;
      }
      const importedJson = JSON.stringify(data);
      safeLS.set('neonBeatCustomChart', importedJson);
      safeSS.set('neonBeatCustomChart', importedJson);
      setStartMsg('가져오기 완료! 「커스텀 차트 플레이」 (노트 '+data.notes.length+'개)', '#3fe0ff');
    }catch(err){
      setStartMsg('파싱 실패: '+(err && err.message ? err.message : err), '#ff3d81');
    }
  });

  // URL 해시 #c=... (에디터 「게임으로」) — file:// localStorage 분리 회피
  function ingestChartFromHash(){
    try{
      const hash = location.hash || '';
      if(hash.indexOf('#c=') !== 0) return false;
      let payload = decodeURIComponent(hash.slice(3));
      let text = payload;
      try{ text = atob(payload); }catch(_){ text = payload; }
      const data = parseChartText(String(text).split('\n')[0]);
      if(!applyCustomChartData(data)) return false;
      const json = JSON.stringify(data);
      safeLS.set('neonBeatCustomChart', json);
      safeSS.set('neonBeatCustomChart', json);
      history.replaceState(null, '', location.pathname + location.search);
      setStartMsg('에디터에서 차트 수신 → 「커스텀 차트 플레이」 (노트 '+data.notes.length+'개)', '#3fe0ff');
      return true;
    }catch(err){
      setStartMsg('해시 차트 로드 실패: '+(err && err.message ? err.message : err), '#ff3d81');
      return false;
    }
  }
  try{
    if(!ingestChartFromHash()){
      if(safeSS.get('neonBeatCustomChart', null)){
        setStartMsg('에디터 차트가 준비됨 → 「커스텀 차트 플레이」', '#3fe0ff');
      } else if(safeLS.get('neonBeatCustomChart', null)){
        setStartMsg('저장된 커스텀 차트 있음 → 「커스텀 차트 플레이」', '#9a4dff');
      }
    }
  }catch(_){}
  resumeBtn.addEventListener('click', togglePause);
  const pauseHomeBtn = document.getElementById('pause-home-btn');
  const pauseEditorBtn = document.getElementById('pause-editor-btn');
  if(pauseHomeBtn) pauseHomeBtn.addEventListener('click', quitToHome);
  if(pauseEditorBtn) pauseEditorBtn.addEventListener('click', quitToEditor);
  restartBtn.addEventListener('click', startGame);
  pauseBtn.addEventListener('click', togglePause);
  muteBtn.addEventListener('click', ()=>{
    muted = !muted;
    muteBtn.textContent = muted ? '🔇 음소거' : '🔊 소리';
    if(masterGain) masterGain.gain.value = muted ? 0 : 0.35;
    if(musicAudio) musicAudio.volume = muted ? 0 : 0.85;
  });

  // 타이밍 오프셋 UI (시작 + 결과/재시도 화면)
  function refreshOffsetUI(){
    const sign = timingOffset > 0 ? '+' : '';
    const text = sign + timingOffset + ' ms';
    ['offset-value','offset-value-end'].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.textContent = text;
    });
  }
  function changeOffset(delta){
    timingOffset = Math.max(-150, Math.min(150, timingOffset + delta));
    safeLS.set('neonBeatOffset', String(timingOffset));
    refreshOffsetUI();
  }
  ['offset-minus','offset-minus-end'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', ()=> changeOffset(-5));
  });
  ['offset-plus','offset-plus-end'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', ()=> changeOffset(5));
  });
  refreshOffsetUI();

  // 노트 속도 UI
  function refreshSpeedUI(){
    const text = speedRate.toFixed(2) + '×';
    ['speed-value','speed-value-end'].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.textContent = text;
    });
  }
  function changeSpeed(delta){
    const next = Math.max(0.75, Math.min(2, Math.round((speedRate + delta) * 20) / 20));
    safeLS.set('neonBeatSpeed', String(next));
    applyPlaySpeed(next, { ui:true });
  }
  ['speed-minus','speed-minus-end'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', ()=> changeSpeed(-0.05));
  });
  ['speed-plus','speed-plus-end'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', ()=> changeSpeed(0.05));
  });
  refreshSpeedUI();

