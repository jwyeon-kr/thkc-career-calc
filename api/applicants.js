// Vercel Serverless Function
// 지원자/경력사항/산출결과 저장 및 최근 이력 조회를 서버에서 처리한다.
// 브라우저가 Supabase에 직접 접속하지 않도록 하여 연결 문제를 회피하고,
// RLS 미적용 테이블에 대한 브라우저 직접 접근을 없애 보안도 함께 개선한다.
//
// [2026-08-15 수정] 두 가지 반영:
// 1) 버그 수정: career_entries 저장 시 폐기된 필드(care_domain_match)를 여전히 참조하고 있어
//    항상 undefined가 저장되고, 신규 필드(is_conglomerate_affiliate)는 저장에서 누락되어 있던 문제 수정.
// 2) 이력 관리 탭에서 경력사항 세부내역을 볼 수 있도록, GET 응답에 calc_snapshot(계산 스냅샷 전체) 포함.
//
// [2026-08-23 수정] 감사추적/재계산/내보내기 보강:
// 1) POST에 applicantId를 넘기면 "재계산"으로 처리 — 기존 지원자를 새로 만들지 않고 career_entries만
//    최신 상태로 교체하고, calculation_results는 새 row로 추가한다(과거 산출 이력은 지우지 않고 그대로 보존 —
//    "이 사람이 언제 어떤 근거로 몇 년으로 산출됐었는지" 이력을 감사 대응용으로 남겨두기 위함).
// 2) 신규 저장 시 career_entries 저장이 실패하면 방금 만든 applicant 레코드를 롤백 삭제한다
//    (기존엔 여기서 실패하면 경력/산출결과 없는 고아 applicant가 남는 문제가 있었음).
// 3) DELETE는 deletedBy/reason을 받아 삭제 전 전체 스냅샷을 deleted_applicants_log에 남긴다.
// 4) GET에 limit(기본 15, 최대 500), format=xlsx(전체 이력 엑셀 내보내기) 지원 추가.

import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const HISTORY_SELECT =
  'id, applicant_id, total_recognized_years, rounded_years, calculated_at, calculated_by, calc_snapshot, applicants(name, target_job)'

