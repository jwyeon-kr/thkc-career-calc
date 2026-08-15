-- DART 회사목록 캐시 테이블 (전자공시시스템 공개 데이터: 회사명/DART코드/종목코드. 개인정보 아님)
create table dart_corp_codes (
  corp_code text primary key,
  corp_name text not null,
  stock_code text,
  updated_at timestamptz not null default now()
);

create index idx_dart_corp_name on dart_corp_codes (corp_name);
