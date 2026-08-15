// 가중치 테이블 전체 조회 (브라우저 직접 접속 대신 서버함수를 거침)
export async function loadWeightConfig() {
  try {
    const res = await fetch('/api/config')
    const data = await res.json()
    if (data.error) {
      const detail = [
        data.error, data.cause,
        data.cause_code ? `[코드: ${data.cause_code}]` : null,
        data.url_used ? `(요청 URL: ${data.url_used})` : null,
        data.key_length ? `(키 길이: ${data.key_length}자, 시작: ${data.key_prefix}...)` : null,
      ]
        .filter(Boolean)
        .join(' | ')
      return {
        jobIndustry: [], jobRevenue: [], employmentType: [],
        leadershipPremium: 10, listedBonus: 10,
        errors: [detail], isEmpty: true,
      }
    }
    return {
      ...data,
      errors: [],
      isEmpty: !data.jobIndustry?.length || !data.jobRevenue?.length || !data.employmentType?.length,
    }
  } catch (err) {
    return {
      jobIndustry: [], jobRevenue: [], employmentType: [],
      leadershipPremium: 10, listedBonus: 10,
      errors: [err.message], isEmpty: true,
    }
  }
}

function lookup(list, matchKeys, valueKey = 'weight_percent') {
  const found = list.find((row) =>
    Object.entries(matchKeys).every(([k, v]) => row[k] === v)
  )
  return found ? Number(found[valueKey]) : 0
}

function daysBetween(start, end) {
  const s = new Date(start)
  const e = new Date(end)
  return Math.max(0, (e - s) / (1000 * 60 * 60 * 24))
}

function overlapDays(aStart, aEnd, bStart, bEnd) {
  if (!bStart || !bEnd) return 0
  const start = new Date(Math.max(new Date(aStart), new Date(bStart)))
  const end = new Date(Math.min(new Date(aEnd), new Date(bEnd)))
  return Math.max(0, (end - start) / (1000 * 60 * 60 * 24))
}

// 개별 경력 1건 계산
export function calcEntry(entry, config) {
  const days = daysBetween(entry.start_date, entry.end_date)

  // 시니어/돌봄 도메인 "동일" 특례: 매출구간을 '당사미만'으로 완화
  const effectiveRevenueBracket =
    entry.care_domain_match === '동일' ? '당사미만' : entry.revenue_bracket

  const jiPct = lookup(config.jobIndustry, {
    job_match: entry.job_match,
    industry_match: entry.industry_match,
  })
  const jrPct = lookup(config.jobRevenue, {
    job_match: entry.job_match,
    revenue_bracket: effectiveRevenueBracket,
  })

  const jobYears = (days * (jiPct / 100) * 0.7) / 365
  const revenueYears = (days * (jrPct / 100) * 0.3) / 365
  const baseYears = jobYears + revenueYears

  // 고용형태 계수
  const empPct = lookup(config.employmentType, { employment_type: entry.employment_type }, 'weight_percent')
  const afterEmployment = baseYears * (empPct / 100)

  // 리더십 프리미엄: 리더십 기간과 겹치는 일수만큼만 가점
  const leadershipDays = overlapDays(entry.start_date, entry.end_date, entry.leadership_start_date, entry.leadership_end_date)
  const leadershipPortionBase = ((leadershipDays * (jiPct / 100) * 0.7) + (leadershipDays * (jrPct / 100) * 0.3)) / 365
  const leadershipBonus = leadershipPortionBase * (config.leadershipPremium / 100)

  // 상장 가산: 담당자 컨펌된 경우에만
  const listedBonus = entry.listed_bonus_confirmed ? afterEmployment * (config.listedBonus / 100) : 0

  const total = afterEmployment + leadershipBonus + listedBonus

  return {
    days,
    jiPct,
    jrPct,
    baseYears,
    afterEmployment,
    leadershipBonus,
    listedBonus,
    entryYears: total,
  }
}

// 90일 이상 공백 플래그 계산 (경력 시작일 기준 정렬 후 이전 종료일과 비교)
export function computeGapFlags(entries) {
  const sorted = [...entries]
    .filter((e) => e.start_date && e.end_date)
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date))
  const flagged = new Set()
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].end_date)
    const curStart = new Date(sorted[i].start_date)
    const gapDays = (curStart - prevEnd) / (1000 * 60 * 60 * 24)
    if (gapDays > 90) flagged.add(sorted[i].id)
  }
  return flagged
}

// N.50 반올림 규칙: N.50 이하 -> N년, N.50 초과 -> N+1년
export function roundToYear(totalYears) {
  const intPart = Math.floor(totalYears)
  const frac = totalYears - intPart
  return frac <= 0.5 ? intPart : intPart + 1
}

export function calcAll(entries, config) {
  const gapFlags = computeGapFlags(entries)
  const perEntry = entries.map((e) => ({
    ...e,
    gap_flag: gapFlags.has(e.id),
    calc: calcEntry(e, config),
  }))
  const totalYears = perEntry.reduce((sum, e) => sum + e.calc.entryYears, 0)
  return {
    perEntry,
    totalYears,
    roundedYears: roundToYear(totalYears),
  }
}
