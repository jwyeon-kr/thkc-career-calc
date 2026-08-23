// Anthropic API 호출 공용 유틸.
// 모델명을 여기 한 곳에서만 관리 (예전엔 extract.js/match-job.js/match-job-category.js/generate-report.js
// 4곳에 각각 하드코딩되어 있어 모델 교체 시 하나씩 찾아 고쳐야 했음).
// 또한 429(레이트리밋)/5xx 오류 시 짧게 재시도한다 — 실패하면 사람이 처음부터 다시 눌러야 했던 문제 완화.

export const ANTHROPIC_MODEL = 'claude-sonnet-5'

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// system/messages/max_tokens는 기존 각 api 파일이 쓰던 것과 동일한 형태 그대로 전달하면 됨.
// 반환값은 fetch의 Response 객체 그대로 (호출부에서 response.ok / response.json() 등 기존 방식 유지).
export async function callAnthropic({ system, messages, maxTokens, maxRetries = 1 }) {
  let lastResponse
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages }),
    })
    if (lastResponse.ok || !RETRYABLE_STATUS.has(lastResponse.status) || attempt === maxRetries) {
      return lastResponse
    }
    await sleep(500 * Math.pow(2, attempt)) // 500ms, 1000ms, ...
  }
  return lastResponse
}
