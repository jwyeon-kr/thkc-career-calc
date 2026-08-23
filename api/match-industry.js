// Vercel Serverless Function
// 경력 회사의 업종이 THKC의 사업영역과 동종/유사/기타 중 무엇인지 AI가 제안한다.
// 판단기준은 화면(판단기준 보기 패널)에 이미 담당자 대상으로 공개된 문구를 그대로 사용 —
// 새 기준을 만든 게 아니라 기존에 사람이 눈으로 판단하던 기준을 그대로 AI에게 준 것.
// 최종 판단은 담당자가 확인 후 수정.

import { callAnthropic } from '../shared/anthropic.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  const { companyName, jobTitle } = req.body || {}
  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: 'companyName이 필요합니다.' })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되어 있지 않습니다.' })
  }

  const systemPrompt = `당신은 회사명(및 직무명)을 보고 그 회사의 업종이 THKC(시니어산업 복지용구 유통 플랫폼 회사)의 사업영역과 얼마나 관련있는지 분류하는 도구입니다.
아래 JSON 형식으로만 응답하세요. 다른 설명 없이 순수 JSON만 출력합니다.
{"industry_match_suggestion": "동종" | "유사" | "기타"}

기준:
- "동종": 자사 웹/앱 서비스 제공, 의료기기/용품 유통·도소매, 사회보장서비스 관련
- "유사": 웹/앱 서비스이나 자사 플랫폼 아님(예: 다른 회사 SI/개발 대행), 유통·도소매이나 취급 재화가 의료기기/복지용구가 아님, 대행업(SI/광고대행/3PL/세무회계/콜센터 등)
- "기타": 위 기준에 해당하지 않는 다른 업종(예: 제조업, 건설업, 금융업 등 관련성 낮은 분야)

회사명만으로 정확한 업종을 알기 어려우면, 회사명에 담긴 업종 힌트(제조/건설/무역/컨설팅 등 단어)와 직무명을 참고해 가장 근접한 것을 선택하세요.`

  try {
    const response = await callAnthropic({
      system: systemPrompt,
      maxTokens: 100,
      messages: [{ role: 'user', content: `회사명: ${companyName}${jobTitle ? `\n직무명: ${jobTitle}` : ''}` }],
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
    if (!['동종', '유사', '기타'].includes(parsed.industry_match_suggestion)) {
      return res.status(500).json({ error: '예상치 못한 응답 형식입니다.' })
    }
    return res.status(200).json({ industry_match_suggestion: parsed.industry_match_suggestion })
  } catch (err) {
    return res.status(500).json({ error: '업종매칭 제안 중 오류: ' + err.message })
  }
}
