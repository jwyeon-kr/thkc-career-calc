// Vercel Serverless Function
// 이력서 파일을 브라우저가 우리 서버(Vercel)를 거치지 않고 Supabase Storage에
// 직접 업로드할 수 있도록, 1회용 서명된 업로드 URL을 발급한다.
// Vercel 서버 함수는 요청 본문 크기가 약 4.5MB로 고정 제한되어 있어(설정으로 변경 불가),
// 대용량 이력서 파일은 이 방식으로 우회해야 한다.

import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' })
  }
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim()
  const supabaseKey = (process.env.SUPABASE_ANON_KEY || '').trim()
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_ANON_KEY가 설정되어 있지 않습니다.' })
  }

  const { filename } = req.body || {}
  const ext = (filename && filename.includes('.')) ? filename.split('.').pop() : 'bin'
  const safeExt = /^[a-zA-Z0-9]{1,10}$/.test(ext) ? ext : 'bin'
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${safeExt}`

  try {
    const supabase = createClient(supabaseUrl, supabaseKey)
    const { data, error } = await supabase.storage.from('resumes').createSignedUploadUrl(path)
    if (error) return res.status(500).json({ error: '업로드 URL 발급 실패: ' + error.message })

    return res.status(200).json({ path: data.path, token: data.token, signedUrl: data.signedUrl })
  } catch (err) {
    return res.status(500).json({ error: '업로드 URL 발급 중 오류: ' + err.message })
  }
}
