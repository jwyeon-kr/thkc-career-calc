// 상장가산 적용 대상 직무 키워드 (재무회계/IR/감사대응 등)
// 이력서에서 추출된 직무명(job_title) 텍스트로 "제안" 값을 만드는 용도.
// 최종 확정은 반드시 인사기획팀 담당자가 실제 업무 수행 여부를 확인(listed_bonus_confirmed)해야 함 —
// 이 함수의 결과는 체크박스 초기값(제안)일 뿐, 자동 확정이 아님.

const KEYWORDS = ['재무', '회계', 'IR', '감사', '공시']

export function suggestListedBonusEligible(jobTitle) {
  if (!jobTitle) return false
  return KEYWORDS.some((k) => jobTitle.includes(k))
}
