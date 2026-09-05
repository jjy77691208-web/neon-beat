// input.js — keyboard + multi-pointer input, hit judging (tryHit), timing
// evaluation, and early/late tracking. Extracted verbatim from the
// game.html monolith (see neon-beat-modularization-report.txt).
//
// Loaded as a plain top-level script (no IIFE wrapper), same as game.js and
// audio.js, so all bindings below share the page's global lexical scope.
//
// IMPORTANT LOAD-ORDER REQUIREMENT: this file's top-level code calls
// `canvas.addEventListener(...)` immediately (not inside a function), and
// `canvas` is declared in game.js. This file MUST be loaded AFTER game.js
// in game.html (shared/*.js, then audio.js, then game.js, then input.js).
//
// Depends on (declared in game.js, read/written only inside function bodies
// below unless noted, so load order for those references doesn't matter —
// only the canvas.addEventListener calls at the bottom are order-sensitive):
// running, paused, songTime, timingOffset, laneQueues, laneCursor,
// HIT_WINDOWS, HOLD_SCORE, holdHeadMult, combo, maxCombo, score, judged,
// hits, BEAT_MS, showJudge, spawnHitParticles, updateHUD, togglePause,
// _canvasRect, canvas, W, laneW, LANES.
//
// showJudge / spawnHitParticles / updateHUD stay in game.js for now (they're
// "core engine / particle system" per the report, not input) — this file
// owns keysDown / pointerLane / earlyCount / lateCount and the actual
// input-handling + judging logic (tryHit, evaluateTiming, judgeTime,
// recordTimingSide), matching the report's stated scope for input.js.

let earlyCount = 0, lateCount = 0; // 빠름(EARLY) / 느림(LATE) 누적
const keysDown = {0:false, 1:false, 2:false, 3:false}; // 홀드 판정을 위한 현재 누름 상태
const pointerLane = new Map(); // pointerId -> lane (멀티터치 홀드 대응)

// ==================== 입력 ====================
// 보정된 곡 시간 (오프셋 적용) — 판정에만 사용, 노트 위치는 songTime 그대로
function judgeTime(){
  return songTime - timingOffset;
}

// signedDelta = 입력−이상 (>0 LATE, <0 EARLY)
// Formula lives in js/shared/gameplay.js (judgeDelta) so the game and the
// editor's test-play mode can't silently drift apart again — this just
// supplies the game's own HIT_WINDOWS tuning.
function evaluateTiming(signedDelta){
  return judgeDelta(signedDelta, HIT_WINDOWS);
}

function tryHit(lane){
  if(!running || paused) return;
  const jt = judgeTime();
  const q = laneQueues[lane];
  let cursor = laneCursor[lane];
  while(cursor < q.length && q[cursor].judged && !q[cursor].holding) cursor++;
  laneCursor[lane] = cursor;

  let bestNote = null;
  let bestSigned = 0;
  for(let i = cursor; i < q.length; i++){
    const n = q[i];
    if(n.judged || n.holding) continue;
    if(n.hitTime - jt > HIT_WINDOWS.miss) break;
    const signed = jt - n.hitTime;
    if(Math.abs(signed) <= HIT_WINDOWS.miss){
      bestSigned = signed;
      bestNote = n;
      break;
    }
  }
  if(!bestNote){
    judged++;
    combo = 0;
    score = Math.max(0, score - 50);
    showJudge('MISS', '#ff3d81');
    updateHUD();
    return;
  }

  const ev = evaluateTiming(bestSigned);
  if(!ev){
    judged++;
    combo = 0;
    score = Math.max(0, score - 50);
    showJudge('MISS', '#ff3d81');
    updateHUD();
    return;
  }

  if(bestNote.isHold){
    // 헤드 판정: 일반 노트의 일부만 즉시 반영, 품질 배율은 틱·완주에 전달
    bestNote.headHit = true;
    bestNote.holding = true;
    bestNote.headMult = holdHeadMult(ev.judge);
    bestNote.tickScore = 0;
    bestNote.nextTick = bestNote.hitTime + BEAT_MS * 0.5;
    combo++;
    if(combo > maxCombo) maxCombo = combo;
    const comboBonus = Math.min(combo, 50) * 2;
    const headScore = Math.round(ev.points * HOLD_SCORE.headScale) + comboBonus;
    score += headScore;
    recordTimingSide(ev.side);
    showJudge(ev.judge + ' HOLD', ev.color);
    spawnHitParticles(bestNote.lane, ev.color);
    updateHUD();
    return;
  }

  bestNote.judged = true;
  bestNote.hit = true;
  judged++;
  hits++;

  combo++;
  if(combo > maxCombo) maxCombo = combo;
  const comboBonus = Math.min(combo, 50) * 2;
  score += ev.points + comboBonus;

  recordTimingSide(ev.side);
  showJudge(ev.judge, ev.color);
  spawnHitParticles(bestNote.lane, ev.color);
  updateHUD();
}

// 플레이 중에는 표시하지 않고, 결과 화면에서만 집계값을 보여 줌
function recordTimingSide(side){
  if(side === 'EARLY') earlyCount++;
  else if(side === 'LATE') lateCount++;
}

// 키보드
const keyMap = {d:0, f:1, j:2, k:3};
window.addEventListener('keydown', e=>{
  const key = e.key.toLowerCase();
  if(key in keyMap){
    e.preventDefault();
    const lane = keyMap[key];
    if(!keysDown[lane]){
      keysDown[lane] = true;
      tryHit(lane);
    }
  } else if(key === 'p'){
    togglePause();
  }
});
window.addEventListener('keyup', e=>{
  const key = e.key.toLowerCase();
  if(key in keyMap) keysDown[keyMap[key]] = false;
});
window.addEventListener('blur', ()=>{
  // 창 포커스를 잃으면 홀드가 걸린 채로 남지 않도록 전부 해제
  for(const l in keysDown) keysDown[l] = false;
});

// 터치 / 클릭 (홀드 노트를 위해 포인터별 레인을 추적)
function laneFromClientX(clientX){
  // getBoundingClientRect()는 강제 리플로우를 유발한다.
  // 매 pointerdown마다 다시 읽는 대신 resize 시점에만 캐시해 둔다
  // (특히 첫 터치 순간의 스파이크를 없애기 위함).
  if(!_canvasRect) _canvasRect = canvas.getBoundingClientRect();
  const rect = _canvasRect;
  const x = clientX - rect.left;
  const centerX = W/2;
  const totalLaneW = laneW * LANES;
  const startX = centerX - totalLaneW/2;
  if(x < startX || x > startX + totalLaneW) return -1;
  const lane = Math.floor((x - startX) / laneW);
  return Math.max(0, Math.min(3, lane));
}

canvas.addEventListener('pointerdown', e=>{
  if(!running || paused) return;
  const lane = laneFromClientX(e.clientX);
  if(lane === -1) return;
  pointerLane.set(e.pointerId, lane);
  if(!keysDown[lane]){
    keysDown[lane] = true;
    tryHit(lane);
  }
});

function releasePointer(e){
  const lane = pointerLane.get(e.pointerId);
  if(lane === undefined) return;
  pointerLane.delete(e.pointerId);
  // 같은 레인을 누르고 있는 다른 포인터(멀티터치)가 없을 때만 해제
  let stillDown = false;
  for(const l of pointerLane.values()){
    if(l === lane){ stillDown = true; break; }
  }
  if(!stillDown) keysDown[lane] = false;
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);
canvas.addEventListener('pointerleave', releasePointer);
