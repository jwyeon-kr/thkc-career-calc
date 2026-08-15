// Vercel Serverless Function
// 가중치 설정값을 서버에서 Supabase로 조회하여 반환한다.
// 브라우저가 Supabase에 직접 접속하지 않고, 반드시 이 서버 함수를 거치도록 하여
// 클라이언트 환경(네트워크/확장프로그램 등)에 따른 직접 연결 실패 문제를 회피한다.

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET만 허용됩니다.' })
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
    const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'SUPABASE_URL 또는 SUPABASE_ANON_KEY 환경변수가 설정되지 않았습니다.' })
    }

    const supabase = createClient(supabaseUrl, supabaseKey)

    const [ji, jr, et, lp, lb] = await Promise.all([
      supabase.from('job_industry_matrix').select('*'),
      supabase.from('job_revenue_matrix').select('*'),
      supabase.from('employment_type_weights').select('*'),
      supabase.from('leadership_premium_config').select('*').order('updated_at', { ascending: false }).limit(1),
      supabase.from('listed_bonus_config').select('*').order('updated_at', { ascending: false }).limit(1),
    ])

    const errors = [ji, jr, et, lp, lb].map((r) => r.error?.message).filter(Boolean)
    if (errors.length > 0) {
      return res.status(500).json({ error: errors.join(' / ') })
    }

    return res.status(200).json({
      jobIndustry: ji.data || [],
      jobRevenue: jr.data || [],
      employmentType: et.data || [],
      leadershipPremium: lp.data?.[0]?.weight_percent ?? 10,
      listedBonus: lb.data?.[0]?.weight_percent ?? 10,
    })
  } catch (err) {
    return res.status(500).json({
      error: 'Supabase 조회 중 오류: ' + err.message,
      cause: err.cause ? String(err.cause) : null,
      url_used: (process.env.SUPABASE_URL || '(없음)').trim(),
    })
  }
}
