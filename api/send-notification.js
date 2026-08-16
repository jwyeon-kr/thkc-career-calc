// Vercel Serverless Function
// 경력산출 결과 저장 시 알림 메일을 발송한다.
//
// Resend 도메인(thkc.co.kr) 인증 전이라, 발신 가능한 대상은 Resend 계정 소유자 본인
// (jwyeon@thkc.co.kr)뿐이다. hr@thkc.co.kr에는 직접 발송하지 않고, 대신 메일 제목에
// "[THKC 경력산출]" 태그를 붙여 네이버웍스 메일 자동분류(필터)로 hr@thkc.co.kr에
// 전달되도록 한다 (리더십진단시스템과 동일한 우회 방식).
// 발신 주소는 Resend 테스트 발신주소(onboarding@resend.dev)를 사용한다 — 도메인 인증 후
// thkc.co.kr 주소로 교체 가능.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  if (!process.env.RESEND_API_KEY) {
    // 알림 발송은 부가기능이라, 키가 없어도 저장 자체는 실패시키지 않고 여기서만 조용히 실패 처리
    return res.status(200).json({ sent: false, reason: 'RESEND_API_KEY가 설정되어 있지 않습니다.' })
  }

  const { applicantName, targetJob, roundedYears, totalYears, matchedCategory, salaryBandResult } = req.body || {}

  const salaryLine = salaryBandResult && !salaryBandResult.noData
    ? `예상 직급: ${salaryBandResult.grade}${salaryBandResult.step}호봉 / 예상 연봉: ${Number(salaryBandResult.minSalary).toLocaleString('ko-KR')}~${Number(salaryBandResult.maxSalary).toLocaleString('ko-KR')}천원`
    : '예상 직급/연봉: 정보 없음'

  const subject = `[THKC 경력산출] ${applicantName || '(이름미입력)'} - ${roundedYears}년차 산출완료`
  const bodyText = `경력산출 결과가 저장되었습니다.

지원자명: ${applicantName || '(이름미입력)'}
지원 직무: ${targetJob || '(미입력)'}
연봉밴드 직무군: ${matchedCategory || '(매칭안됨)'}
인정경력: ${roundedYears}년차 (${Number(totalYears).toFixed(2)}년)
${salaryLine}

경력산출 시스템: https://thkc-career-calc.vercel.app (이력 관리 탭에서 상세 확인 가능)`

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'jwyeon@thkc.co.kr',
        subject,
        text: bodyText,
      }),
    })
    if (!response.ok) {
      const errText = await response.text()
      return res.status(200).json({ sent: false, reason: `Resend 오류: ${errText}` })
    }
    return res.status(200).json({ sent: true })
  } catch (err) {
    return res.status(200).json({ sent: false, reason: err.message })
  }
}
