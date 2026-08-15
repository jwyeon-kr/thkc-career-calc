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

import { createClient } from '@supabase/supabase-js'

const REVENUE_ACCOUNT_NAMES = ['매출액', '수익(매출액)', '영업수익', '매출']
const STATEMENT_TYPES = new Set(['IS', 'CIS']) // 손익계산서 / 포괄손익계산서

function normalizeName(name) {
  return (name || '')
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
  const { data, error } = await supabase
    .from('dart_corp_codes')
    .select('corp_code, corp_name, stock_code')
    .ilike('corp_name', `%${inputName.trim()}%`)
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
    const res = await fetch(`https://opendart.fss.or.kr/api/company.json?crtfc_key=${apiKey}&corp_code=${corpCode}`)
    if (!res.ok) return null
    const data = await res.json()
    if (data.status !== '000') return null
    return {
      market: mapCorpCls(data.corp_cls),
      establishedDate: data.est_dt || null, // YYYYMMDD 형식
    }
  } catch {
    return null // 참고정보이므로 실패해도 전체 조회를 막지 않음
  }
}

async function fetchRevenue(apiKey, corpCode) {
  const currentYear = new Date().getFullYear()
  const yearsToTry = [currentYear - 1, currentYear - 2, currentYear - 3]

  for (const year of yearsToTry) {
    const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${apiKey}&corp_code=${corpCode}&bsns_year=${year}&reprt_code=11011`
    const res = await fetch(url)
    if (!res.ok) continue
    const data = await res.json()
    if (data.status !== '000' || !Array.isArray(data.list)) continue

    const revenueRow = data.list.find(
      (row) => STATEMENT_TYPES.has(row.sj_div) && REVENUE_ACCOUNT_NAMES.includes((row.account_nm || '').trim())
    )
    if (revenueRow && revenueRow.thstrm_amount) {
      const amount = Number(String(revenueRow.thstrm_amount).replace(/,/g, ''))
      if (!isNaN(amount)) {
        return { year, amount, accountName: revenueRow.account_nm }
      }
    }
  }
  return null
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
      fetchRevenue(apiKey, corp.corp_code),
      fetchCompanyOverview(apiKey, corp.corp_code),
    ])

    if (!revenueResult) {
      return res.status(200).json({
        found: true,
        corp_name: corp.corp_name,
        corp_code: corp.corp_code,
        is_listed: isListed,
        market: overview?.market || null,
        established_date: overview?.establishedDate || null,
        revenue_found: false,
        reason: '회사는 조회되었으나 최근 3개년 재무제표에서 매출액을 찾지 못했습니다. 매출구간을 직접 선택해주세요.',
      })
    }

    return res.status(200).json({
      found: true,
      corp_name: corp.corp_name,
      corp_code: corp.corp_code,
      is_listed: isListed,
      market: overview?.market || null,
      established_date: overview?.establishedDate || null,
      revenue_found: true,
      revenue_amount: revenueResult.amount,
      revenue_year: revenueResult.year,
      matched_account_name: revenueResult.accountName,
    })
  } catch (err) {
    return res.status(500).json({ error: 'DART 조회 중 오류: ' + err.message })
  }
}
