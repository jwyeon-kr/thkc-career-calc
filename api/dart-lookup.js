// Vercel Serverless Function
// 회사명으로 DART(전자공시시스템)를 조회하여 상장여부/매출액을 자동조회한다.
// DART_API_KEY는 서버 환경변수로만 존재하며 프론트엔드에 노출되지 않는다.
//
// 중요: DART는 "상장사 + 외부감사 대상 비상장사"만 데이터를 제공한다.
// 조회 실패는 오류가 아니라 정상적인 상황(소규모 비상장기업)이므로,
// 이 경우 절대 임의의 값을 추정하지 않고 명시적으로 실패를 반환한다.

import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'

const REVENUE_ACCOUNT_NAMES = ['매출액', '수익(매출액)', '영업수익', '매출']
const STATEMENT_TYPES = new Set(['IS', 'CIS']) // 손익계산서 / 포괄손익계산서

// corpCode 목록은 자주 바뀌지 않으므로 서버리스 함수 warm 상태 동안 메모리 캐시
let corpListCache = null
let corpListCachedAt = 0
const CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12시간

function normalizeName(name) {
  return (name || '')
    .replace(/\(주\)|주식회사|㈜/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

async function loadCorpList(apiKey) {
  const now = Date.now()
  if (corpListCache && now - corpListCachedAt < CACHE_TTL_MS) {
    return corpListCache
  }
  const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`)
  if (!res.ok) throw new Error('DART corpCode 조회 실패 (네트워크/인증키 확인 필요)')
  const buf = await res.arrayBuffer()
  const zip = await JSZip.loadAsync(buf)
  const xmlFile = zip.file('CORPCODE.xml')
  if (!xmlFile) throw new Error('corpCode.xml 파일을 zip에서 찾을 수 없습니다')
  const xmlText = await xmlFile.async('text')
  const parser = new XMLParser({ parseTagValue: false }) // 숫자로 보이는 종목코드가 자동 숫자변환되어 .trim() 호출 시 오류나던 버그 수정
  const parsed = parser.parse(xmlText)
  const list = parsed?.result?.list || []
  corpListCache = Array.isArray(list) ? list : [list]
  corpListCachedAt = now
  return corpListCache
}

function findCandidates(corpList, inputName) {
  const target = normalizeName(inputName)
  if (!target) return []

  const exact = corpList.filter((c) => normalizeName(c.corp_name) === target)
  if (exact.length > 0) return exact

  const partial = corpList.filter(
    (c) => normalizeName(c.corp_name).includes(target) || target.includes(normalizeName(c.corp_name))
  )
  return partial.slice(0, 8)
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
  if (!apiKey) {
    return res.status(500).json({ error: 'DART_API_KEY가 서버에 설정되어 있지 않습니다.' })
  }

  try {
    const corpList = await loadCorpList(apiKey)

    let corp
    if (explicitCorpCode) {
      corp = corpList.find((c) => c.corp_code === explicitCorpCode)
      if (!corp) return res.status(200).json({ found: false, reason: '선택한 회사 코드를 찾을 수 없습니다.' })
    } else {
      if (!companyName || !companyName.trim()) {
        return res.status(400).json({ error: '회사명이 필요합니다.' })
      }
      const candidates = findCandidates(corpList, companyName)

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
