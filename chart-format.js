// chart-format.js — shared chart text codec, used by both game.html (read-only)
// and editor.html (read + write).
// 압축 예: 1.30-4-0@0,1@0.5,2@1:1.5,3@2|176|16

// 단일 버전 필드. 예전엔 컴팩트 문자열에서 만든 데이터는 항상 version:3,
// 에디터가 저장하는 JSON은 항상 version:4로 서로 다른 값을 하드코딩해서
// "버전"이 실제로는 아무것도 검증하지 않는 장식용 숫자였다 (report 2.7).
// 이제 둘 다 이 상수를 쓰고, JSON을 파싱할 때는 이 값보다 새로운 버전이면
// (미래의 이 코드가 모르는 형식일 수 있으므로) 명확히 에러를 낸다.
const CHART_FORMAT_VERSION = 4;

/**
 * Parse a chart text string (compact format or raw JSON) into a chart data object.
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.bpm] fallback bpm when the compact string omits it (default 176)
 * @param {number} [opts.bars] fallback bar count when the compact string omits it (default 16)
 * @param {boolean} [opts.strict] if true, throw on a malformed note token instead of
 *   silently dropping it, and require JSON input to already contain a `notes` array.
 *   The editor uses strict:true (better feedback while authoring); the game uses the
 *   lenient default (best-effort playback of whatever chart text it's given).
 */
function parseChartText(text, opts){
  opts = opts || {};
  const fallbackBpm = opts.bpm != null ? opts.bpm : 176;
  const fallbackBars = opts.bars != null ? opts.bars : 16;
  const strict = !!opts.strict;

  text = String(text).trim();
  if(!text) throw new Error('빈 텍스트');

  // JSON
  if(text[0] === '{'){
    let data;
    try{ data = JSON.parse(text); }
    catch(err){ throw new Error('JSON 파싱 실패: '+err.message); }
    if(strict && !data.notes) throw new Error('notes 없음 (JSON에 "notes" 배열이 있어야 합니다)');
    if(data.version != null && Number(data.version) > CHART_FORMAT_VERSION){
      throw new Error('지원하지 않는 차트 버전: v'+data.version+' (이 코드가 지원하는 최대 버전은 v'+CHART_FORMAT_VERSION+')');
    }
    return data;
  }

  // compact: speed-count-notes|bpm|bars
  // notes: lane@beat or lane@beat:hold , 쉼표 구분
  const main = text.split('|');
  const m = main[0].match(/^([\d.]+)-(\d+)-(.*)$/);
  if(!m){
    throw new Error(
      '첫 구간 형식이 "속도-개수-좌표"가 아닙니다: "'+main[0]+'"  '
      + '(예: 1.30-2-0@0,1@1:2|176|16)'
    );
  }
  const speed = parseFloat(m[1]);
  if(!isFinite(speed)) throw new Error('속도 값이 숫자가 아닙니다: "'+m[1]+'"');
  const declaredCount = parseInt(m[2], 10);
  const body = m[3] || '';
  const badTokens = [];
  const notes = body ? body.split(',').map((tok, idx)=>{
    const raw = tok.trim();
    if(!raw) return null;
    const segs = raw.split(':');
    const at = segs[0].split('@');
    if(at.length < 2 || at[0] === '' || at[1] === ''){
      badTokens.push('#'+(idx+1)+' "'+raw+'" (lane@beat 형식이어야 함)');
      if(strict) throw new Error('노트 '+(idx+1)+'번째 좌표 형식이 잘못됨: "'+raw+'" (lane@beat 필요, 예: 2@4)');
      return null;
    }
    const lane = parseInt(at[0], 10);
    const t = parseFloat(at[1]);
    if(!isFinite(lane) || lane < 0 || lane > 3 || !isFinite(t)){
      badTokens.push('#'+(idx+1)+' "'+raw+'" (lane은 0-3, beat는 숫자)');
      if(strict) throw new Error('노트 '+(idx+1)+'번째 값이 잘못됨: "'+raw+'" (lane 0-3, beat는 숫자)');
      return null;
    }
    const n = { lane, t };
    if(segs[1] != null && segs[1] !== ''){
      const hold = parseFloat(segs[1]);
      if(isFinite(hold) && hold > 0) n.hold = hold;
    }
    return n;
  }).filter(Boolean) : [];
  if(strict && isFinite(declaredCount) && declaredCount !== notes.length){
    // 개수 필드는 지금까지 아무 데도 안 쓰여서 오탈자를 조용히 통과시켰다 (report 2.7).
    // strict(에디터)에서는 실제 파싱된 노트 수와 다르면 바로 알려준다.
    throw new Error('선언된 노트 개수('+declaredCount+')와 실제 파싱된 노트 수('+notes.length+')가 다릅니다.');
  }
  const data = {
    version: CHART_FORMAT_VERSION,
    speed: isFinite(speed) ? speed : 1,
    bpm: main[1] != null ? parseInt(main[1],10) : fallbackBpm,
    bars: main[2] != null ? parseInt(main[2],10) : fallbackBars,
    notes
  };
  for(let i=3;i<main.length;i++){
    const p = main[i];
    if(p.indexOf('s:')===0) data.songId = p.slice(2);
    else if(p.indexOf('n:')===0){
      try{ data.songName = decodeURIComponent(p.slice(2)); }
      catch(err){
        if(strict) throw new Error('songName(n:) URL 디코딩 실패: '+err.message);
        data.songName = p.slice(2);
      }
    }
    else if(p.indexOf('d:')===0) data.songDuration = parseFloat(p.slice(2));
    else if(p.indexOf('v:')===0){
      data.speedTriggers = p.slice(2).split(',').map(tok=>{
        const parts = tok.trim().split('@');
        if(parts.length < 2) return null;
        return { t: parseFloat(parts[0]), rate: parseFloat(parts[1]) };
      }).filter(tr => tr && isFinite(tr.t) && isFinite(tr.rate));
    }
    else if(strict){
      throw new Error('알 수 없는 구간: "'+p+'" (s:/n:/d:/v: 중 하나로 시작해야 함)');
    }
  }
  return data;
}

