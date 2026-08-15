// Vercel Serverless Function
// 정형 입력(수동 입력) 화면에서, 입력한 직무명과 지원직무를 비교하여
// 직무매칭(동일/유사/기타)을 AI가 제안한다. 최종 판단은 담당자가 확인 후 수정.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  const { targetJob, jobTitle } = req.body || {}
  if (!targetJob || !jobTitle) {
    return res.status(400).json({ error: 'targetJob, jobTitle이 모두 필요합니다.' })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되어 있지 않습니다.' })
  }

  const systemPrompt = `지원 직무와 경력상 직무를 비교하여 아래 JSON 형식으로만 응답하세요. 다른 설명 없이 순수 JSON만 출력합니다.
{"job_match_suggestion": "동일" | "유사" | "기타"}

기준:
- "동일": 지원 직무와 실질적으로 같은 직무 분야
- "유사": 같은 큰 직군(예: 인사/재무/영업 등)이지만 세부 분야가 다름
- "기타": 관련성이 낮은 다른 직무`

  try {
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
        messages: [{ role: 'user', content: `지원 직무: ${targetJob}\n경력상 직무: ${jobTitle}` }],
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      return res.status(500).json({ error: `Anthropic API 오류: ${errText}` })
    }
    const data = await response.json()
    const textBlock = data.content?.find((b) => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: '응답이 비어있습니다.' })

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (!['동일', '유사', '기타'].includes(parsed.job_match_suggestion)) {
      return res.status(500).json({ error: '예상치 못한 응답 형식입니다.' })
    }
    return res.status(200).json({ job_match_suggestion: parsed.job_match_suggestion })
  } catch (err) {
    return res.status(500).json({ error: '직무매칭 제안 중 오류: ' + err.message })
  }
}
