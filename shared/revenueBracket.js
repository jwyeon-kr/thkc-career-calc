// 매출액(원 단위) -> 매출구간 라벨 매핑
// 기준 근거: 원본 엑셀(0_경력직_경력산출_v3_0.xlsx)의 매출액 구간 설명
//   100억미만(1~100억) / ~500억(100~500억) / 미만(500억~당사 미만) / 3,000억 미만(당사~3,000억 미만) / 3,000억 이상
// 당사(THKC) 매출 규모 기준선은 1,000억으로 가정 (job_revenue_matrix의 "당사미만" 라벨 근거)
// ⚠️ 이 기준선(1,000억)은 원본 엑셀에 명시적 수치로 기재되어 있지 않아, 텍스트 설명("당사")을 근거로 추정한 값입니다.
//    실제 당사 매출 규모와 다르면 THKC_REVENUE_THRESHOLD 값을 조정해야 합니다.

const THKC_REVENUE_THRESHOLD = 100_000_000_000 // 1,000억원 (추정치, 확인 필요)
const EOK = 100_000_000 // 1억원

export function mapRevenueToBracket(revenueWon) {
  if (revenueWon == null || isNaN(revenueWon)) return null
  if (revenueWon >= 300_000_000_000) return '3000억이상'
  if (revenueWon >= THKC_REVENUE_THRESHOLD) return '3000억미만'
  if (revenueWon >= 50_000_000_000) return '당사미만'
  if (revenueWon >= 10_000_000_000) return '+500억'
  return '50억미만'
}

export function formatWonToEok(revenueWon) {
  if (revenueWon == null || isNaN(revenueWon)) return '-'
  return `${(revenueWon / EOK).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}억`
}