/**
 * Encode a chart data object into the compact text format.
 * Editor-only in practice (the game never writes charts), but lives here since
 * it's the inverse of parseChartText and both belong to the same codec.
 * @param {object} data
 * @param {number} [fallbackSpeed] used when data.speed is not set
 * @param {number} [fallbackBpm] used when data.bpm is not set
 * @param {number} [fallbackBars] used when data.bars is not set
 */
function encodeCompact(data, fallbackSpeed, fallbackBpm, fallbackBars){
  const s = (data.speed != null ? data.speed : fallbackSpeed).toFixed(2);
  const ns = (data.notes || []).map(n=>{
    const t = Math.round(Number(n.t)*1000)/1000;
    if(n.hold) return n.lane + '@' + t + ':' + (Math.round(Number(n.hold)*1000)/1000);
    return n.lane + '@' + t;
  });
  let out = s + '-' + ns.length + '-' + ns.join(',') + '|' + (data.bpm||fallbackBpm) + '|' + (data.bars||fallbackBars);
  if(data.songId){
    out += '|s:' + data.songId;
    if(data.songName) out += '|n:' + encodeURIComponent(data.songName);
    if(data.songDuration) out += '|d:' + Number(data.songDuration).toFixed(2);
  }
  if(data.speedTriggers && data.speedTriggers.length){
    const vs = data.speedTriggers.map(tr=>{
      const t = Math.round(Number(tr.t)*1000)/1000;
      const r = Math.round(Number(tr.rate)*100)/100;
      return t + '@' + r;
    }).join(',');
    out += '|v:' + vs;
  }
  return out;
}

/** 겹침 제거·정리 (가져오기용) */
function sanitizeNotes(list){
  const out = [];
  const sorted = (list || []).slice().sort((a,b)=> a.t - b.t || a.lane - b.lane);
  for(const n of sorted){
    const lane = n.lane|0;
    if(lane < 0 || lane > 3) continue;
    const t = Number(n.t);
    if(!isFinite(t) || t < 0) continue;
    let hold = n.hold ? Number(n.hold) : 0;
    if(!isFinite(hold) || hold < 0) hold = 0;
    let ok = true;
    for(const o of out){
      if(o.lane !== lane) continue;
      const b1 = t + hold, b2 = o.t + (o.hold || 0);
      if(t < b2 - 1e-9 && o.t < b1 - 1e-9){ ok = false; break; }
    }
    if(ok) out.push(hold > 0 ? { t, lane, hold } : { t, lane });
  }
  return out;
}
