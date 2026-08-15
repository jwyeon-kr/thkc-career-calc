// Vercel Serverless Function (관리자용, 수동 실행)
// DART 회사목록 전체를 Supabase dart_corp_codes 테이블에 저장한다.
// 데이터가 10만 건 이상이라 한 번의 요청(60초 제한)으로 전부 끝내는 것은 무리이므로,
// 조금씩(offset/limit) 나눠서 여러 번 호출하는 방식으로 설계했다.
// 브라우저로 이 주소를 그냥 열면, 자동으로 이어서 호출하며 진행 상황을 보여주는 화면이 뜬다.

import JSZip from 'jszip'
import { createClient } from '@supabase/supabase-js'

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// fast-xml-parser로 트리 전체를 재구성하면 10만 건 이상에서 느려서(시간초과 원인으로 추정)
// 필요한 3개 필드만 정규식으로 직접 추출하는 훨씬 가벼운 방식으로 변경
function extractCorpListFast(xmlText) {
  const corpCodes = [...xmlText.matchAll(/<corp_code>([^<]*)<\/corp_code>/g)].map((m) => m[1])
  const corpNames = [...xmlText.matchAll(/<corp_name>([^<]*)<\/corp_name>/g)].map((m) => decodeXmlEntities(m[1]))
  const stockCodes = [...xmlText.matchAll(/<stock_code>([^<]*)<\/stock_code>/g)].map((m) => m[1].trim())

  const result = []
  for (let i = 0; i < corpCodes.length; i++) {
    result.push({ corp_code: corpCodes[i], corp_name: corpNames[i], stock_code: stockCodes[i] || null })
  }
  return result
}

