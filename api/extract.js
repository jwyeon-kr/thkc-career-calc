// Vercel Serverless Function
// Supabase Storage에 업로드된 이력서 파일(storagePath)을 서버에서 직접 내려받아
// Anthropic API로 경력 정보를 구조화 추출한다.
// (예전에는 브라우저가 base64로 인코딩해 직접 보냈으나, Vercel 서버 함수의 요청 본문 크기
//  제한(약 4.5MB, 변경 불가)에 걸려 대용량 파일이 실패하는 문제가 있어 이 방식으로 변경함)
//
// [2026-08-15 수정] company_name / department / job_title 분리 실패 문제 대응:
// 기존에는 "job_title" 하나에 부서+직무가 뭉쳐서 들어가는 문제가 있었음(예: "재무회계팀.회계").
// company_name, department, job_title 3개 필드로 명확히 분리하고,
// 분리가 애매한 경우 raw_position_text(원문)를 항상 함께 반환해 저장 단계에서 fallback으로 쓸 수 있게 함.
//
// [2026-08-16 수정] 이력서에 기재된 자격증(요양보호사, 사회복지사 등)을 certifications 배열로 함께 추출.
// DB에 저장하지 않고 화면 참고정보로만 사용 — 돌봄도메인 특례 체크 여부 판단 시 담당자가 참고할 힌트.

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
    ? `지원 직무는 "${targetJob}"입니다. 각 경력의 "job_title"(부서가 아닌 실제 수행 직무만)을 지원 직무와 비교하여 "job_match_suggestion" 필드에 다음 기준으로 분류해 함께 반환하세요:
- "동일": 지원 직무와 실질적으로 같은 직무 분야
- "유사": 같은 큰 직군(예: 인사/재무/영업 등)이지만 세부 분야가 다름
- "기타": 관련성이 낮은 다른 직무
이 분류는 참고용 제안이며 담당자가 최종 확인합니다.`
    : ''

  const systemPrompt = `당신은 이력서에서 경력 정보를 추출하는 도구입니다.
반드시 아래 JSON 형식으로만 응답하세요. 다른 설명, 마크다운, 코드블록 없이 순수 JSON만 출력합니다.

{
  "applicant_name": "지원자 이름 (확인 불가시 빈 문자열)",
  "certifications": ["이력서에 기재된 자격증/면허명 목록 (예: '요양보호사 2급', '사회복지사 1급'). 없으면 빈 배열"],
  "career_entries": [
    {
      "company_name": "회사명만 (부서/직무 절대 포함하지 말 것, 예: '프레스티지바이오파마아이디씨㈜')",
      "department": "부서명만 (확인 불가시 빈 문자열, 예: '재무회계팀')",
      "job_title": "실제 수행 직무만 (부서명 제외, 예: '회계'). '부서.직무' 형태로 뭉쳐서 표기된 원문이라도 여기에는 직무만 넣을 것",
      "raw_position_text": "이력서에 표기된 직책/부서/직무 원문 그대로 (분리가 애매할 때 대조용, 예: '재무회계팀.회계')",
      "start_date": "YYYY-MM-DD (일자 불명확 시 YYYY-MM-01)",
      "end_date": "YYYY-MM-DD (재직중이면 오늘 날짜)",
      "employment_type_guess": "정규직/계약직/파견/인턴 중 이력서에서 유추 가능하면 표기, 불명확하면 '정규직'"${targetJob ? ',\n      "job_match_suggestion": "동일/유사/기타 중 하나"' : ''}
    }
  ]
}

중요: company_name, department, job_title은 반드시 분리하세요. 이력서에 "OO팀.OO" 또는 "OO팀 - OO담당"처럼 부서와 직무가 한 표기로 붙어 있어도, 마침표/줄바꿈/하이픈 등을 기준으로 부서와 직무를 나누어 각각의 필드에 넣으세요. 분리가 정말 불가능한 경우에만 job_title에 원문 전체를 넣고, department는 빈 문자열로 두세요.

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
            content: [contentBlock, { type: 'text', text: '이 이력서에서 경력 정보를 JSON으로 추출해줘. company_name/department/job_title은 반드시 분리해줘.' }],
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
