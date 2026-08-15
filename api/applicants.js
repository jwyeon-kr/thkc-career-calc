// Vercel Serverless Function
// 지원자/경력사항/산출결과 저장 및 최근 이력 조회를 서버에서 처리한다.
// 브라우저가 Supabase에 직접 접속하지 않도록 하여 연결 문제를 회피하고,
// RLS 미적용 테이블에 대한 브라우저 직접 접근을 없애 보안도 함께 개선한다.
//
// [2026-08-15 수정] 두 가지 반영:
// 1) 버그 수정: career_entries 저장 시 폐기된 필드(care_domain_match)를 여전히 참조하고 있어
//    항상 undefined가 저장되고, 신규 필드(is_conglomerate_affiliate)는 저장에서 누락되어 있던 문제 수정.
// 2) 이력 관리 탭에서 경력사항 세부내역을 볼 수 있도록, GET 응답에 calc_snapshot(계산 스냅샷 전체) 포함.

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL 또는 SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다.' })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('calculation_results')
        .select('id, applicant_id, total_recognized_years, rounded_years, calculated_at, calc_snapshot, applicants(name, target_job)')
        .order('calculated_at', { ascending: false })
        .limit(15)
      if (error) return res.status(500).json({ error: error.message })
      return res.status(200).json({ history: data || [] })
    } catch (err) {
      return res.status(500).json({ error: '이력 조회 중 오류: ' + err.message, cause: err.cause ? String(err.cause) : null })
    }
  }

  if (req.method === 'DELETE') {
    const { calculationResultIds } = req.body || {}
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

      const { error: delErr } = await supabase.from('applicants').delete().in('id', applicantIds)
      if (delErr) return res.status(500).json({ error: '삭제 실패: ' + delErr.message })

      return res.status(200).json({ success: true, deleted: applicantIds.length })
    } catch (err) {
      return res.status(500).json({ error: '삭제 중 오류: ' + err.message })
    }
  }

  if (req.method === 'POST') {
    const { applicantName, targetJob, entries, result } = req.body
    if (!applicantName || !entries || !result) {
      return res.status(400).json({ error: 'applicantName, entries, result가 필요합니다.' })
    }
    try {
      const { data: applicant, error: aErr } = await supabase
        .from('applicants')
        .insert({ name: applicantName, target_job: targetJob, status: 'confirmed' })
        .select()
        .single()
      if (aErr) return res.status(500).json({ error: '지원자 저장 실패: ' + aErr.message })

      const entryRows = entries.map((e) => ({
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
      const { error: cErr } = await supabase.from('career_entries').insert(entryRows)
      if (cErr) return res.status(500).json({ error: '경력사항 저장 실패: ' + cErr.message })

      const { error: rErr } = await supabase.from('calculation_results').insert({
        applicant_id: applicant.id,
        total_recognized_years: result.totalYears,
        rounded_years: result.roundedYears,
        calc_snapshot: result,
      })
      if (rErr) return res.status(500).json({ error: '산출결과 저장 실패: ' + rErr.message })

      return res.status(200).json({ success: true, applicantId: applicant.id })
    } catch (err) {
      return res.status(500).json({ error: '저장 중 오류: ' + err.message })
    }
  }

  return res.status(405).json({ error: 'GET 또는 POST만 허용됩니다.' })
}
