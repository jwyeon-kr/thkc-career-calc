// Vercel Serverless Function
// 회사명으로 DART(전자공시시스템)를 조회하여 상장여부/매출액을 자동조회한다.
// DART_API_KEY는 서버 환경변수로만 존재하며 프론트엔드에 노출되지 않는다.
//
// 중요: DART는 "상장사 + 외부감사 대상 비상장사"만 데이터를 제공한다.
// 조회 실패는 오류가 아니라 정상적인 상황(소규모 비상장기업)이므로,
// 이 경우 절대 임의의 값을 추정하지 않고 명시적으로 실패를 반환한다.
//
// 회사명 매칭은 Supabase에 미리 저장해둔 캐시 테이블(dart_corp_codes)만 조회한다.
// (매번 10만 건 이상의 전체 목록을 다운로드/파싱하면 서버가 타임아웃/메모리 부족으로 죽는 문제가 있어
//  /api/dart-refresh-cache 로 미리 채워둔 캐시만 빠르게 조회하는 방식으로 변경함)
//
// [2026-08-15 수정1] fetchRevenue: 최근 3개년(currentYear-1~3) 순차 탐색 방식에서
// "지원 시점 기준 가장 최근 확정된 사업연도"(currentYear - 1) 단일 연도만 조회하는 방식으로 변경.
//
// [2026-08-15 수정2] normalizeName: 이력서에서 추출된 회사명에 "프레스티지바이오파마아이디씨㈜
// (Prestige BioPharma IDC Co.,Ltd)"처럼 괄호 안 영문 부가설명이 붙어있으면 DART 캐시(순수 한글명)와
// 매칭이 안 되던 버그 수정. 괄호(전각/반각) 안 내용을 전부 제거하도록 정규화 로직 강화.

import { createClient } from '@supabase/supabase-js'
import JSZip from 'jszip'
import { lookupIndustryThreshold } from '../shared/industryScaleTable.js'

const REVENUE_ACCOUNT_NAMES = ['매출액', '수익(매출액)', '영업수익', '매출']
const STATEMENT_TYPES = new Set(['IS', 'CIS']) // 손익계산서 / 포괄손익계산서
const ASSET_ACCOUNT_NAMES = ['자산총계']
const BS_STATEMENT_TYPES = new Set(['BS', 'CFS']) // 재무상태표 / 연결재무상태표