export default async function handler(req, res) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL 또는 SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다.' })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  if (req.method === 'GET') {
    const rawLimit = Number(req.query.limit)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 15

    try {
      const { data, error } = await supabase
        .from('calculation_results')
        .select(HISTORY_SELECT)
        .order('calculated_at', { ascending: false })
        .limit(limit)
      if (error) return res.status(500).json({ error: error.message })

      if (req.query.format === 'xlsx') {
        const aoa = [['지원자명', '지원직무', '연봉밴드 직무군', '인정연수', '반올림연차', '예상직급', '예상연봉(MIN~MAX,천원)', '산출일시', '산출자']]
        for (const row of data || []) {
          const snap = row.calc_snapshot || {}
          const band = snap.salaryBandResult
          aoa.push([
            row.applicants?.name || '',
            row.applicants?.target_job || '',
            snap.matchedCategory || '',
            row.total_recognized_years != null ? Number(row.total_recognized_years).toFixed(2) : '',
            row.rounded_years,
            band && !band.noData ? `${band.grade}${band.step}호봉` : '',
            band && !band.noData ? `${band.minSalary}~${band.maxSalary}` : '',
            row.calculated_at,
            row.calculated_by || '',
          ])
        }
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet(aoa)
        XLSX.utils.book_append_sheet(wb, ws, '경력산출이력')
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', 'attachment; filename="career_calc_history.xlsx"')
        return res.status(200).send(buf)
      }

      return res.status(200).json({ history: data || [] })
    } catch (err) {
      return res.status(500).json({ error: '이력 조회 중 오류: ' + err.message, cause: err.cause ? String(err.cause) : null })
    }
  }

  if (req.method === 'DELETE') {
    const { calculationResultIds, deletedBy, reason } = req.body || {}
    if (!Array.isArray(calculationResultIds) || calculationResultIds.length === 0) {
      return res.status(400).json({ error: '삭제할 항목이 지정되지 않았습니다.' })
    }
    try {
      // 지정된 산출결과에 연결된 지원자(applicant)를 찾아 지원자 단위로 삭제한다.
      // applicants 삭제 시 career_entries/calculation_results가 CASCADE로 함께 삭제되도록 스키마가 설계되어 있음.
      const { data: results, error: findErr } = await supabase
        .from('calculation_results')
        .select('applicant_id')
        .in('id', calculationResultIds)
      if (findErr) return res.status(500).json({ error: '삭제 대상 조회 실패: ' + findErr.message })

      const applicantIds = [...new Set((results || []).map((r) => r.applicant_id))]
      if (applicantIds.length === 0) {
        return res.status(200).json({ success: true, deleted: 0 })
      }

      // 삭제 전 감사추적용 스냅샷 기록 (지원자 + 경력사항 + 전체 산출이력)
      const [{ data: applicantsData }, { data: entriesData }, { data: resultsData }] = await Promise.all([
        supabase.from('applicants').select('*').in('id', applicantIds),
        supabase.from('career_entries').select('*').in('applicant_id', applicantIds),
        supabase.from('calculation_results').select('*').in('applicant_id', applicantIds),
      ])

      const logRows = (applicantsData || []).map((a) => ({
        applicant_id: a.id,
        applicant_name: a.name,
        deleted_by: deletedBy || null,
        delete_reason: reason || null,
        snapshot: {
          applicant: a,
          career_entries: (entriesData || []).filter((e) => e.applicant_id === a.id),
          calculation_results: (resultsData || []).filter((r) => r.applicant_id === a.id),
        },
      }))
      if (logRows.length > 0) {
        const { error: logErr } = await supabase.from('deleted_applicants_log').insert(logRows)
        if (logErr) return res.status(500).json({ error: '삭제 로그 기록 실패(삭제는 진행하지 않음): ' + logErr.message })
      }

      const { error: delErr } = await supabase.from('applicants').delete().in('id', applicantIds)
      if (delErr) return res.status(500).json({ error: '삭제 실패: ' + delErr.message })

      return res.status(200).json({ success: true, deleted: applicantIds.length })
    } catch (err) {
      return res.status(500).json({ error: '삭제 중 오류: ' + err.message })
    }
  }

  if (req.method === 'POST') {
    const { applicantId, applicantName, targetJob, entries, result, calculatedBy } = req.body
    if (!applicantName || !entries || !result) {
      return res.status(400).json({ error: 'applicantName, entries, result가 필요합니다.' })
    }
    const entryRows = (applicant) =>
      entries.map((e) => ({
        applicant_id: applicant.id,
        company_name: e.company_name,
        start_date: e.start_date,
        end_date: e.end_date,
        employment_type: e.employment_type,
        job_match: e.job_match,
        industry_match: e.industry_match,
        revenue_bracket: e.revenue_bracket,
        revenue_source: e.revenue_source,
        is_conglomerate_affiliate: e.is_conglomerate_affiliate,
        care_domain_confirmed: e.care_domain_confirmed,
        leadership_start_date: e.leadership_start_date || null,
        leadership_end_date: e.leadership_end_date || null,
        listed_bonus_eligible_job: e.listed_bonus_eligible_job,
        listed_bonus_confirmed: e.listed_bonus_confirmed,
        gap_flag: e.gap_flag,
      }))

    try {
      if (applicantId) {
        // 재계산: 기존 지원자를 재사용 — career_entries는 최신 상태로 교체, calculation_results는 새로 추가(이력 보존)
        const { data: applicant, error: findErr } = await supabase
          .from('applicants')
          .select('id')
          .eq('id', applicantId)
          .single()
        if (findErr || !applicant) return res.status(404).json({ error: '재계산 대상 지원자를 찾을 수 없습니다.' })

        const { error: updErr } = await supabase
          .from('applicants')
          .update({ name: applicantName, target_job: targetJob, updated_at: new Date().toISOString() })
          .eq('id', applicantId)
        if (updErr) return res.status(500).json({ error: '지원자 정보 갱신 실패: ' + updErr.message })

        const { error: delEntriesErr } = await supabase.from('career_entries').delete().eq('applicant_id', applicantId)
        if (delEntriesErr) return res.status(500).json({ error: '기존 경력사항 교체 실패: ' + delEntriesErr.message })

        const { error: cErr } = await supabase.from('career_entries').insert(entryRows(applicant))
        if (cErr) return res.status(500).json({ error: '경력사항 저장 실패: ' + cErr.message })

        const { error: rErr } = await supabase.from('calculation_results').insert({
          applicant_id: applicantId,
          total_recognized_years: result.totalYears,
          rounded_years: result.roundedYears,
          calc_snapshot: result,
          calculated_by: calculatedBy || null,
        })
        if (rErr) return res.status(500).json({ error: '산출결과 저장 실패: ' + rErr.message })

        return res.status(200).json({ success: true, applicantId, recalculated: true })
      }

      const { data: applicant, error: aErr } = await supabase
        .from('applicants')
        .insert({ name: applicantName, target_job: targetJob, status: 'confirmed', created_by: calculatedBy || null })
        .select()
        .single()
      if (aErr) return res.status(500).json({ error: '지원자 저장 실패: ' + aErr.message })

      const { error: cErr } = await supabase.from('career_entries').insert(entryRows(applicant))
      if (cErr) {
        // 경력사항 저장이 실패하면 방금 만든 지원자만 덩그러니 남는 고아 레코드가 되므로 롤백
        await supabase.from('applicants').delete().eq('id', applicant.id)
        return res.status(500).json({ error: '경력사항 저장 실패: ' + cErr.message })
      }

      const { error: rErr } = await supabase.from('calculation_results').insert({
        applicant_id: applicant.id,
        total_recognized_years: result.totalYears,
        rounded_years: result.roundedYears,
        calc_snapshot: result,
        calculated_by: calculatedBy || null,
      })
      if (rErr) {
        await supabase.from('applicants').delete().eq('id', applicant.id)
        return res.status(500).json({ error: '산출결과 저장 실패: ' + rErr.message })
      }

      return res.status(200).json({ success: true, applicantId: applicant.id })
    } catch (err) {
      return res.status(500).json({ error: '저장 중 오류: ' + err.message })
    }
  }

  return res.status(405).json({ error: 'GET, POST, DELETE만 허용됩니다.' })
}
