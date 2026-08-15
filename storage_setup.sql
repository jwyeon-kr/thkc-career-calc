-- 이력서 파일 저장용 버킷 및 정책
-- Supabase 대시보드 → Storage → New bucket 에서 "resumes" 버킷을 먼저 만드신 뒤(Public 체크 해제),
-- 이 SQL을 SQL Editor에서 실행해주세요.

insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

-- 서버(anon key)가 업로드/다운로드할 수 있도록 정책 추가
-- (DB 테이블과 동일하게, 브라우저는 서명된 업로드 URL을 통해서만 접근하고
--  실제 읽기는 서버 함수에서만 이뤄지므로 이 정도 권한 부여는 안전합니다)
create policy "resumes_insert" on storage.objects for insert to anon with check (bucket_id = 'resumes');
create policy "resumes_select" on storage.objects for select to anon using (bucket_id = 'resumes');
create policy "resumes_delete" on storage.objects for delete to anon using (bucket_id = 'resumes');
