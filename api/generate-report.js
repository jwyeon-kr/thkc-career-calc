// Vercel Serverless Function
// 경력산출 계산 결과(perEntry breakdown)를 받아, "왜 이 인정경력/등급이 나왔는지"를
// 사람이 읽을 수 있는 문장으로 설명하는 리포트를 AI가 생성한다.
// 계산 자체는 이미 서버가 아닌 클라이언트(calculator.js)에서 끝난 상태이며,
// 이 API는 그 결과를 요약 설명하는 용도로만 쓰인다 (계산 로직 자체에 관여하지 않음).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  const { applicantName, targetJob, roundedYears, totalYears, perEntry, matchedCategory, salaryBandResult } = req.body || {}
  if (!perEntry || !Array.isArray(perEntry)) {
    return res.status(400).json({ error: 'perEntry가 필요합니다.' })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되어 있지 않습니다.' })
  }

  // 프롬프트에 넘길 요약 데이터 구성 (원본 계산값 그대로 전달, AI는 이를 문장으로 풀어쓰기만 함)
  const entrySummaries = perEntry.map((e) => ({
    회사명: e.company_name,
    기간: `${e.start_date} ~ ${e.end_date}`,
    고용형태: e.employment_type,
    직무매칭: e.job_match,
    업종매칭: e.industry_match,
    기업규모: e.is_conglomerate_affiliate ? '대기업(계열사 확인)' : (e.revenue_bracket || '미입력'),
    돌봄도메인특례: e.care_domain_confirmed ? '적용' : '미적용',
    상장가산: e.listed_bonus_confirmed ? '적용' : '미적용',
    리더십기간: e.leadership_start_date && e.leadership_end_date ? `${e.leadership_start_date} ~ ${e.leadership_end_date}` : '없음',
    경력단절: e.gap_flag ? '90일 이상 공백 있음' : '없음',
    인정연수: e.calc?.entryYears?.toFixed(2),
    직무업종매칭율: e.calc?.jiPct,
    직무기업규모매칭율: e.calc?.jrPct,
  }))

  const systemPrompt = `당신은 인사기획팀의 경력산출 결과를 설명하는 리포트를 작성하는 도구입니다.
아래 데이터를 바탕으로, 담당자나 지원자가 "왜 이 결과가 나왔는지" 이해할 수 있는 간결한 설명 리포트를 작성하세요.

작성 원칙:
- 순수 텍스트로만 작성 (마크다운 기호, 헤더 기호 사용하지 말 것)
- 각 경력 건별로 인정연수가 어떻게 산정됐는지 핵심 요인(직무매칭/업종매칭/기업규모/가산항목)만 간단히 언급
- 계산식 자체를 재계산하거나 검증하지 말 것 (이미 확정된 숫자를 설명만 할 것)
- 숫자를 임의로 바꾸거나 새로 만들지 말 것, 제공된 값만 사용
- 전체 5~10문장 이내로 간결하게
- 존댓말 사용`

  const userContent = `지원자: ${applicantName || '(이름 미입력)'}
지원 직무: ${targetJob || '(미입력)'}
최종 인정경력: ${roundedYears}년차 (${Number(totalYears).toFixed(2)}년)
${matchedCategory ? `연봉밴드 매칭 직무군: ${matchedCategory}` : ''}
${salaryBandResult && !salaryBandResult.noData ? `예상 직급: ${salaryBandResult.grade}${salaryBandResult.step}호봉, 예상연봉: ${salaryBandResult.minSalary}~${salaryBandResult.maxSalary}천원` : ''}

경력 상세:
${JSON.stringify(entrySummaries, null, 2)}

위 데이터를 바탕으로 설명 리포트를 작성해주세요.`

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
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      return res.status(500).json({ error: `Anthropic API 오류: ${errText}` })
    }
    const data = await response.json()
    const textBlock = data.content?.find((b) => b.type === 'text')
    if (!textBlock) return res.status(500).json({ error: '리포트 생성 결과가 비어있습니다.' })
    return res.status(200).json({ report: textBlock.text.trim() })
  } catch (err) {
    return res.status(500).json({ error: '리포트 생성 중 오류: ' + err.message })
  }
}
