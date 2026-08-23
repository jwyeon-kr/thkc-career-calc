import { ASSET_TOTAL_LIMIT_WON } from './industryScaleTable'

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

// [2026-08-23 개편] 업종코드를 알 수 없을 때만 쓰는 간이 추정(기존 로직 그대로 유지).
// 업종코드가 있으면 determineScaleAuto()가 훨씬 정확한 판정을 함 — 아래는 fallback 전용.
export function mapRevenueToBracket(revenueWon) {
  if (revenueWon == null || isNaN(revenueWon)) return null
  if (revenueWon >= LARGE_ENTERPRISE_THRESHOLD) return '대기업'
  if (revenueWon >= MID_MARKET_THRESHOLD) return '중견'
  return '중소'
}

// 중소기업기본법 시행령 별표1(업종별 매출액 기준) + 자산총액 5,000억원 요건을 함께 판정.
// "중소기업 여부"까지만 자동 판정한다 — 중견/대기업 경계는 상호출자제한기업집단 등
// 공정거래위원회 지정 리스트에 소속됐는지 여부의 문제라 DART 데이터만으로는 알 수 없기 때문.
// (기존 "대기업 계열사" 체크박스로 담당자가 확인하는 구조는 그대로 유지)
//
// 반환값:
// - bracket: '중소' (기준 충족 시) 또는 null (기준 초과·업종 미확인 등으로 자동판정 불가)
// - reason: 화면에 보여줄 설명 문구
export function determineScaleAuto({ revenueWon, assetWon, industryMatch }) {
  if (!industryMatch) {
    return { bracket: null, reason: '업종코드를 확인하지 못해 자동판정 불가 (매출액만으로 간이 추정됨, 아래 참고)' }
  }
  const { thresholdWon, label } = industryMatch
  const revenueOk = revenueWon != null && !isNaN(revenueWon) && revenueWon <= thresholdWon
  const assetOk = assetWon == null || isNaN(assetWon) || assetWon < ASSET_TOTAL_LIMIT_WON

  if (revenueOk && assetOk) {
    return {
      bracket: '중소',
      reason: `${label} 기준 ${formatWonToEok(thresholdWon)}원 이하 충족 (매출 ${formatWonToEok(revenueWon)}원${assetWon != null ? `, 자산총액 ${formatWonToEok(assetWon)}원` : ''})`,
    }
  }
  const overWhat = [
    !revenueOk ? `매출액이 ${label} 기준 ${formatWonToEok(thresholdWon)}원 초과` : null,
    !assetOk ? `자산총액이 5,000억원 이상` : null,
  ].filter(Boolean).join(', ')
  return {
    bracket: null,
    reason: `중소기업 기준 초과 (${overWhat}) → 중견/대기업 여부는 상호출자제한기업집단 소속 등을 담당자가 직접 확인해주세요`,
  }
}

export function formatWonToEok(revenueWon) {
  if (revenueWon == null || isNaN(revenueWon)) return '-'
  return `${(revenueWon / EOK).toLocaleString('ko-KR', { maximumFractionDigits: 0 })}억`
}
