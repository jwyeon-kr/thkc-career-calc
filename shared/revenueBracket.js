// 매출액(원 단위) -> 기업규모 라벨 매핑
// [2026-08-15 개편] 기존 5단계(3000억이상/3000억미만/당사미만/+500억/50억미만) 폐기,
// 중소/중견/대기업 3단계로 전환.
//
// ⚠️ 중요: 이 기준선은 법적으로 정확한 판정 기준이 아닌 실무적 근사치입니다.
// 한국의 공식 기업규모 구분(중소기업기본법/중견기업특별법)은 매출액뿐 아니라
// 업종별로 상이한 기준매출액(400억~1,800억, 업종마다 다름), 자산총액, 상호출자제한기업집단
// 소속 여부(계열사 관계)까지 종합 판정하며, DART 매출조회만으로는 이를 완전히 재현할 수 없습니다.
// 대기업 계열사(매출 자체는 작지만 실질은 대기업)는 이 함수가 아니라
// 화면의 "대기업 계열사" 체크박스(담당자 확인)로 별도 처리됩니다.
const MID_MARKET_THRESHOLD = 150_000_000_000 // 1,500억원 (중소/중견 경계, 근사치)
const LARGE_ENTERPRISE_THRESHOLD = 1_000_000_000_000 // 1조원 (중견/대기업 경계, 근사치)
const EOK = 100_000_000 // 1억원

export function mapRevenueToBracket(revenueWon) {
  if (revenueWon == null || isNaN(revenueWon)) return null
  if (revenueWon >= LARGE_ENTERPRISE_THRESHOLD) return '대기업'
  if (revenueWon >= MID_MARKET_THRESHOLD) return '중견'
  return '중소'
}

export function formatWonToEok(revenueWon) {
  if (revenueWon == null || isNaN(revenueWon)) return '-'
  return `${(revenueWon / EOK).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}억`
}
