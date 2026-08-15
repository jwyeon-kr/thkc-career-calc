# 경력산출 자동화 시스템

인사기획팀 내부 전용. React + Supabase + Vercel.

## 배포 전 설정 (Vercel 환경변수)

Vercel 프로젝트 Settings → Environment Variables 에 아래 6개 등록:

| 이름 | 값 | 비고 |
|---|---|---|
| SUPABASE_URL | https://bybvsbatecktxbjzzrlg.supabase.co | 서버함수 전용 (VITE_ 접두어 없음) |
| SUPABASE_ANON_KEY | (Supabase 대시보드 → Settings → API Keys에서 확인) | 서버함수 전용 |
| ANTHROPIC_API_KEY | (Anthropic Console에서 발급한 API 키) | 서버함수 전용 |
| DART_API_KEY | (opendart.fss.or.kr에서 발급한 인증키) | 서버함수 전용 |

> **변경사항**: 이전 버전에서는 브라우저가 Supabase에 직접 접속했으나(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`), 특정 네트워크 환경에서 연결 실패가 반복되어 **모든 Supabase 접근을 서버함수(`/api/config`, `/api/applicants`) 경유로 변경**했습니다. 기존 `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` 환경변수는 더 이상 사용하지 않으므로 삭제하셔도 되고, 이름만 `SUPABASE_URL`/`SUPABASE_ANON_KEY`(VITE_ 접두어 제거)로 다시 등록하시면 됩니다. 값 자체는 동일합니다.

## 로컬 실행 (선택)

```
npm install
npm run dev
```

## 알려진 제한사항 (1차 범위)

- **매출액 자동조회(DART)**: 상장사 및 외부감사대상 비상장사만 조회됩니다. 조회 실패 시 자동으로 값을 추정하지 않고 "직접 입력 필요"로 안내합니다. 동명 회사가 여럿이면 후보 목록에서 직접 선택해야 합니다.
- **업종 참고정보**: 정확한 업종명 매핑 데이터가 없어 상장시장구분(코스피/코스닥/코넥스/비상장)·설립일만 참고정보로 제공합니다.
- **상장가산 대상 직무 자동제안**: 이력서 직무명 텍스트 키워드 기반 "제안"입니다. 최종 확정(실제 업무수행 여부 컨펌)은 반드시 담당자가 직접 체크해야 합니다.
- **직무매칭 자동제안**: 지원직무와 이력서 직무명을 AI가 비교해 동일/유사/기타를 제안하지만, 최종 판단은 담당자가 확인 후 수정해야 합니다.
- **DART corpCode 캐시**: 서버리스 함수가 warm 상태인 동안(약 12시간) 회사 목록을 메모리에 캐시합니다.
- RLS(행 단위 보안)는 미적용이지만, 브라우저가 Supabase에 직접 접근하지 않고 서버함수만 거치도록 구조를 변경하여 anon key 노출 리스크는 해소되었습니다.