async function fetchAllRows(apiKey, timing) {
  console.log('[dart-refresh] 1. DART 다운로드 시작')
  const t0 = Date.now()
  let dartRes
  try {
    dartRes = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`, {
      signal: AbortSignal.timeout(20000), // 20초 안에 응답 없으면 명확히 실패 처리 (무한대기 방지)
    })
  } catch (err) {
    throw new Error(`DART 서버 응답 없음(${Date.now() - t0}ms 대기 후 포기): ${err.name === 'TimeoutError' ? '20초 시간제한 초과' : err.message}`)
  }
  if (!dartRes.ok) throw new Error('DART corpCode 다운로드 실패 (HTTP ' + dartRes.status + ')')
  const buf = await dartRes.arrayBuffer()
  timing.download = Date.now() - t0
  console.log(`[dart-refresh] 2. 다운로드 완료 (${timing.download}ms, ${buf.byteLength}바이트)`)

  const t1 = Date.now()
  const zip = await JSZip.loadAsync(buf)
  const xmlFile = zip.file('CORPCODE.xml')
  if (!xmlFile) throw new Error('corpCode.xml을 zip에서 찾을 수 없습니다')
  const xmlText = await xmlFile.async('text')
  timing.unzip = Date.now() - t1
  console.log(`[dart-refresh] 3. 압축해제 완료 (${timing.unzip}ms, XML길이 ${xmlText.length}자)`)

  const t2 = Date.now()
  const rawList = extractCorpListFast(xmlText)
  timing.parse = Date.now() - t2
  console.log(`[dart-refresh] 4. 파싱 완료 (${timing.parse}ms, ${rawList.length}건)`)

  const t3 = Date.now()
  const rows = rawList
    .filter((c) => c.corp_code && c.corp_name)
    .map((c) => ({
      corp_code: c.corp_code,
      corp_name: c.corp_name,
      stock_code: c.stock_code || null,
      updated_at: new Date().toISOString(),
    }))
  timing.map = Date.now() - t3
  console.log(`[dart-refresh] 5. 정제 완료 (${timing.map}ms, 최종 ${rows.length}건)`)
  return rows
}

export default async function handler(req, res) {
  const apiKey = process.env.DART_API_KEY
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()

  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY가 설정되지 않았습니다.' })
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되지 않았습니다.' })

  // Vercel Cron이 자동으로 호출할 때는 User-Agent에 'vercel-cron'이 포함됨.
  // 이 경우 offset/limit 분할 없이 전체를 한 번에 처리한다 (실측상 전체 처리시간이 약 20초 내외라 60초 제한 안에 충분히 끝남).
  const isCronCall = (req.headers['user-agent'] || '').includes('vercel-cron')
  const isJsonCall = req.query.format === 'json' || isCronCall
  const offset = isCronCall ? 0 : parseInt(req.query.offset, 10) || 0
  const limit = isCronCall ? Number.MAX_SAFE_INTEGER : parseInt(req.query.limit, 10) || 15000

  if (isCronCall) {
    console.log('[dart-refresh] Vercel Cron에 의한 자동 정기 갱신 시작')
  }

  if (!isJsonCall) {
    // 브라우저로 직접 열었을 때: 자동으로 이어서 호출하며 진행상황을 보여주는 화면
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.status(200).send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>DART 캐시 채우기</title>
<style>body{font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto} #log{white-space:pre-line;font-size:14px;line-height:1.8;background:#f5f5f5;padding:16px;border-radius:8px;margin-top:16px}</style>
</head><body>
<h2>DART 회사목록 캐시 채우는 중...</h2>
<p>이 창을 닫지 말고 완료될 때까지 기다려주세요. 시간이 다소 걸릴 수 있습니다.</p>
<div id="log">시작합니다...</div>
<script>
const logEl = document.getElementById('log');
function log(msg) { logEl.textContent += '\\n' + msg; }
async function step(offset) {
  log('처리 중... (offset=' + offset + ')');
  try {
    const res = await fetch('/api/dart-refresh-cache?format=json&offset=' + offset + '&limit=15000');
    if (!res.ok) {
      const text = await res.text();
      log('❌ 서버 오류 (HTTP ' + res.status + '): ' + text.slice(0, 300));
      return;
    }
    const data = await res.json();
    if (data.error) { log('❌ 오류 발생: ' + data.error); return; }
    log('완료: ' + data.inserted + '건 저장 (전체 ' + data.total + '건 중 ' + (offset + data.inserted) + '건 진행, 처리시간 ' + JSON.stringify(data.timing_ms) + ')');
    if (data.done) {
      log('\\n✅ 전체 완료되었습니다! 이 창을 닫으셔도 됩니다.');
    } else {
      step(data.nextOffset);
    }
  } catch (err) {
    log('❌ 요청 실패(네트워크 또는 시간초과): ' + err.message);
  }
}
step(0);
</script>
</body></html>`)
  }

  try {
    console.log(`[dart-refresh] 요청 받음 (offset=${offset}, limit=${limit})`)
    const timing = {}
    const rows = await fetchAllRows(apiKey, timing)
    const slice = rows.slice(offset, offset + limit)

    const supabase = createClient(supabaseUrl, supabaseKey)
    const CHUNK = 1000
    const PARALLEL = 8
    const chunks = []
    for (let i = 0; i < slice.length; i += CHUNK) chunks.push(slice.slice(i, i + CHUNK))

    const tUpload = Date.now()
    console.log(`[dart-refresh] 6. 저장 시작 (offset=${offset}, ${slice.length}건, ${chunks.length}묶음)`)
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const batch = chunks.slice(i, i + PARALLEL)
      const results = await Promise.all(
        batch.map((chunk) => supabase.from('dart_corp_codes').upsert(chunk, { onConflict: 'corp_code' }))
      )
      const err = results.find((r) => r.error)
      if (err) throw new Error('저장 중 오류: ' + err.error.message)
      console.log(`[dart-refresh]    - ${Math.min(i + PARALLEL, chunks.length)}/${chunks.length}묶음 완료 (${Date.now() - tUpload}ms 경과)`)
    }
    timing.upload = Date.now() - tUpload
    console.log(`[dart-refresh] 7. 저장 완료 (${timing.upload}ms)`)

    const nextOffset = offset + limit
    const done = nextOffset >= rows.length
    return res.status(200).json({
      total: rows.length,
      offset,
      inserted: slice.length,
      nextOffset: done ? null : nextOffset,
      done,
      timing_ms: timing,
    })
  } catch (err) {
    return res.status(500).json({ error: '캐시 갱신 중 오류: ' + err.message })
  }
}
