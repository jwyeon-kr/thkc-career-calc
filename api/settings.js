// Vercel Serverless Function
// 계산 로직에 쓰이는 가중치 수치(고용형태 계수, 직무x업종 매트릭스 등)를
// 화면에서 직접 조회/수정할 수 있도록 제공한다.
// 허용된 테이블/컬럼만 수정 가능하도록 화이트리스트로 제한한다 (임의 테이블 접근 방지).

import { createClient } from '@supabase/supabase-js'

const ALLOWED_TABLES = {
  job_industry_matrix: { keys: ['job_match', 'industry_match'] },
  job_revenue_matrix: { keys: ['job_match', 'revenue_bracket'] },
  employment_type_weights: { keys: ['employment_type'] },
  leadership_premium_config: { keys: ['id'] },
  listed_bonus_config: { keys: ['id'] },
}

export default async function handler(req, res) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되어 있지 않습니다.' })
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  if (req.method === 'GET') {
    try {
      const [ji, jr, et, lp, lb] = await Promise.all([
        supabase.from('job_industry_matrix').select('*').order('job_match').order('industry_match'),
        supabase.from('job_revenue_matrix').select('*').order('job_match').order('revenue_bracket'),
        supabase.from('employment_type_weights').select('*').order('employment_type'),
        supabase.from('leadership_premium_config').select('*').order('updated_at', { ascending: false }).limit(1),
        supabase.from('listed_bonus_config').select('*').order('updated_at', { ascending: false }).limit(1),
      ])
      const errors = [ji, jr, et, lp, lb].map((r) => r.error?.message).filter(Boolean)
      if (errors.length > 0) return res.status(500).json({ error: errors.join(' / ') })

      return res.status(200).json({
        jobIndustry: ji.data || [],
        jobRevenue: jr.data || [],
        employmentType: et.data || [],
        leadershipPremium: lp.data?.[0] || null,
        listedBonus: lb.data?.[0] || null,
      })
    } catch (err) {
      return res.status(500).json({ error: '설정값 조회 중 오류: ' + err.message })
    }
  }

  if (req.method === 'PUT') {
    const { table, match, weight_percent } = req.body || {}
    if (!table || !ALLOWED_TABLES[table]) {
      return res.status(400).json({ error: '허용되지 않은 테이블입니다.' })
    }
    if (typeof weight_percent !== 'number' || isNaN(weight_percent)) {
      return res.status(400).json({ error: 'weight_percent는 숫자여야 합니다.' })
    }
    const allowedKeys = ALLOWED_TABLES[table].keys
    const matchKeys = Object.keys(match || {})
    const invalidKey = matchKeys.find((k) => !allowedKeys.includes(k))
    if (matchKeys.length === 0 || invalidKey) {
      return res.status(400).json({ error: '수정 대상을 식별할 수 없습니다.' })
    }

    try {
      let query = supabase.from(table).update({ weight_percent, updated_at: new Date().toISOString() })
      for (const k of matchKeys) query = query.eq(k, match[k])
      const { error } = await query
      if (error) return res.status(500).json({ error: '수정 실패: ' + error.message })
      return res.status(200).json({ success: true })
    } catch (err) {
      return res.status(500).json({ error: '수정 중 오류: ' + err.message })
    }
  }

  return res.status(405).json({ error: 'GET 또는 PUT만 허용됩니다.' })
}
