// Vercel Serverless Function
// 정형 입력(수동 입력) 화면에서, 입력한 직무명과 지원직무를 비교하여
// 직무매칭(동일/유사/기타)을 AI가 제안한다. 최종 판단은 담당자가 확인 후 수정.
//
// [2026-08-23 수정] 업종매칭(동종/유사/기타) 제안도 이 파일에 합침(원래 api/match-industry.js였음) —
// Vercel Hobby 플랜은 배포당 서버리스 함수 12개까지만 허용하는데, 별도 파일로 분리했다가
// 13번째 함수가 되면서 배포가 통째로 실패("exceeded_serverless_functions_per_deployment")했음.
// 둘 다 "AI 단일 분류" 패턴이 거의 동일해서 kind로 분기하는 게 자연스러운 통합이기도 함.

import { callAnthropic } from '../shared/anthropic.js'

async function suggestJobMatch(targetJob, jobTitle) {
  if (!targetJob || !jobTitle) {
    return { status: 400, body: { error: 'targetJob, jobTitle이 모두 필요합니다.' } }
  }
  const systemPrompt = `지원 직무와 경력상 직무를 비교하여 아래 JSON 형식으로만 응답하세요. 다른 설명 없이 순수 JSON만 출력합니다.
{"job_match_suggestion": "동일" | "유사" | "기타"}

기준:
- "동일": 지원 직무와 실질적으로 같은 직무 분야
- "유사": 같은 큰 직군(예: 인사/재무/영업 등)이지만 세부 분야가 다름
- "기타": 관련성이 낮은 다른 직무`

  try {
    const response = await callAnthropic({
      system: systemPrompt,
      maxTokens: 100,
      messages: [{ role: 'user', content: `지원 직무: ${targetJob}\n경력상 직무: ${jobTitle}` }],
    })
    if (!response.ok) {
      const errText = await response.text()
      return { status: 500, body: { error: `Anthropic API 오류: ${errText}` } }
    }
    const data = await response.json()
    const textBlock = data.content?.find((b) => b.type === 'text')
    if (!textBlock) return { status: 500, body: { error: '응답이 비어있습니다.' } }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (!['동일', '유사', '기타'].includes(parsed.job_match_suggestion)) {
      return { status: 500, body: { error: '예상치 못한 응답 형식입니다.' } }
    }
    return { status: 200, body: { job_match_suggestion: parsed.job_match_suggestion } }
  } catch (err) {
    return { status: 500, body: { error: '직무매칭 제안 중 오류: ' + err.message } }
  }
}

async function suggestIndustryMatch(companyName, jobTitle) {
  if (!companyName || !companyName.trim()) {
    return { status: 400, body: { error: 'companyName이 필요합니다.' } }
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
      return { status: 500, body: { error: `Anthropic API 오류: ${errText}` } }
    }
    const data = await response.json()
    const textBlock = data.content?.find((b) => b.type === 'text')
    if (!textBlock) return { status: 500, body: { error: '응답이 비어있습니다.' } }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (!['동종', '유사', '기타'].includes(parsed.industry_match_suggestion)) {
      return { status: 500, body: { error: '예상치 못한 응답 형식입니다.' } }
    }
    return { status: 200, body: { industry_match_suggestion: parsed.industry_match_suggestion } }
  } catch (err) {
    return { status: 500, body: { error: '업종매칭 제안 중 오류: ' + err.message } }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되어 있지 않습니다.' })
  }

  const { kind, targetJob, jobTitle, companyName } = req.body || {}
  const result =
    kind === 'industry'
      ? await suggestIndustryMatch(companyName, jobTitle)
      : await suggestJobMatch(targetJob, jobTitle)

  return res.status(result.status).json(result.body)
}
