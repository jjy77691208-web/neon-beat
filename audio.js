// audio.js — game-specific Web Audio synth engine + metronome scheduling.
// Extracted verbatim from the game.html monolith (see
// neon-beat-modularization-report.txt). Loaded as a plain top-level script
// (no IIFE wrapper) so its `let`/`function` bindings share the same global
// lexical scope as game.js, exactly like the js/shared/*.js modules already
// do — this is a relocation, not a rewrite: no renamed variables, no
// changed constants, no changed call order.
//
// Depends on (declared elsewhere in game.js, referenced only inside function
// bodies below, so load order just needs audio.js before game.js): `muted`,
// `running`, `paused`, `useMusicTrack`, `songTime`, `PREP_MS`, `BEAT_MS`.

// ==================== Audio (Web Audio 비트) ====================
let audioCtx = null;
let masterGain = null;
let nextBeatTime = 0;
let beatCount = 0;

let _snareBuffer = null, _hatBuffer = null;
// 반환값: 오디오 사용 가능 여부. AudioContext 생성이 막혀 있는(구형/일부 잠금 환경)
// 곳에서도 예외가 startGame()까지 전파돼 "시작 버튼을 눌러도 아무 반응 없음"이
// 되는 것을 막는다 — 실패 시 audioCtx는 null로 유지되고, 무음으로라도 진행한다.
function initAudio(){
  if(audioCtx) return true;
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : 0.35;
    masterGain.connect(audioCtx.destination);
    // 노이즈 버퍼(스네어/하이햇)는 한 번만 생성해 재사용한다.
    // AudioBuffer는 여러 BufferSourceNode에서 동시에 공유해도 안전하며(읽기 전용 재생),
    // 매 비트마다 새 버퍼를 만들고 랜덤값을 채우는 비용(GC 압박 → 안드로이드 프레임 드랍)을 없앤다.
    _snareBuffer = makeNoiseBuffer(0.15);
    _hatBuffer = makeNoiseBuffer(0.2);
    return true;
  }catch(err){
    audioCtx = null;
    masterGain = null;
    return false;
  }
}

function makeNoiseBuffer(seconds){
  const bufferSize = Math.max(1, Math.round(audioCtx.sampleRate * seconds));
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i=0;i<bufferSize;i++) data[i] = Math.random()*2-1;
  return buffer;
}

function playKick(time){
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
  g.gain.setValueAtTime(0.9, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
  osc.connect(g); g.connect(masterGain);
  osc.start(time); osc.stop(time + 0.26);
}

function playSnare(time){
  const noise = audioCtx.createBufferSource();
  noise.buffer = _snareBuffer;
  const g = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass'; filter.frequency.value = 1000;
  g.gain.setValueAtTime(0.45, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
  noise.connect(filter); filter.connect(g); g.connect(masterGain);
  noise.start(time); noise.stop(time + 0.15);
}

function playHat(time, open=false){
  const noise = audioCtx.createBufferSource();
  noise.buffer = _hatBuffer;
  const g = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass'; filter.frequency.value = 7000;
  g.gain.setValueAtTime(open ? 0.22 : 0.18, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + (open ? 0.18 : 0.05));
  noise.connect(filter); filter.connect(g); g.connect(masterGain);
  noise.start(time); noise.stop(time + (open ? 0.2 : 0.06));
}

function playSynth(time, freq, dur=0.12){
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(0.12, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + dur);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 1800;
  osc.connect(filter); filter.connect(g); g.connect(masterGain);
  osc.start(time); osc.stop(time + dur + 0.02);
}

// 스케줄러: 최소 드럼만 (신스/하이햇은 렉 유발 → 제거)
let _schedSkip = 0;
function scheduleMusic(){
  if(!running || paused || !audioCtx || useMusicTrack) return;
  if(songTime < PREP_MS + 150) return;
  // 2프레임에 한 번만
  if((++_schedSkip) & 1) return;
  const now = audioCtx.currentTime;
  const lookAhead = 0.08;
  while(nextBeatTime < now + lookAhead){
    const beatInBar = beatCount % 4;
    if(beatInBar === 0 || beatInBar === 2) playKick(nextBeatTime);
    else playSnare(nextBeatTime);
    nextBeatTime += BEAT_MS / 1000;
    beatCount++;
  }
}