function normalizeName(name) {
  return (name || '')
    .replace(/[（(][^)）]*[)）]/g, '') // 괄호(전각/반각) 안 내용 전부 제거 - 영문 회사명, 부가설명 등
    .replace(/\(주\)|주식회사|㈜/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

async function findCandidatesFromCache(supabase, inputName) {
  const target = normalizeName(inputName)
  if (!target) return { candidates: [], cacheEmpty: false }

  // 캐시 테이블이 비어있는지 먼저 확인 (아직 /api/dart-refresh-cache를 한 번도 안 돌린 경우 안내하기 위함)
  const { count } = await supabase.from('dart_corp_codes').select('*', { count: 'exact', head: true })
  if (!count) return { candidates: [], cacheEmpty: true }

  // ilike로 넓게 후보를 가져온 뒤, 공백/㈜ 등을 뗀 정규화 비교로 정확히 다시 거름
  // (1차 검색부터 정규화된 이름을 써야 함: "삼성전자㈜"로 입력해도 DB의 "삼성전자"가 걸리도록)
  const { data, error } = await supabase
    .from('dart_corp_codes')
    .select('corp_code, corp_name, stock_code')
    .ilike('corp_name', `%${target}%`)
    .limit(50)
  if (error) throw new Error('캐시 조회 오류: ' + error.message)

  const exact = data.filter((c) => normalizeName(c.corp_name) === target)
  if (exact.length > 0) return { candidates: exact, cacheEmpty: false }

  const partial = data.filter(
    (c) => normalizeName(c.corp_name).includes(target) || target.includes(normalizeName(c.corp_name))
  )
  return { candidates: partial.slice(0, 8), cacheEmpty: false }
}

function mapCorpCls(code) {
  const map = { Y: '코스피', K: '코스닥', N: '코넥스', E: '기타법인' }
  return map[code] || null
}

async function fetchCompanyOverview(apiKey, corpCode) {
  try {
    const res = await fetch(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${apiKey}&corp_code=${corpCode}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.status !== '000') return null
    return {
      market: mapCorpCls(data.corp_cls),
      establishedDate: data.est_dt || null, // YYYYMMDD 형식
      industryCode: data.induty_code || null, // 통계청 표준산업분류 코드 (기업규모 판정용)
    }
  } catch {
    return null // 참고정보이므로 실패해도 전체 조회를 막지 않음
  }
}

// 지원 시점 기준 가장 최근 확정된 사업연도(currentYear - 1) 단일 연도만 조회.
// 예: 2026년에 조회하면 2025년 사업보고서만 봄. 해당 연도 데이터가 없으면 바로 실패 반환.
// [2026-08-23 수정] 매출액과 함께 자산총계도 같은 응답에서 함께 추출 (기업규모 판정용, API 호출 추가 없음).
// ⚠️ 중소기업기본법상 "평균매출액등"은 원칙적으로 직전 3개 사업연도 평균이지만,
// 이 함수는 2026-08-15 변경 이후 직전 1개년만 조회한다 — 자동판정은 참고용이며 정확한 3년 평균이 아니다.
async function fetchRevenueAndAssets(apiKey, corpCode) {
  const targetYear = new Date().getFullYear() - 1

  const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bsns_year=${targetYear}&reprt_code=11011`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  } catch {
    return null
  }
  if (!res.ok) return null
  const data = await res.json()
  if (data.status !== '000' || !Array.isArray(data.list)) return null

  const revenueRow = data.list.find(
    (row) => STATEMENT_TYPES.has(row.sj_div) && REVENUE_ACCOUNT_NAMES.includes((row.account_nm || '').trim())
  )
  const assetRow = data.list.find(
    (row) => BS_STATEMENT_TYPES.has(row.sj_div) && ASSET_ACCOUNT_NAMES.includes((row.account_nm || '').trim())
  )

  const result = { year: targetYear, amount: null, assetAmount: null }
  if (revenueRow && revenueRow.thstrm_amount) {
    const amount = Number(String(revenueRow.thstrm_amount).replace(/,/g, ''))
    if (!isNaN(amount)) result.amount = amount
  }
  if (assetRow && assetRow.thstrm_amount) {
    const assetAmount = Number(String(assetRow.thstrm_amount).replace(/,/g, ''))
    if (!isNaN(assetAmount)) result.assetAmount = assetAmount
  }
  return result.amount != null ? result : null
}

// [2026-08-23 추가] 사업보고서 계열 API(fnlttSinglAcnt)는 "정기보고서"(사업/반기/분기보고서)에만
// 연결된 XBRL만 조회한다 — 감사보고서만 제출하는 비상장 중소/중견기업(THKC 지원자 다수가 여기 해당)은
// 이 API로는 절대 조회되지 않는다(연도를 바꿔도 소용없음. 애초에 다른 데이터 창고를 봄).
// 아래는 "감사보고서/연결감사보고서" 제출 이력 자체는 확실하게 찾아서 원문 링크를 안내하고,
// 거기 첨부된 문서에서 매출액/자산총계를 최선노력으로(비공식, 검증 필요) 추출 시도한다.
async function findAuditReportFiling(apiKey, corpCode) {
  const today = new Date()
  const end = today.toISOString().slice(0, 10).replace(/-/g, '')
  const start = new Date(today.getFullYear() - 2, today.getMonth(), today.getDate())
    .toISOString().slice(0, 10).replace(/-/g, '')
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bgn_de=${start}&end_de=${end}&pblntf_ty=F&page_count=100`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  } catch {
    return null
  }
  if (!res.ok) return null
  const data = await res.json()
  if (data.status !== '000' || !Array.isArray(data.list)) return null

  const filings = data.list.filter((row) => (row.report_nm || '').includes('감사보고서'))
  if (filings.length === 0) return null

  // 최신 제출건 우선, 동일 접수일이면 연결감사보고서를 개별감사보고서보다 우선
  filings.sort((a, b) => {
    if (a.rcept_dt !== b.rcept_dt) return b.rcept_dt.localeCompare(a.rcept_dt)
    const aConsolidated = a.report_nm.includes('연결') ? 1 : 0
    const bConsolidated = b.report_nm.includes('연결') ? 1 : 0
    return bConsolidated - aConsolidated
  })
  const top = filings[0]
  return {
    rcept_no: top.rcept_no,
    report_nm: top.report_nm,
    rcept_dt: top.rcept_dt,
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${top.rcept_no}`,
  }
}

// 실험적 자동추출 — 정식 XBRL 파싱이 아니라, 원문 첨부파일(ZIP) 안 텍스트에서
// "매출액"/"자산총계" 라벨 뒤에 나오는 숫자를 정규식으로 찾는 방식이다(정확도 보장 안 됨).
// 실패하면 조용히 null을 반환하고, 화면에서는 항상 원문 링크(findAuditReportFiling의 url)를
// 함께 보여줘서 사람이 대조 확인하도록 한다 — 이 값만으로 매출구간을 자동 확정하지 않는다.
async function tryExtractFromAuditReport(apiKey, rceptNo) {
  const url = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${apiKey}&rcept_no=${rceptNo}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  } catch {
    return null
  }
  if (!res.ok) return null

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.slice(0, 2).toString() !== 'PK') return null // ZIP이 아니면(에러 응답 등) 포기

  let allText = ''
  try {
    const zip = await JSZip.loadAsync(buf)
    for (const filename of Object.keys(zip.files)) {
      const file = zip.files[filename]
      if (file.dir) continue
      try {
        allText += (await file.async('string')) + '\n'
      } catch {
        // 이미지 등 텍스트로 못 읽는 첨부는 건너뜀
      }
    }
  } catch {
    return null
  }
  if (!allText) return null

  const flat = allText.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;/g, ' ')

  function extractNumber(pattern) {
    const m = flat.match(pattern)
    if (!m) return null
    const n = Number(m[1].replace(/,/g, ''))
    return !isNaN(n) && n > 0 && n < 900_000_000_000_000 ? n : null // 900조원 미만 sanity check
  }
  const revenue = extractNumber(/매\s*출\s*액[^0-9\-]{0,60}?([\d,]{7,})/)
  const asset = extractNumber(/자\s*산\s*총\s*계[^0-9\-]{0,60}?([\d,]{7,})/)
  return revenue != null || asset != null ? { revenue, asset } : null
}

export default async function handler(req, res) {
  const companyName = req.method === 'GET' ? req.query.company : req.body?.company
  const explicitCorpCode = req.method === 'GET' ? req.query.corp_code : req.body?.corp_code

  const apiKey = process.env.DART_API_KEY
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()
  if (!apiKey) return res.status(500).json({ error: 'DART_API_KEY가 서버에 설정되어 있지 않습니다.' })
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되어 있지 않습니다.' })

  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    let corp

    if (explicitCorpCode) {
      const { data, error } = await supabase
        .from('dart_corp_codes')
        .select('corp_code, corp_name, stock_code')
        .eq('corp_code', explicitCorpCode)
        .maybeSingle()
      if (error) throw new Error('캐시 조회 오류: ' + error.message)
      if (!data) return res.status(200).json({ found: false, reason: '선택한 회사 코드를 찾을 수 없습니다.' })
      corp = data
    } else {
      if (!companyName || !companyName.trim()) {
        return res.status(400).json({ error: '회사명이 필요합니다.' })
      }
      const { candidates, cacheEmpty } = await findCandidatesFromCache(supabase, companyName)

      if (cacheEmpty) {
        return res.status(200).json({
          found: false,
          reason: '회사목록 캐시가 아직 준비되지 않았습니다. 관리자가 /api/dart-refresh-cache를 먼저 실행해야 합니다. 지금은 매출구간을 직접 선택해주세요.',
        })
      }

      if (candidates.length === 0) {
        return res.status(200).json({
          found: false,
          reason: 'DART에 등록되지 않은 회사입니다 (상장사 또는 외부감사대상 비상장사만 조회 가능). 매출구간을 직접 선택해주세요.',
        })
      }

      if (candidates.length > 1) {
        return res.status(200).json({
          found: false,
          ambiguous: true,
          candidates: candidates.map((c) => ({
            corp_code: c.corp_code,
            corp_name: c.corp_name,
            stock_code: c.stock_code ? String(c.stock_code).trim() : null,
          })),
          reason: '동일/유사 이름의 회사가 여러 건 조회되었습니다. 정확한 회사를 선택해주세요.',
        })
      }
      corp = candidates[0]
    }

    const isListed = !!(corp.stock_code && String(corp.stock_code).trim())
    const [revenueResult, overview] = await Promise.all([
      fetchRevenueAndAssets(apiKey, corp.corp_code),
      fetchCompanyOverview(apiKey, corp.corp_code),
    ])
    const industryThreshold = overview?.industryCode ? lookupIndustryThreshold(overview.industryCode) : null

    if (!revenueResult) {
      // 사업보고서 계열에서 못 찾았다고 바로 포기하지 않고, 감사보고서 제출 이력을 확인한다
      // (THKC 지원자 다수가 사업보고서는 안 내고 감사보고서만 내는 비상장 중소/중견기업일 가능성이 높음).
      const auditFiling = await findAuditReportFiling(apiKey, corp.corp_code).catch(() => null)
      const auditExtract = auditFiling
        ? await tryExtractFromAuditReport(apiKey, auditFiling.rcept_no).catch(() => null)
        : null

      const reason = auditFiling
        ? `사업보고서 계열 데이터는 없지만, 감사보고서(${auditFiling.rcept_dt} 제출, "${auditFiling.report_nm}")가 확인됩니다. 자동추출은 정식 API가 아니라 참고용이니, 아래 원문 링크에서 매출액·자산총액을 직접 확인 후 입력해주세요.`
        : `회사는 조회되었으나 ${new Date().getFullYear() - 1}년 재무제표에서 매출액을 찾지 못했고, 감사보고서 제출 이력도 확인되지 않았습니다. 매출구간은 필수가 아니므로 비워두고 계산을 진행할 수 있습니다.`

      return res.status(200).json({
        found: true,
        corp_name: corp.corp_name,
        corp_code: corp.corp_code,
        is_listed: isListed,
        market: overview?.market || null,
        established_date: overview?.establishedDate || null,
        industry_code: overview?.industryCode || null,
        industry_threshold: industryThreshold,
        revenue_found: false,
        reason,
        audit_report: auditFiling,
        audit_extract_experimental: auditExtract,
      })
    }

    return res.status(200).json({
      found: true,
      corp_name: corp.corp_name,
      corp_code: corp.corp_code,
      is_listed: isListed,
      market: overview?.market || null,
      established_date: overview?.establishedDate || null,
      industry_code: overview?.industryCode || null,
      industry_threshold: industryThreshold,
      revenue_found: true,
      revenue_amount: revenueResult.amount,
      revenue_year: revenueResult.year,
      asset_amount: revenueResult.assetAmount,
    })
  } catch (err) {
    return res.status(500).json({ error: 'DART 조회 중 오류: ' + err.message })
  }
}
