// Vercel Serverless Function
// 이력서 파일(PDF/이미지, base64)을 받아 Anthropic API로 경력 정보를 구조화 추출한다.
// ANTHROPIC_API_KEY는 서버 환경변수로만 존재하며 프론트엔드에 노출되지 않는다.

// Vercel Serverless Function
// Supabase Storage에 업로드된 이력서 파일(storagePath)을 서버에서 직접 내려받아
// Anthropic API로 경력 정보를 구조화 추출한다.
// (예전에는 브라우저가 base64로 인코딩해 직접 보냈으나, Vercel 서버 함수의 요청 본문 크기
//  제한(약 4.5MB, 변경 불가)에 걸려 대용량 파일이 실패하는 문제가 있어 이 방식으로 변경함)

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }

  const { storagePath, mediaType, targetJob } = req.body
  if (!storagePath || !mediaType) {
    return res.status(400).json({ error: 'storagePath, mediaType이 필요합니다.' })
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되어 있지 않습니다.' })
  }

  let base64Data
  try {
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data: fileBlob, error: dlErr } = await supabase.storage.from('resumes').download(storagePath)
    if (dlErr) throw new Error('업로드된 파일을 가져오지 못했습니다: ' + dlErr.message)
    const arrayBuffer = await fileBlob.arrayBuffer()
    base64Data = Buffer.from(arrayBuffer).toString('base64')

    // 처리 끝난 원본 파일은 서버 임시저장 용도라 바로 정리 (실패해도 추출은 계속 진행)
    supabase.storage.from('resumes').remove([storagePath]).catch(() => {})
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }

  const isPdf = mediaType === 'application/pdf'

  const jobMatchInstruction = targetJob
    ? `지원 직무는 "${targetJob}"입니다. 각 경력의 직무(job_title)를 지원 직무와 비교하여 "job_match_suggestion" 필드에 다음 기준으로 분류해 함께 반환하세요:
- "동일": 지원 직무와 실질적으로 같은 직무 분야
- "유사": 같은 큰 직군(예: 인사/재무/영업 등)이지만 세부 분야가 다름
- "기타": 관련성이 낮은 다른 직무
이 분류는 참고용 제안이며 담당자가 최종 확인합니다.`
    : ''

  const systemPrompt = `당신은 이력서에서 경력 정보를 추출하는 도구입니다.
반드시 아래 JSON 형식으로만 응답하세요. 다른 설명, 마크다운, 코드블록 없이 순수 JSON만 출력합니다.

{
  "applicant_name": "지원자 이름 (확인 불가시 빈 문자열)",
  "career_entries": [
    {
      "company_name": "회사명",
      "start_date": "YYYY-MM-DD (일자 불명확 시 YYYY-MM-01)",
      "end_date": "YYYY-MM-DD (재직중이면 오늘 날짜)",
      "job_title": "직무/직책",
      "employment_type_guess": "정규직/계약직/파견/인턴 중 이력서에서 유추 가능하면 표기, 불명확하면 '정규직'"${targetJob ? ',\n      "job_match_suggestion": "동일/유사/기타 중 하나"' : ''}
    }
  ]
}

${jobMatchInstruction}
날짜를 알 수 없으면 최대한 합리적으로 추정하되, 확실하지 않은 항목은 비워두지 말고 빈 문자열 대신 추정값을 넣으세요.`

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } }

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
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [contentBlock, { type: 'text', text: '이 이력서에서 경력 정보를 JSON으로 추출해줘.' }],
          },
        ],
      }),
    })

    if (!response.ok) {
      const errText = await response.text()
      return res.status(500).json({ error: `Anthropic API 오류: ${errText}` })
    }

    const data = await response.json()
    const textBlock = data.content?.find((b) => b.type === 'text')
    if (!textBlock) {
      return res.status(500).json({ error: '추출 결과가 비어있습니다.' })
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim()
    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      return res.status(500).json({ error: '추출 결과 파싱 실패', raw: cleaned })
    }

    return res.status(200).json(parsed)
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
}
