// Vercel Serverless Function (관리자용, 수동 실행)
// DART 회사목록 전체를 다운로드해서 Supabase dart_corp_codes 테이블에 한 번 저장한다.
// 이후 실제 조회(/api/dart-lookup)는 이 캐시 테이블만 빠르게 조회하므로,
// 매번 대용량 파일을 처리하다 서버가 죽는 문제를 근본적으로 없앤다.
// 데이터가 오래됐다고 판단될 때(예: 몇 달에 한 번) 이 주소를 브라우저로 직접 열어 재실행하면 된다.

import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const apiKey = process.env.DART_API_KEY
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()

  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY가 설정되지 않았습니다.' })
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되지 않았습니다.' })

  try {
    const dartRes = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`)
    if (!dartRes.ok) throw new Error('DART corpCode 다운로드 실패')
    const buf = await dartRes.arrayBuffer()
    const zip = await JSZip.loadAsync(buf)
    const xmlFile = zip.file('CORPCODE.xml')
    if (!xmlFile) throw new Error('corpCode.xml을 zip에서 찾을 수 없습니다')
    const xmlText = await xmlFile.async('text')
    const parser = new XMLParser({ parseTagValue: false })
    const parsed = parser.parse(xmlText)
    const list = parsed?.result?.list || []
    const corpList = Array.isArray(list) ? list : [list]

    const rows = corpList
      .filter((c) => c.corp_code && c.corp_name)
      .map((c) => ({
        corp_code: c.corp_code,
        corp_name: c.corp_name,
        stock_code: c.stock_code ? String(c.stock_code).trim() || null : null,
        updated_at: new Date().toISOString(),
      }))

    const supabase = createClient(supabaseUrl, supabaseKey)

    // 대량 데이터라 한 번에 넣지 않고 나눠서 저장하되, 왕복 횟수를 줄이기 위해 여러 묶음을 동시에 병렬 처리
    const CHUNK = 1000
    const PARALLEL = 8
    const chunks = []
    for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK))

    let inserted = 0
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const batch = chunks.slice(i, i + PARALLEL)
      const results = await Promise.all(
        batch.map((chunk) => supabase.from('dart_corp_codes').upsert(chunk, { onConflict: 'corp_code' }))
      )
      const err = results.find((r) => r.error)
      if (err) throw new Error(`저장 중 오류 (${i}번째 묶음 그룹): ${err.error.message}`)
      inserted += batch.reduce((sum, c) => sum + c.length, 0)
    }

    return res.status(200).json({ success: true, total: rows.length, inserted })
  } catch (err) {
    return res.status(500).json({ error: '캐시 갱신 중 오류: ' + err.message })
  }
}
