// Vercel Serverless Function
// "지원 직무" 자유 텍스트를 연봉밴드의 4개 직무군(플랫폼본부/B2B사업부/IT센터/경영지원본부 등) 중
// 하나로 AI가 자동 분류한다. 직무군 이름은 하드코딩하지 않고 salary_bands 테이블에 실제 저장된
// distinct 값을 매번 조회해서 프롬프트에 반영 — 엑셀 업데이트로 직무군 구성이 바뀌어도
// 코드 수정 없이 자동으로 따라간다.

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  const { targetJob } = req.body || {}
  if (!targetJob || !targetJob.trim()) {
    return res.status(400).json({ error: 'targetJob이 필요합니다.' })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되어 있지 않습니다.' })
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되어 있지 않습니다.' })
  }
  const supabase = createClient(supabaseUrl, supabaseKey)

  try {
    const { data, error } = await supabase.from('salary_bands').select('category')
    if (error) return res.status(500).json({ error: '직무군 목록 조회 실패: ' + error.message })
    const categories = [...new Set((data || []).map((r) => r.category))]
    if (categories.length === 0) {
      return res.status(200).json({ category: null, reason: '연봉밴드 데이터가 아직 업로드되지 않았습니다.' })
    }

    const systemPrompt = `당신은 지원 직무명을 회사의 직무군 카테고리로 분류하는 도구입니다.
아래 JSON 형식으로만 응답하세요. 다른 설명 없이 순수 JSON만 출력합니다.
{"category": "다음 중 정확히 하나: ${categories.join(' / ')}"}
분류가 애매하면 가장 근접한 직무군을 선택하세요.`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 100,
        system: systemPrompt,
        messages: [{ role: 'user', content: `지원 직무: ${targetJob}` }],
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      return res.status(500).json({ error: `Anthropic API 오류: ${errText}` })
    }
    const data2 = await response.json()
    const textBlock = data2.content?.find((b) => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: '응답이 비어있습니다.' })
    const cleaned = textBlock.text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (!categories.includes(parsed.category)) {
      return res.status(500).json({ error: '예상치 못한 응답 형식입니다.', raw: parsed })
    }
    return res.status(200).json({ category: parsed.category })
  } catch (err) {
    return res.status(500).json({ error: '직무군 분류 중 오류: ' + err.message })
  }
}
